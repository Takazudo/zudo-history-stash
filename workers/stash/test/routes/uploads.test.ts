import { env } from "cloudflare:workers";
import { sha256Hex, type StashEvent } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const STASH = "single-upload";
const BASE = `http://stash.test/v1/stashes/${STASH}/uploads`;

function bindings(overrides: Partial<ReturnType<typeof createTestEnv>["env"]> = {}) {
  return { ...createTestEnv().env, ...overrides };
}

function jsonHeaders(key: string): HeadersInit {
  return { ...bearer("test-admin"), "Content-Type": "application/json", "Idempotency-Key": key };
}

async function create(
  body: Record<string, unknown>,
  key = "create-key",
  custom = bindings(),
  application = createApp(),
) {
  return request(
    application,
    `${BASE}/asset.bin`,
    { method: "POST", headers: jsonHeaders(key), body: JSON.stringify(body) },
    custom,
  );
}

async function raw(
  id: string,
  body: BodyInit,
  key = "upload-key",
  headers: HeadersInit = {},
  custom = bindings(),
  application = createApp(),
) {
  return request(
    application,
    `${BASE}/${id}/content`,
    {
      method: "PUT",
      headers: { ...bearer("test-admin"), "Idempotency-Key": key, ...headers },
      body,
    },
    custom,
  );
}

