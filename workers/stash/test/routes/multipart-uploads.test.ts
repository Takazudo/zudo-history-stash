import { env } from "cloudflare:workers";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import {
  createTestEnv,
  withSyntheticMultipart,
  type MultipartBucketStats,
} from "../helpers/env.js";
import type { Env } from "../../src/env.js";
import { GC_ORPHAN_MIN_AGE_MS, createGcEngine } from "../../src/gc.js";

const STASH = "multipart-upload";
const BASE = `http://stash.test/v1/stashes/${STASH}/uploads`;
const policy = {
  jsonInlineMaxBytes: 1,
  d1InlineMaxBytes: 1,
  httpRequestMaxBytes: 3,
  singleUploadMaxBytes: 2,
  maxFileBytes: 12,
  multipartPartBytes: 3,
  maxReservedUploadBytes: 24,
};

let runtimeEnv: Env;
let multipartStats: MultipartBucketStats;

function bindings() {
  return runtimeEnv;
}

function headers(key: string): HeadersInit {
  return { ...bearer("test-admin"), "Content-Type": "application/json", "Idempotency-Key": key };
}

async function createMultipart(
  bytes: Uint8Array,
  options: {
    representation?: "text" | "binary";
    hash?: string;
    expectedVersion?: number | null;
    skipIfUnchanged?: boolean;
    idempotencyKey?: string;
  } = {},
  application = createApp({ binarySettingOverrides: policy }),
) {
  const response = await request(
    application,
    `${BASE}/asset.bin`,
    {
      method: "POST",
      headers: headers(options.idempotencyKey ?? "create-multipart"),
      body: JSON.stringify({
        expectedVersion: options.expectedVersion ?? null,
        size: bytes.byteLength,
        ...(options.hash === undefined ? {} : { hash: options.hash }),
        representation: options.representation ?? "binary",
        contentType: "application/octet-stream",
        mode: "multipart",
        resumable: true,
        ...(options.skipIfUnchanged ? { skipIfUnchanged: true } : {}),
      }),
    },
    bindings(),
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; partSize: number; storageTier: string }>();
}

async function putPart(
  application: ReturnType<typeof createApp>,
  id: string,
  number: number,
  bytes: Uint8Array,
) {
  return request(
    application,
    `${BASE}/${id}/parts/${number}?generation=0`,
    {
      method: "PUT",
      headers: { ...bearer("test-admin"), "Content-Length": String(bytes.byteLength) },
      body: bytes as BodyInit,
    },
    bindings(),
  );
}

async function finish(application: ReturnType<typeof createApp>, id: string) {
  return request(
    application,
    `${BASE}/${id}/complete`,
    {
      method: "POST",
      headers: headers("complete-multipart"),
      body: JSON.stringify({ generation: 0 }),
    },
    bindings(),
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
  multipartStats = { creates: 0, completes: 0, aborts: 0 };
  runtimeEnv = withSyntheticMultipart(createTestEnv().env, multipartStats);
});

