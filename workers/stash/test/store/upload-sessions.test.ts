import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1UploadSessionStore } from "../../src/d1/upload-sessions.js";
import { resetDatabase } from "../helpers/app.js";

async function seedSession(id: string, state: "open" | "uploaded" = "open"): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO stashes (name, description, meta_json, created_at) VALUES ('uploads', '', '{}', 1)",
  ).run();
  await env.DB.prepare(
    `INSERT INTO upload_sessions
       (id, stash_name, path, principal_kind, declared_size, representation, content_type,
        upload_mode, storage_tier, state, expires_at, create_fingerprint, created_at, updated_at)
     VALUES (?, 'uploads', 'asset.bin', 'admin', 4, 'binary', 'application/octet-stream',
       'single', 'd1', ?, 100000, ?, 1, 1)`,
  )
    .bind(id, state, `create-${id}`)
    .run();
}

describe("D1 upload session transition store", () => {
  beforeEach(resetDatabase);

  it("rejects stale generations and late part writes after a terminal transition", async () => {
    await seedSession("upl_parts");
    const store = new D1UploadSessionStore(env.DB);
    await expect(
      store.recordPart({
        session_id: "upl_parts",
        generation: 1,
        part_number: 1,
        size_bytes: 4,
        r2_etag: "etag-stale",
        now: 2,
      }),
    ).resolves.toBe(false);
    await expect(
      store.recordPart({
        session_id: "upl_parts",
        generation: 0,
        part_number: 1,
        size_bytes: 4,
        r2_etag: "etag-live",
        now: 2,
      }),
    ).resolves.toBe(true);
    await env.DB.prepare(
      "UPDATE upload_sessions SET state = 'aborted' WHERE id = 'upl_parts'",
    ).run();
    await expect(
      store.recordPart({
        session_id: "upl_parts",
        generation: 0,
        part_number: 2,
        size_bytes: 4,
        r2_etag: "etag-late",
        now: 3,
      }),
    ).resolves.toBe(false);
    await expect(
      env.DB.prepare(
        "SELECT part_number, r2_etag FROM upload_parts WHERE session_id = 'upl_parts' ORDER BY part_number",
      ).all(),
    ).resolves.toMatchObject({ results: [{ part_number: 1, r2_etag: "etag-live" }] });
  });

  it("requires exactly finalizing sessions to carry a complete lease", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO stashes (name, description, meta_json, created_at) VALUES ('uploads', '', '{}', 1)",
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO upload_sessions
         (id, stash_name, path, principal_kind, declared_size, representation, content_type,
          upload_mode, storage_tier, state, expires_at, create_fingerprint, created_at, updated_at)
       VALUES ('upl_bad_lease', 'uploads', 'bad', 'admin', 1, 'binary',
         'application/octet-stream', 'single', 'd1', 'finalizing', 10, 'bad-lease', 1, 1)`,
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO upload_sessions
         (id, stash_name, path, principal_kind, declared_size, representation, content_type,
          upload_mode, storage_tier, state, expires_at, create_fingerprint,
          finalization_lease_owner, finalization_lease_until, created_at, updated_at)
       VALUES ('upl_bad_open_lease', 'uploads', 'bad2', 'admin', 1, 'binary',
         'application/octet-stream', 'single', 'd1', 'open', 10, 'bad-open-lease',
         'owner', 20, 1, 1)`,
      ).run(),
    ).rejects.toThrow();
  });

  it("fences finalization takeover until lease expiry", async () => {
    await seedSession("upl_lease", "uploaded");
    const store = new D1UploadSessionStore(env.DB);
    const first = await store.acquireFinalizationLease({
      sessionId: "upl_lease",
      generation: 0,
      owner: "owner-a",
      now: 10,
      leaseUntil: 20,
    });
    expect(first).not.toBeNull();
    await expect(
      store.acquireFinalizationLease({
        sessionId: "upl_lease",
        generation: 0,
        owner: "owner-b",
        now: 19,
        leaseUntil: 30,
      }),
    ).resolves.toBeNull();
    const takeover = await store.acquireFinalizationLease({
      sessionId: "upl_lease",
      generation: 0,
      owner: "owner-b",
      now: 20,
      leaseUntil: 30,
    });
    expect(takeover).not.toBeNull();
    if (!first || !takeover) throw new Error("Expected both leases");
    await expect(
      store.finish({ lease: first, state: "failed", errorCode: "old", now: 21 }),
    ).resolves.toBe(false);
    await expect(
      store.finish({
        lease: takeover,
        state: "committed",
        resultStatus: 201,
        resultJson: '{"version":1}',
        now: 21,
      }),
    ).resolves.toBe(true);
    await expect(store.get("upl_lease")).resolves.toMatchObject({
      state: "committed",
      result_status: 201,
      result_json: '{"version":1}',
      finalization_lease_owner: null,
      finalization_lease_until: null,
    });
  });

  it("renews an expired lease when its exact owner and expiry still match", async () => {
    await seedSession("upl_lease_catch_up", "uploaded");
    const store = new D1UploadSessionStore(env.DB);
    const lease = await store.acquireFinalizationLease({
      sessionId: "upl_lease_catch_up",
      generation: 0,
      owner: "owner-a",
      now: 10,
      leaseUntil: 20,
    });
    if (!lease) throw new Error("Expected lease");

    await expect(store.renewFinalizationLease(lease, 25, 35)).resolves.toEqual({
      ...lease,
      expiresAt: 35,
    });
  });

  it("rejects renewal by an old owner after lease takeover", async () => {
    await seedSession("upl_lease_taken_over", "uploaded");
    const store = new D1UploadSessionStore(env.DB);
    const first = await store.acquireFinalizationLease({
      sessionId: "upl_lease_taken_over",
      generation: 0,
      owner: "owner-a",
      now: 10,
      leaseUntil: 20,
    });
    const takeover = await store.acquireFinalizationLease({
      sessionId: "upl_lease_taken_over",
      generation: 0,
      owner: "owner-b",
      now: 20,
      leaseUntil: 30,
    });
    if (!first || !takeover) throw new Error("Expected both leases");

    await expect(store.renewFinalizationLease(first, 21, 31)).resolves.toBeNull();
    await expect(store.get("upl_lease_taken_over")).resolves.toMatchObject({
      finalization_lease_owner: "owner-b",
      finalization_lease_until: 30,
    });
  });

  it("rejects a stale same-owner lease after its expiry was renewed", async () => {
    await seedSession("upl_lease_stale_expiry", "uploaded");
    const store = new D1UploadSessionStore(env.DB);
    const first = await store.acquireFinalizationLease({
      sessionId: "upl_lease_stale_expiry",
      generation: 0,
      owner: "owner-a",
      now: 10,
      leaseUntil: 20,
    });
    if (!first) throw new Error("Expected lease");
    const renewed = await store.renewFinalizationLease(first, 15, 30);
    if (!renewed) throw new Error("Expected renewal");

    await expect(store.renewFinalizationLease(first, 16, 40)).resolves.toBeNull();
    await expect(store.get("upl_lease_stale_expiry")).resolves.toMatchObject({
      finalization_lease_owner: "owner-a",
      finalization_lease_until: 30,
    });
  });

  it("rejects expired lease acquisition and completion", async () => {
    await seedSession("upl_expired_lease", "uploaded");
    const store = new D1UploadSessionStore(env.DB);
    await expect(
      store.acquireFinalizationLease({
        sessionId: "upl_expired_lease",
        generation: 0,
        owner: "owner-a",
        now: 10,
        leaseUntil: 10,
      }),
    ).rejects.toThrow("after acquisition");
    const lease = await store.acquireFinalizationLease({
      sessionId: "upl_expired_lease",
      generation: 0,
      owner: "owner-a",
      now: 10,
      leaseUntil: 20,
    });
    if (!lease) throw new Error("Expected lease");
    await expect(
      store.finish({ lease, state: "failed", errorCode: "late", now: 20 }),
    ).resolves.toBe(false);
    await expect(store.get("upl_expired_lease")).resolves.toMatchObject({
      state: "finalizing",
      finalization_lease_owner: "owner-a",
      finalization_lease_until: 20,
    });
  });
});