async function complete(
  id: string,
  key = "complete-key",
  custom = bindings(),
  application = createApp(),
) {
  return request(
    application,
    `${BASE}/${id}/complete`,
    { method: "POST", headers: jsonHeaders(key), body: JSON.stringify({ generation: 0 }) },
    custom,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("single raw upload lifecycle", () => {
  it("stages D1 bytes and atomically commits one byte-backed version with replay", async () => {
    const bytes = new TextEncoder().encode("hello 🌍");
    const hash = await sha256Hex(bytes);
    const created = await create({
      expectedVersion: null,
      size: bytes.byteLength,
      hash,
      representation: "text",
      contentType: "text/plain; charset=utf-8",
      mode: "single",
      resumable: false,
    });
    expect(created.status).toBe(201);
    const session = await created.json<{ id: string; storageTier: string }>();
    expect(session.storageTier).toBe("d1");

    const uploaded = await raw(session.id, bytes, "upload-key", {
      "Content-Length": String(bytes.byteLength),
    });
    expect(uploaded.status).toBe(202);
    await expect(uploaded.json()).resolves.toMatchObject({ state: "uploaded", uploadedHash: hash });

    const committed = await complete(session.id);
    expect(committed.status).toBe(201);
    const value = await committed.json<{ version: number; hash: string; changeId: number }>();
    expect(value).toMatchObject({ version: 1, hash });
    expect(value.changeId).toBeGreaterThan(0);
    const downloaded = await request(
      createApp(),
      `http://stash.test/v1/stashes/${STASH}/raw/asset.bin`,
      { headers: bearer("test-admin") },
      bindings(),
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const replay = await complete(session.id);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual(value);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_staged_bytes").first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT body_bytes, size_bytes FROM byte_blobs WHERE stash_name = ? AND hash = ?",
      )
        .bind(STASH, hash)
        .first<{ body_bytes: ArrayBuffer; size_bytes: number }>(),
    ).resolves.toMatchObject({ size_bytes: bytes.byteLength });
  });

  it("streams R2 bytes without the global JSON limit and promotes the immutable pointer", async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3]);
    const custom = bindings({ D1_INLINE_MAX_BYTES: "2" });
    const created = await create(
      {
        expectedVersion: null,
        size: bytes.byteLength,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-r2",
      custom,
    );
    const session = await created.json<{ id: string; storageTier: string }>();
    expect(session.storageTier).toBe("r2");
    expect((await raw(session.id, bytes, "upload-r2", {}, custom)).status).toBe(202);
    expect((await complete(session.id, "complete-r2", custom)).status).toBe(201);
    const blob = await env.DB.prepare(
      "SELECT r2_key, body_bytes FROM byte_blobs WHERE stash_name = ?",
    )
      .bind(STASH)
      .first<{ r2_key: string; body_bytes: ArrayBuffer | null }>();
    expect(blob?.body_bytes).toBeNull();
    expect(blob?.r2_key).toMatch(/^uploads\//);
    await expect(custom.BLOBS.get(blob!.r2_key)).resolves.not.toBeNull();
    const downloaded = await request(
      createApp(),
      `http://stash.test/v1/stashes/${STASH}/raw/asset.bin`,
      { headers: bearer("test-admin") },
      custom,
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  it("validates split UTF-8 fatally while arbitrary binary bytes succeed", async () => {
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2]));
        controller.enqueue(new Uint8Array([0x82, 0xac]));
        controller.close();
      },
    });
    const text = await create(
      {
        expectedVersion: null,
        size: 3,
        representation: "text",
        contentType: "text/plain",
        mode: "single",
        resumable: false,
      },
      "create-text",
    );
    const textId = (await text.json<{ id: string }>()).id;
    expect((await raw(textId, split, "upload-text")).status).toBe(202);

    const invalid = new Uint8Array([0xc3, 0x28]);
    const invalidText = await create(
      {
        expectedVersion: null,
        size: 2,
        representation: "text",
        contentType: "text/plain",
        mode: "single",
        resumable: false,
      },
      "create-invalid",
    );
    const invalidId = (await invalidText.json<{ id: string }>()).id;
    const rejected = await raw(invalidId, invalid, "upload-invalid");
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "body-not-well-formed" },
    });

    const binary = await create(
      {
        expectedVersion: null,
        size: 2,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-binary",
    );
    const binaryId = (await binary.json<{ id: string }>()).id;
    expect((await raw(binaryId, invalid, "upload-binary")).status).toBe(202);
  });

  it("counts missing or false Content-Length and rejects declared mismatches", async () => {
    const exact = await create(
      {
        expectedVersion: null,
        size: 4,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-missing-length",
    );
    const exactId = (await exact.json<{ id: string }>()).id;
    expect((await raw(exactId, new Uint8Array([1, 2, 3, 4]), "upload-missing-length")).status).toBe(
      202,
    );

    const created = await create({
      expectedVersion: null,
      size: 4,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "single",
      resumable: false,
    });
    const id = (await created.json<{ id: string }>()).id;
    expect(
      (await raw(id, new Uint8Array([1, 2, 3]), "upload-short", { "Content-Length": "false" }))
        .status,
    ).toBe(422);
    await expect(
      env.DB.prepare("SELECT state, error_code FROM upload_sessions WHERE id = ?").bind(id).first(),
    ).resolves.toEqual({ state: "failed", error_code: "upload-size-mismatch" });

    for (const [label, length] of [
      ["small", "3"],
      ["large", "5"],
    ] as const) {
      const candidate = await create(
        {
          expectedVersion: null,
          size: 4,
          representation: "binary",
          contentType: "application/octet-stream",
          mode: "single",
          resumable: false,
        },
        `create-length-${label}`,
      );
      const candidateId = (await candidate.json<{ id: string }>()).id;
      expect(
        (
          await raw(candidateId, new Uint8Array([1, 2, 3, 4]), `upload-length-${label}`, {
            "Content-Length": length,
          })
        ).status,
      ).toBe(422);
    }
  });

  it("makes client hash mismatch terminal and permits no staged/history pointer", async () => {
    const created = await create({
      expectedVersion: null,
      size: 2,
      hash: `sha256-${"0".repeat(64)}`,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "single",
      resumable: false,
    });
    const id = (await created.json<{ id: string }>()).id;
    const response = await raw(id, new Uint8Array([1, 2]));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upload-hash-mismatch" },
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM byte_blobs").first(),
    ).resolves.toEqual({
      count: 0,
    });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      {
        count: 0,
      },
    );
  });

  it("makes abort and completion terminal and generation fenced", async () => {
    const created = await create({
      expectedVersion: null,
      size: 1,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "single",
      resumable: false,
    });
    const id = (await created.json<{ id: string }>()).id;
    const aborted = await request(
      createApp(),
      `${BASE}/${id}`,
      { method: "DELETE", headers: jsonHeaders("abort"), body: JSON.stringify({ generation: 0 }) },
      bindings(),
    );
    expect(aborted.status).toBe(200);
    expect((await complete(id)).status).toBe(422);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 0 },
    );
  });

  it("skips only when hash, representation, and content type are all unchanged", async () => {
    const bytes = new TextEncoder().encode("same");
    const first = await create(
      {
        expectedVersion: null,
        size: 4,
        representation: "text",
        contentType: "text/plain",
        mode: "single",
        resumable: false,
      },
      "create-first",
    );
    const firstId = (await first.json<{ id: string }>()).id;
    await raw(firstId, bytes, "upload-first");
    await complete(firstId, "complete-first");

    const skipped = await create(
      {
        expectedVersion: 1,
        size: 4,
        representation: "text",
        contentType: "text/plain",
        mode: "single",
        resumable: false,
        skipIfUnchanged: true,
      },
      "create-skip",
    );
    const skippedId = (await skipped.json<{ id: string }>()).id;
    await raw(skippedId, bytes, "upload-skip");
    const unchanged = await complete(skippedId, "complete-skip");
    expect(unchanged.status).toBe(200);
    await expect(unchanged.json()).resolves.toMatchObject({ unchanged: true, version: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );

    const metadata = await create(
      {
        expectedVersion: 1,
        size: 4,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
        skipIfUnchanged: true,
      },
      "create-metadata",
    );
    const metadataId = (await metadata.json<{ id: string }>()).id;
    await raw(metadataId, bytes, "upload-metadata");
    expect((await complete(metadataId, "complete-metadata")).status).toBe(201);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 2 },
    );
  });

  it("records stale CAS as a replayable terminal result without byte/history mutation", async () => {
    const initial = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-initial",
    );
    const initialId = (await initial.json<{ id: string }>()).id;
    await raw(initialId, new Uint8Array([1]), "upload-initial");
    await complete(initialId, "complete-initial");

    const stale = await create(
      {
        expectedVersion: 1,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-stale",
    );
    const staleId = (await stale.json<{ id: string }>()).id;
    await raw(staleId, new Uint8Array([2]), "upload-stale");
    await env.DB.prepare("UPDATE files SET head_version = 99 WHERE stash_name = ? AND path = ?")
      .bind(STASH, "asset.bin")
      .run();
    const response = await complete(staleId, "complete-stale");
    expect(response.status).toBe(409);
    expect((await complete(staleId, "complete-stale")).headers.get("Idempotent-Replayed")).toBe(
      "true",
    );
    await expect(
      env.DB.prepare("SELECT state FROM upload_sessions WHERE id = ?").bind(staleId).first(),
    ).resolves.toEqual({ state: "stale" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
  });

  it("recovers response gaps after staging and after commit and publishes once", async () => {
    let stageFault = true;
    let commitFault = true;
    let eventFault = true;
    const application = createApp({
      uploadHooks: {
        afterStage() {
          if (stageFault) {
            stageFault = false;
            throw new Error("after stage");
          }
        },
        afterCommit() {
          if (commitFault) {
            commitFault = false;
            throw new Error("after commit");
          }
        },
      },
    });
    const events: StashEvent[] = [];
    const base = bindings();
    const namespace = new Proxy(base.STASH_EVENTS, {
      get(target, property, receiver) {
        if (property !== "getByName") return Reflect.get(target, property, receiver);
        return () => ({
          fetch: async (input: Request) => {
            if (eventFault) {
              eventFault = false;
              throw new Error("event delivery");
            }
            events.push((await input.json()) as StashEvent);
            return new Response(null, { status: 204 });
          },
        });
      },
    });
    const custom = { ...base, STASH_EVENTS: namespace };
    const created = await create(
      {
        expectedVersion: null,
        size: 2,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-fault",
      custom,
      application,
    );
    const id = (await created.json<{ id: string }>()).id;
    expect(
      (await raw(id, new Uint8Array([1, 2]), "upload-fault", {}, custom, application)).status,
    ).toBe(500);
    const uploadReplay = await raw(
      id,
      new Uint8Array([9, 9]),
      "upload-fault",
      {},
      custom,
      application,
    );
    expect(uploadReplay.status).toBe(202);
    expect(uploadReplay.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await complete(id, "complete-fault", custom, application)).status).toBe(500);
    expect(events).toHaveLength(0);
    expect((await complete(id, "complete-fault", custom, application)).status).toBe(500);
    await expect(
      env.DB.prepare(
        "SELECT event_published_at, event_publish_owner FROM upload_sessions WHERE id = ?",
      )
        .bind(id)
        .first(),
    ).resolves.toEqual({ event_published_at: null, event_publish_owner: null });
    const recovered = await complete(id, "complete-fault", custom, application);
    expect(recovered.status).toBe(201);
    expect(recovered.headers.get("Idempotent-Replayed")).toBe("true");
    expect(events).toHaveLength(1);
    await complete(id, "complete-fault", custom, application);
    expect(events).toHaveLength(1);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
  });

  it("fails finalization without a stale result when durable R2 staging disappears", async () => {
    const custom = bindings({ D1_INLINE_MAX_BYTES: "1" });
    const created = await create(
      {
        expectedVersion: null,
        size: 2,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-missing-stage",
      custom,
    );
    const id = (await created.json<{ id: string }>()).id;
    await raw(id, new Uint8Array([1, 2]), "upload-missing-stage", {}, custom);
    const session = await env.DB.prepare("SELECT staged_r2_key FROM upload_sessions WHERE id = ?")
      .bind(id)
      .first<{ staged_r2_key: string }>();
    await custom.BLOBS.delete(session!.staged_r2_key);
    expect((await complete(id, "complete-missing-stage", custom)).status).toBe(500);
    await expect(
      env.DB.prepare("SELECT state, error_code FROM upload_sessions WHERE id = ?").bind(id).first(),
    ).resolves.toEqual({ state: "failed", error_code: "staging-unavailable" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      {
        count: 0,
      },
    );
  });

  it("selects multipart for resumable auto sessions and rejects resumable single mode", async () => {
    const automatic = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "auto",
        resumable: true,
      },
      "create-resumable-auto",
    );
    expect(automatic.status).toBe(201);
    await expect(automatic.json()).resolves.toMatchObject({ mode: "multipart" });
    const single = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: true,
      },
      "create-resumable-single",
    );
    expect(single.status).toBe(400);
    await expect(single.json()).resolves.toMatchObject({ error: { code: "validation" } });
  });

  it("takes over an expired finalization lease but fences an early retry", async () => {
    let now = 1_800_000_000_000;
    let fault = true;
    const application = createApp({
      now: () => now,
      uploadLeaseMs: 10,
      uploadHooks: {
        duringFinalizing() {
          if (fault) {
            fault = false;
            throw new Error("during finalizing");
          }
        },
      },
    });
    const custom = bindings();
    const created = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-lease",
      custom,
      application,
    );
    const id = (await created.json<{ id: string }>()).id;
    await raw(id, new Uint8Array([1]), "upload-lease", {}, custom, application);
    expect((await complete(id, "complete-lease", custom, application)).status).toBe(500);
    expect((await complete(id, "complete-lease", custom, application)).status).toBe(409);
    now += 11;
    expect((await complete(id, "complete-lease", custom, application)).status).toBe(201);
  });

  it("returns current state for open resume and finalizes durable uploaded staging", async () => {
    const custom = bindings();
    const application = createApp();
    const created = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-resume",
      custom,
      application,
    );
    const id = (await created.json<{ id: string }>()).id;
    const resumeRequest = () =>
      request(
        application,
        `${BASE}/${id}/resume`,
        {
          method: "POST",
          headers: jsonHeaders("resume-key"),
          body: JSON.stringify({ generation: 0 }),
        },
        custom,
      );
    const open = await resumeRequest();
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toMatchObject({ state: "open" });
    await raw(id, new Uint8Array([7]), "upload-resume", {}, custom, application);
    const committed = await resumeRequest();
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toMatchObject({
      state: "committed",
      result: { version: 1 },
    });
  });

  it("gives complete versus abort exactly one terminal winner", async () => {
    const custom = bindings();
    const application = createApp();
    const created = await create(
      {
        expectedVersion: null,
        size: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "single",
        resumable: false,
      },
      "create-race",
      custom,
      application,
    );
    const id = (await created.json<{ id: string }>()).id;
    await raw(id, new Uint8Array([1]), "upload-race", {}, custom, application);
    const [completion, abortion] = await Promise.all([
      complete(id, "complete-race", custom, application),
      request(
        application,
        `${BASE}/${id}`,
        {
          method: "DELETE",
          headers: jsonHeaders("abort-race"),
          body: JSON.stringify({ generation: 0 }),
        },
        custom,
      ),
    ]);
    const row = await env.DB.prepare("SELECT state FROM upload_sessions WHERE id = ?")
      .bind(id)
      .first<{ state: string }>();
    expect(["committed", "aborted"]).toContain(row?.state);
    expect(
      [completion.status, abortion.status].filter((status) => status === 200 || status === 201),
    ).toHaveLength(1);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      {
        count: row?.state === "committed" ? 1 : 0,
      },
    );
  });
});