describe("multipart raw upload lifecycle", () => {
  it("records out-of-order and parallel parts, replaces a part, and commits recorded ETags", async () => {
    const application = createApp({ binarySettingOverrides: policy });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const session = await createMultipart(bytes, {}, application);
    expect(session).toMatchObject({ partSize: 3, storageTier: "r2" });

    const [third, first] = await Promise.all([
      putPart(application, session.id, 3, bytes.slice(6)),
      putPart(application, session.id, 1, new Uint8Array([9, 9, 9])),
    ]);
    expect([third.status, first.status]).toEqual([202, 202]);
    expect((await putPart(application, session.id, 1, bytes.slice(0, 3))).status).toBe(202);
    expect((await putPart(application, session.id, 2, bytes.slice(3, 6))).status).toBe(202);

    const committed = await finish(application, session.id);
    expect(committed.status).toBe(201);
    await expect(committed.json()).resolves.toMatchObject({
      version: 1,
      hash: await sha256Hex(bytes),
      size: bytes.byteLength,
    });
    const raw = await request(
      application,
      `http://stash.test/v1/stashes/${STASH}/raw/asset.bin`,
      { headers: bearer("test-admin") },
      bindings(),
    );
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
    expect((await finish(application, session.id)).headers.get("Idempotent-Replayed")).toBe("true");
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
  });

  it("enforces exact intermediate/final sizes and rejects completion with missing parts", async () => {
    const application = createApp({ binarySettingOverrides: policy });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const session = await createMultipart(bytes, {}, application);
    expect((await putPart(application, session.id, 1, bytes.slice(0, 2))).status).toBe(422);
    expect((await putPart(application, session.id, 2, bytes.slice(3))).status).toBe(202);
    expect((await finish(application, session.id)).status).toBe(422);
    expect((await putPart(application, session.id, 1, bytes.slice(0, 3))).status).toBe(202);
    expect((await finish(application, session.id)).status).toBe(201);
  });

  it("validates UTF-8 across assembled part boundaries and rejects a wrong declared hash", async () => {
    const application = createApp({ binarySettingOverrides: policy });
    const splitEuro = new Uint8Array([0x61, 0x62, 0xe2, 0x82, 0xac]);
    const text = await createMultipart(splitEuro, { representation: "text" }, application);
    await putPart(application, text.id, 1, splitEuro.slice(0, 3));
    await putPart(application, text.id, 2, splitEuro.slice(3));
    expect((await finish(application, text.id)).status).toBe(201);

    await resetDatabase();
    await seedStash(STASH);
    const wrong = await createMultipart(
      new Uint8Array([1, 2, 3]),
      { hash: `sha256-${"0".repeat(64)}` },
      application,
    );
    await putPart(application, wrong.id, 1, new Uint8Array([1, 2, 3]));
    const rejected = await finish(application, wrong.id);
    expect(rejected.status).toBe(422);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 0 },
    );
  });

  it("recovers the R2-complete/D1 gap after lease takeover without a second commit", async () => {
    let now = 1_900_000_000_000;
    let crash = true;
    const application = createApp({
      now: () => now,
      uploadLeaseMs: 10,
      binarySettingOverrides: policy,
      uploadHooks: {
        afterMultipartComplete() {
          if (crash) {
            crash = false;
            throw new Error("crash after R2 completion");
          }
        },
      },
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const session = await createMultipart(bytes, {}, application);
    await putPart(application, session.id, 1, bytes.slice(0, 3));
    await putPart(application, session.id, 2, bytes.slice(3));
    expect((await finish(application, session.id)).status).toBe(500);
    expect((await finish(application, session.id)).status).toBe(409);
    now += 11;
    expect((await finish(application, session.id)).status).toBe(201);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
  });

  it("heartbeats while multipart completion and full verification each outlast the lease", async () => {
    const uploadLeaseMs = 100;
    let delayBody = true;
    runtimeEnv = withSyntheticMultipart(createTestEnv().env, multipartStats, {
      beforeComplete: () => new Promise((resolve) => setTimeout(resolve, uploadLeaseMs * 2.5)),
      beforeBodyRead: async () => {
        if (!delayBody) return;
        delayBody = false;
        await new Promise((resolve) => setTimeout(resolve, uploadLeaseMs * 2.5));
      },
    });
    const application = createApp({
      uploadLeaseMs,
      binarySettingOverrides: policy,
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const session = await createMultipart(bytes, {}, application);
    await putPart(application, session.id, 1, bytes.slice(0, 3));
    await putPart(application, session.id, 2, bytes.slice(3));

    const startedAt = Date.now();
    expect((await finish(application, session.id)).status).toBe(201);
    expect(Date.now() - startedAt).toBeGreaterThan(uploadLeaseMs * 4);
    await expect(
      env.DB.prepare("SELECT state, finalization_lease_owner FROM upload_sessions WHERE id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ state: "committed", finalization_lease_owner: null });
  });

  it("replaces an unrecorded R2 part after the first response path is lost", async () => {
    let lose = true;
    const application = createApp({
      binarySettingOverrides: policy,
      uploadHooks: {
        afterMultipartPart() {
          if (lose) {
            lose = false;
            throw new Error("lost before durable part record");
          }
        },
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const session = await createMultipart(bytes, {}, application);
    expect((await putPart(application, session.id, 1, bytes)).status).toBe(500);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
    expect((await putPart(application, session.id, 1, bytes)).status).toBe(202);
    expect((await finish(application, session.id)).status).toBe(201);
  });

  it("actively aborts incomplete multipart state and fences late parts", async () => {
    const application = createApp({ binarySettingOverrides: policy });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const session = await createMultipart(bytes, {}, application);
    await putPart(application, session.id, 1, bytes.slice(0, 3));
    const aborted = await request(
      application,
      `${BASE}/${session.id}`,
      {
        method: "DELETE",
        headers: headers("abort-multipart"),
        body: JSON.stringify({ generation: 0 }),
      },
      bindings(),
    );
    expect(aborted.status).toBe(200);
    expect((await putPart(application, session.id, 2, bytes.slice(3))).status).toBe(409);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_objects WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
    expect(multipartStats.aborts).toBe(1);
  });

  it("reclaims an expired part-write lease before aborting the session", async () => {
    let now = 1_900_000_000_000;
    const application = createApp({
      now: () => now,
      uploadLeaseMs: 10,
      binarySettingOverrides: policy,
    });
    const session = await createMultipart(new Uint8Array([1, 2, 3]), {}, application);
    await env.DB.prepare(
      `INSERT INTO upload_part_writes
         (session_id, generation, part_number, owner, started_at)
       VALUES (?, 0, 1, 'lost-writer', ?)`,
    )
      .bind(session.id, now)
      .run();
    const abort = () =>
      request(
        application,
        `${BASE}/${session.id}`,
        {
          method: "DELETE",
          headers: headers("abort-stale-part-writer"),
          body: JSON.stringify({ generation: 0 }),
        },
        bindings(),
      );

    expect((await abort()).status).toBe(409);
    now += 11;
    expect((await abort()).status).toBe(200);
    await expect(
      env.DB.prepare("SELECT state FROM upload_sessions WHERE id = ?").bind(session.id).first(),
    ).resolves.toEqual({ state: "aborted" });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_part_writes WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("keeps failed abort cleanup durable so an idempotent retry can finish it", async () => {
    multipartStats.abortFailuresRemaining = 1;
    const application = createApp({ binarySettingOverrides: policy });
    const session = await createMultipart(new Uint8Array([1, 2, 3]), {}, application);
    const abort = () =>
      request(
        application,
        `${BASE}/${session.id}`,
        {
          method: "DELETE",
          headers: headers("abort-retry"),
          body: JSON.stringify({ generation: 0 }),
        },
        bindings(),
      );
    expect((await abort()).status).toBe(500);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_objects WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 1 });
    expect((await abort()).status).toBe(200);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_objects WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
    expect(multipartStats.aborts).toBe(1);
  });

  it("actively aborts expired multipart resources during normal GC cleanup", async () => {
    const startedAt = 2_000_000_000_000;
    const application = createApp({ now: () => startedAt, binarySettingOverrides: policy });
    const session = await createMultipart(new Uint8Array([1, 2, 3]), {}, application);
    const gc = createGcEngine(runtimeEnv, { now: () => startedAt + 86_400_001 });
    await gc.run({ kind: "ledger", dryRun: false, maxObjects: 100 });
    await expect(
      env.DB.prepare("SELECT state FROM upload_sessions WHERE id = ?").bind(session.id).first(),
    ).resolves.toEqual({ state: "expired" });
    expect(multipartStats.aborts).toBe(1);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_objects WHERE session_id = ?")
        .bind(session.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("retires unchanged multipart R2 staging for orphan collection", async () => {
    const application = createApp({ binarySettingOverrides: policy });
    const bytes = new Uint8Array([7, 6, 5, 4]);
    const first = await createMultipart(
      bytes,
      { idempotencyKey: "create-multipart-first" },
      application,
    );
    await putPart(application, first.id, 1, bytes.slice(0, 3));
    await putPart(application, first.id, 2, bytes.slice(3));
    expect((await finish(application, first.id)).status).toBe(201);

    const unchanged = await createMultipart(
      bytes,
      {
        expectedVersion: 1,
        skipIfUnchanged: true,
        idempotencyKey: "create-multipart-unchanged",
      },
      application,
    );
    await putPart(application, unchanged.id, 1, bytes.slice(0, 3));
    await putPart(application, unchanged.id, 2, bytes.slice(3));
    const staged = await env.DB.prepare("SELECT staged_r2_key FROM upload_sessions WHERE id = ?")
      .bind(unchanged.id)
      .first<{ staged_r2_key: string }>();
    expect((await finish(application, unchanged.id)).status).toBe(200);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_objects WHERE session_id = ?")
        .bind(unchanged.id)
        .first(),
    ).resolves.toEqual({ count: 0 });

    const orphan = await runtimeEnv.BLOBS.head(staged!.staged_r2_key);
    expect(orphan).not.toBeNull();
    const gcNow = orphan!.uploaded.getTime() + GC_ORPHAN_MIN_AGE_MS + 1;
    await createGcEngine(runtimeEnv, { now: () => gcNow }).run({
      kind: "r2-orphans",
      dryRun: false,
      maxObjects: 24,
    });
    await expect(runtimeEnv.BLOBS.head(staged!.staged_r2_key)).resolves.toBeNull();
    await createGcEngine(runtimeEnv, { now: () => gcNow }).run({
      kind: "ledger",
      dryRun: false,
      maxObjects: 24,
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM upload_parts WHERE session_id = ?")
        .bind(unchanged.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("selects multipart at the 1 GiB settings ceiling without allocating the payload", async () => {
    const gib = 1_073_741_824;
    const application = createApp({
      binarySettingOverrides: {
        maxFileBytes: gib,
        maxReservedUploadBytes: gib,
        httpRequestMaxBytes: 32 * 1_024 * 1_024,
        multipartPartBytes: 131_072,
        singleUploadMaxBytes: 32 * 1_024 * 1_024,
      },
    });
    const response = await request(
      application,
      `${BASE}/large.txt`,
      {
        method: "POST",
        headers: headers("create-1gib-boundary"),
        body: JSON.stringify({
          expectedVersion: null,
          size: gib,
          representation: "text",
          contentType: "text/plain; charset=utf-8",
          mode: "auto",
          resumable: false,
        }),
      },
      bindings(),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      mode: "multipart",
      representation: "text",
      declaredSize: gib,
      partSize: 131_072,
    });
    expect(multipartStats.creates).toBe(1);
  });
});
