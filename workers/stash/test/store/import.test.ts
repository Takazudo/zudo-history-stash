import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  R2_SPILL_BYTES,
  sha256Hex,
  utf8ByteLength,
  type ImportBody,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../../src/env.js";
import { blobKey, parseBlobKey, type BlobGenerationFactory } from "../../src/d1/blobs.js";
import { createImport } from "../../src/d1/import.js";
import { importBatch, type PreparedImportVersion } from "../../src/d1/sql/import.js";
import { createWrites } from "../../src/d1/writes.js";
import { resetDatabase } from "../helpers/app.js";
import { wrapBlobs, type BlobCallCounts } from "../helpers/env.js";
import { generation, generationFactory } from "../helpers/blob-generations.js";

const workerEnv = env as Env;

async function seedStash(name: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, '', '{}', ?)",
  )
    .bind(name, 1_000)
    .run();
}

function importer(
  now = 10_000,
  bindings: Env = workerEnv,
  onBeforeCommit?: () => void | Promise<void>,
  createBlobGeneration?: BlobGenerationFactory,
) {
  let generationSequence = 0;
  return createImport(bindings, {
    now: () => now,
    createId: () => "unused",
    createBlobGeneration: createBlobGeneration ?? (() => generation((generationSequence += 1))),
    ...(onBeforeCommit ? { onBeforeCommit } : {}),
  });
}

function spilledBody(marker: string, fill: string): string {
  return `${marker}:${fill.repeat(R2_SPILL_BYTES + 1)}`;
}

async function counts(stash: string) {
  const result = { blobs: 0, versions: 0, files: 0, idempotency: 0 };
  for (const table of Object.keys(result) as (keyof typeof result)[]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
      .bind(stash)
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

function fiveVersions(): ImportBody["versions"] {
  return [
    {
      kind: "put",
      body: "one",
      author: "author-1",
      message: "message-1",
      meta: { sequence: 1, nested: { preserved: true } },
      createdAt: 1_001,
    },
    {
      kind: "put",
      body: "two",
      author: "author-2",
      message: "message-2",
      meta: { sequence: 2 },
      createdAt: 1_002,
    },
    {
      kind: "delete",
      body: null,
      author: "author-3",
      message: "message-3",
      createdAt: 1_003,
    },
    {
      kind: "put",
      body: "four",
      author: "author-4",
      message: "message-4",
      meta: { sequence: 4 },
      createdAt: 1_004,
    },
    {
      kind: "rollback",
      body: null,
      rollbackOf: 2,
      author: "author-5",
      message: "message-5",
      meta: { sequence: 5 },
      createdAt: 1_005,
    },
  ];
}

beforeEach(resetDatabase);

describe("history import store", () => {
  it("matches the live write sequence except row ids and preserves supplied fields", async () => {
    await seedStash("imported");
    await seedStash("written");
    const result = await importer().importFile("imported", {
      path: "history.txt",
      expectedVersion: null,
      versions: fiveVersions(),
    });
    expect(result).toMatchObject({
      ok: true,
      statusCode: 201,
      value: { path: "history.txt", headVersion: 5 },
    });

    const times = [1_001, 1_002, 1_003, 1_004, 1_005];
    const writes = createWrites(workerEnv, {
      now: () => times.shift() ?? 9_999,
      createId: () => "unused",
    });
    await writes.put("written", "history.txt", {
      body: "one",
      expectedVersion: null,
      author: "author-1",
      message: "message-1",
      meta: { sequence: 1, nested: { preserved: true } },
    });
    await writes.put("written", "history.txt", {
      body: "two",
      expectedVersion: 1,
      author: "author-2",
      message: "message-2",
      meta: { sequence: 2 },
    });
    await writes.delete("written", "history.txt", {
      expectedVersion: 2,
      author: "author-3",
      message: "message-3",
    });
    await writes.put("written", "history.txt", {
      body: "four",
      expectedVersion: 3,
      author: "author-4",
      message: "message-4",
      meta: { sequence: 4 },
    });
    await writes.rollback("written", "history.txt", {
      expectedVersion: 4,
      toVersion: 2,
      author: "author-5",
      message: "message-5",
      meta: { sequence: 5 },
    });

    const versionRows = async (stash: string) =>
      (
        await env.DB.prepare(
          `SELECT version, kind, blob_hash, size_bytes, content_type, rollback_of,
             author, message, meta_json, created_at
           FROM versions WHERE stash_name = ? AND path = ? ORDER BY version`,
        )
          .bind(stash, "history.txt")
          .all()
      ).results;
    expect(await versionRows("imported")).toEqual(await versionRows("written"));

    const fileRow = async (stash: string) =>
      env.DB.prepare(
        `SELECT head_version, head_hash, deleted, created_at, updated_at
         FROM files WHERE stash_name = ? AND path = ?`,
      )
        .bind(stash, "history.txt")
        .first();
    expect(await fileRow("imported")).toEqual(await fileRow("written"));

    const blobRows = async (stash: string) =>
      (
        await env.DB.prepare(
          `SELECT hash, body, r2_key, size_bytes, created_at
           FROM blobs WHERE stash_name = ? ORDER BY created_at`,
        )
          .bind(stash)
          .all()
      ).results;
    expect(await blobRows("imported")).toEqual(await blobRows("written"));

    if (!result.ok) throw new Error("import failed");
    const first = await env.DB.prepare(
      "SELECT id FROM versions WHERE stash_name = ? AND path = ? AND version = 1",
    )
      .bind("imported", "history.txt")
      .first<{ id: number }>();
    expect(result.value.firstChangeId).toBe(first?.id);
    expect(await counts("imported")).toMatchObject({ idempotency: 0 });
  });

  it("prepares A, B, A once per distinct hash before one fenced commit", async () => {
    const stash = "distinct-spills";
    await seedStash(stash);
    const bodyA = spilledBody("DISTINCT_A", "a");
    const bodyB = spilledBody("DISTINCT_B", "b");
    const hashA = await sha256Hex(bodyA);
    const hashB = await sha256Hex(bodyB);
    const keyA = blobKey(stash, hashA, generation(1));
    const keyB = blobKey(stash, hashB, generation(2));
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const attempts: { call: number; key: string }[] = [];
    const bindings = wrapBlobs(workerEnv, {
      count: calls,
      failPut: (call, key) => {
        attempts.push({ call, key });
        return false;
      },
    });
    const objectsAtCommit: string[][] = [];
    const store = importer(10_000, bindings, async () => {
      objectsAtCommit.push(
        (await env.BLOBS.list({ prefix: `v2/${stash}/` })).objects.map(({ key }) => key).sort(),
      );
    });

    const result = await store.importFile(stash, {
      path: "history.txt",
      expectedVersion: null,
      versions: [
        { kind: "put", body: bodyA, createdAt: 1_001 },
        { kind: "put", body: bodyB, createdAt: 1_002 },
        { kind: "put", body: bodyA, createdAt: 1_003 },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      statusCode: 201,
      value: { path: "history.txt", headVersion: 3 },
    });
    expect(calls).toEqual({ get: 0, put: 2 });
    expect(attempts).toEqual([
      { call: 1, key: keyA },
      { call: 2, key: keyB },
    ]);
    expect(objectsAtCommit).toEqual([[keyA, keyB].sort()]);
    expect(await counts(stash)).toEqual({ blobs: 2, versions: 3, files: 1, idempotency: 0 });

    const versions = await env.DB.prepare(
      `SELECT version, blob_hash FROM versions
       WHERE stash_name = ? AND path = ? ORDER BY version`,
    )
      .bind(stash, "history.txt")
      .all<{ version: number; blob_hash: string }>();
    expect(versions.results).toEqual([
      { version: 1, blob_hash: hashA },
      { version: 2, blob_hash: hashB },
      { version: 3, blob_hash: hashA },
    ]);

    const blobs = await env.DB.prepare(
      "SELECT hash, body, r2_key FROM blobs WHERE stash_name = ? ORDER BY hash",
    )
      .bind(stash)
      .all<{ hash: string; body: string | null; r2_key: string | null }>();
    expect(blobs.results).toHaveLength(2);
    expect(blobs.results).toEqual(
      expect.arrayContaining([
        { hash: hashA, body: null, r2_key: keyA },
        { hash: hashB, body: null, r2_key: keyB },
      ]),
    );
  });

  it("leaves the successful prefix orphaned and D1 untouched when the second upload fails", async () => {
    const stash = "failed-spills";
    await seedStash(stash);
    const bodyA = spilledBody("FAILURE_A", "a");
    const bodyB = spilledBody("FAILURE_B", "b");
    const hashA = await sha256Hex(bodyA);
    const hashB = await sha256Hex(bodyB);
    const keyA = blobKey(stash, hashA, generation(1));
    const keyB = blobKey(stash, hashB, generation(2));
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const attempts: { call: number; key: string }[] = [];
    let hookCalls = 0;
    const bindings = wrapBlobs(workerEnv, {
      count: calls,
      failPut: (call, key) => {
        attempts.push({ call, key });
        return call === 2;
      },
    });

    await expect(
      importer(10_000, bindings, () => {
        hookCalls += 1;
      }).importFile(stash, {
        path: "history.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body: bodyA, createdAt: 1_001 },
          { kind: "put", body: bodyB, createdAt: 1_002 },
          { kind: "put", body: bodyA, createdAt: 1_003 },
        ],
      }),
    ).rejects.toThrow("Injected R2 put failure");

    expect(calls).toEqual({ get: 0, put: 2 });
    expect(attempts).toEqual([
      { call: 1, key: keyA },
      { call: 2, key: keyB },
    ]);
    expect(hookCalls).toBe(0);
    expect(await counts(stash)).toEqual({ blobs: 0, versions: 0, files: 0, idempotency: 0 });
    expect(
      (await env.BLOBS.list({ prefix: `v2/${stash}/` })).objects.map(({ key }) => key),
    ).toEqual([keyA]);
    await expect(env.BLOBS.head(keyB)).resolves.toBeNull();
  });

  it("lets exactly one same-head import win while retaining both imports' objects", async () => {
    const stash = "racing-spills";
    await seedStash(stash);
    await importer().importFile(stash, {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: "base", createdAt: 1_000 }],
    });

    const sharedBody = spilledBody("RACE_SHARED", "s");
    const bodiesA = [sharedBody, spilledBody("RACE_A2", "a")] as const;
    const bodiesB = [sharedBody, spilledBody("RACE_B2", "b")] as const;
    const hashesA = await Promise.all([sha256Hex(bodiesA[0]), sha256Hex(bodiesA[1])]);
    const hashesB = await Promise.all([sha256Hex(bodiesB[0]), sha256Hex(bodiesB[1])]);
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(workerEnv, { count: calls });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onBeforeCommit = (): Promise<void> => {
      arrivals += 1;
      if (arrivals === 2) release();
      return barrier;
    };
    const raceGenerations = [generation(10), generation(11), generation(12), generation(13)];
    const store = importer(10_000, bindings, onBeforeCommit, generationFactory(...raceGenerations));
    const importInput = (bodies: readonly string[]): ImportBody => ({
      path: "history.txt",
      expectedVersion: 1,
      versions: bodies.map((body, index) => ({
        kind: "put" as const,
        body,
        createdAt: 1_001 + index,
      })),
    });

    const [resultA, resultB] = await Promise.all([
      store.importFile(stash, importInput(bodiesA)),
      store.importFile(stash, importInput(bodiesB)),
    ]);

    expect(arrivals).toBe(2);
    expect(calls).toEqual({ get: 0, put: 4 });
    const outcomes = [resultA, resultB];
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "stale", status: 409 }, current: { version: 3 } },
    ]);
    const winnerHashes = resultA.ok ? hashesA : hashesB;
    const loserHashes = resultA.ok ? hashesB : hashesA;

    const versions = await env.DB.prepare(
      `SELECT version, blob_hash FROM versions
       WHERE stash_name = ? AND path = ? ORDER BY version`,
    )
      .bind(stash, "history.txt")
      .all<{ version: number; blob_hash: string }>();
    expect(versions.results.slice(1)).toEqual([
      { version: 2, blob_hash: winnerHashes[0] },
      { version: 3, blob_hash: winnerHashes[1] },
    ]);
    const committedHashes = new Set(versions.results.map(({ blob_hash }) => blob_hash));
    expect(loserHashes[0]).toBe(winnerHashes[0]);
    expect(committedHashes.has(loserHashes[0])).toBe(true);
    expect(committedHashes.has(loserHashes[1])).toBe(false);
    await expect(
      env.DB.prepare("SELECT 1 FROM blobs WHERE stash_name = ? AND hash = ?")
        .bind(stash, loserHashes[1])
        .first(),
    ).resolves.toBeNull();
    expect(await counts(stash)).toEqual({ blobs: 3, versions: 3, files: 1, idempotency: 0 });
    const objectKeys = (await env.BLOBS.list({ prefix: `v2/${stash}/` })).objects
      .map(({ key }) => key)
      .sort();
    expect(objectKeys).toHaveLength(4);
    expect(new Set(objectKeys).size).toBe(4);
    expect(objectKeys.map((key) => parseBlobKey(key))).toEqual(
      expect.arrayContaining(
        [...hashesA, ...hashesB].map((hash) =>
          expect.objectContaining({ format: "v2", stash, hash }),
        ),
      ),
    );
    const committed = await env.DB.prepare(
      "SELECT r2_key FROM blobs WHERE stash_name = ? AND hash IN (?, ?)",
    )
      .bind(stash, winnerHashes[0], winnerHashes[1])
      .all<{ r2_key: string }>();
    expect(committed.results.every(({ r2_key }) => objectKeys.includes(r2_key))).toBe(true);
    expect(
      objectKeys.filter((key) => !committed.results.some((row) => row.r2_key === key)),
    ).toHaveLength(2);
  });

  it("copies imported and stored spilled rollback targets without another R2 operation", async () => {
    const stash = "rollback-spill";
    await seedStash(stash);
    const body = spilledBody("ROLLBACK_SOURCE", "r");
    const hash = await sha256Hex(body);
    const firstCalls: BlobCallCounts = { get: -1, put: -1 };
    const first = await importer(10_000, wrapBlobs(workerEnv, { count: firstCalls })).importFile(
      stash,
      {
        path: "history.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body, createdAt: 1_001 },
          { kind: "rollback", body: null, rollbackOf: 1, createdAt: 1_002 },
        ],
      },
    );
    expect(first).toMatchObject({ ok: true, value: { headVersion: 2 } });
    expect(firstCalls).toEqual({ get: 0, put: 1 });

    const continuationCalls: BlobCallCounts = { get: -1, put: -1 };
    const continued = await importer(
      10_000,
      wrapBlobs(workerEnv, { count: continuationCalls }),
    ).importFile(stash, {
      path: "history.txt",
      expectedVersion: 2,
      versions: [{ kind: "rollback", body: null, rollbackOf: 1, createdAt: 1_003 }],
    });
    expect(continued).toMatchObject({ ok: true, value: { headVersion: 3 } });
    if (!continued.ok) throw new Error("Expected continuation rollback to commit");
    const expectedSize = utf8ByteLength(body);
    expect(expectedSize).toBeGreaterThan(0);
    expect(continued.createdVersions).toEqual([
      expect.objectContaining({ version: 3, kind: "rollback", size: expectedSize }),
    ]);
    expect(continuationCalls).toEqual({ get: 0, put: 0 });
    expect(await counts(stash)).toEqual({ blobs: 1, versions: 3, files: 1, idempotency: 0 });
    const versions = await env.DB.prepare(
      `SELECT version, kind, blob_hash, size_bytes, rollback_of FROM versions
       WHERE stash_name = ? AND path = ? ORDER BY version`,
    )
      .bind(stash, "history.txt")
      .all();
    expect(versions.results).toEqual([
      { version: 1, kind: "put", blob_hash: hash, size_bytes: expectedSize, rollback_of: null },
      {
        version: 2,
        kind: "rollback",
        blob_hash: hash,
        size_bytes: expectedSize,
        rollback_of: 1,
      },
      {
        version: 3,
        kind: "rollback",
        blob_hash: hash,
        size_bytes: expectedSize,
        rollback_of: 1,
      },
    ]);
    const [row] = (
      await env.DB.prepare("SELECT r2_key FROM blobs WHERE stash_name = ? AND hash = ?")
        .bind(stash, hash)
        .all<{ r2_key: string }>()
    ).results;
    expect(
      (await env.BLOBS.list({ prefix: `v2/${stash}/` })).objects.map(({ key }) => key),
    ).toEqual([row?.r2_key]);
  });

  it("refuses duplicate create and appends a contiguous continuation through stored rollback", async () => {
    await seedStash("continuation");
    const store = importer();
    const initial = await store.importFile("continuation", {
      path: "history.txt",
      expectedVersion: null,
      versions: fiveVersions(),
    });
    expect(initial.ok).toBe(true);
    const beforeDuplicate = await counts("continuation");
    const duplicateCalls: BlobCallCounts = { get: -1, put: -1 };
    const duplicate = await importer(
      10_000,
      wrapBlobs(workerEnv, { count: duplicateCalls }),
    ).importFile("continuation", {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: spilledBody("DUPLICATE_CREATE", "d"), createdAt: 1_006 }],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: "exists", status: 409 },
      current: { version: 5 },
    });
    expect(duplicateCalls).toEqual({ get: 0, put: 0 });
    expect(await counts("continuation")).toEqual(beforeDuplicate);

    const backdated = await store.importFile("continuation", {
      path: "history.txt",
      expectedVersion: 5,
      versions: [{ kind: "put", body: "backdated", createdAt: 1_004 }],
    });
    expect(backdated).toMatchObject({
      ok: false,
      error: { code: "validation", status: 400 },
    });
    expect(await counts("continuation")).toEqual(beforeDuplicate);

    const continued = await store.importFile("continuation", {
      path: "history.txt",
      expectedVersion: 5,
      versions: [
        { kind: "rollback", body: null, rollbackOf: 2, createdAt: 1_006 },
        { kind: "put", body: "seven", createdAt: 1_007 },
      ],
    });
    expect(continued).toMatchObject({
      ok: true,
      value: { path: "history.txt", headVersion: 7 },
    });
    const rows = await env.DB.prepare(
      `SELECT version, kind, rollback_of FROM versions
       WHERE stash_name = ? AND path = ? ORDER BY version`,
    )
      .bind("continuation", "history.txt")
      .all<{ version: number; kind: string; rollback_of: number | null }>();
    expect(rows.results).toHaveLength(7);
    expect(rows.results[5]).toEqual({ version: 6, kind: "rollback", rollback_of: 2 });
    expect(rows.results[6]).toEqual({ version: 7, kind: "put", rollback_of: null });
  });

  it("leaves every table unchanged on stale expectedVersion", async () => {
    await seedStash("stale-import");
    const store = importer();
    await store.importFile("stale-import", {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: "one", createdAt: 1_001 }],
    });
    const before = await counts("stale-import");
    const staleBody = spilledBody("STALE_IMPORT", "s");
    const staleHash = await sha256Hex(staleBody);
    const staleCalls: BlobCallCounts = { get: -1, put: -1 };
    const stale = await importer(10_000, wrapBlobs(workerEnv, { count: staleCalls })).importFile(
      "stale-import",
      {
        path: "history.txt",
        expectedVersion: 2,
        versions: [{ kind: "put", body: staleBody, createdAt: 1_002 }],
      },
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "stale", status: 409 },
      current: { version: 1 },
    });
    expect(staleCalls).toEqual({ get: 0, put: 0 });
    expect(await counts("stale-import")).toEqual(before);
    expect(
      await env.DB.prepare("SELECT 1 FROM blobs WHERE stash_name = ? AND hash = ?")
        .bind("stale-import", staleHash)
        .first(),
    ).toBeNull();
    expect((await env.BLOBS.list({ prefix: "v2/stale-import/" })).objects).toEqual([]);
  });

  it("finishes missing-stash and missing-file CAS preflight before any upload", async () => {
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const store = importer(10_000, wrapBlobs(workerEnv, { count: calls }));
    const missingStash = await store.importFile("missing-import-stash", {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: spilledBody("MISSING_STASH", "m"), createdAt: 1_001 }],
    });
    expect(missingStash).toMatchObject({
      ok: false,
      error: { code: "not-found", status: 404 },
    });
    expect(calls).toEqual({ get: 0, put: 0 });
    expect(await counts("missing-import-stash")).toEqual({
      blobs: 0,
      versions: 0,
      files: 0,
      idempotency: 0,
    });

    await seedStash("missing-import-file");
    const missingFile = await store.importFile("missing-import-file", {
      path: "history.txt",
      expectedVersion: 1,
      versions: [{ kind: "put", body: spilledBody("MISSING_FILE", "f"), createdAt: 1_001 }],
    });
    expect(missingFile).toMatchObject({
      ok: false,
      error: { code: "not-found", status: 404 },
    });
    expect(calls).toEqual({ get: 0, put: 0 });
    expect((await env.BLOBS.list()).objects).toEqual([]);
  });

  it("rejects invalid rollback, timestamps, future entries, and oversized calls without writes", async () => {
    await seedStash("invalid-import");
    const store = importer(2_000);
    const cases: unknown[] = [
      {
        path: "rollback-delete.txt",
        expectedVersion: null,
        versions: [
          { kind: "delete", body: null, createdAt: 1_000 },
          { kind: "rollback", body: null, rollbackOf: 1, createdAt: 1_001 },
        ],
      },
      {
        path: "nonmonotonic.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body: "one", createdAt: 1_001 },
          { kind: "put", body: "two", createdAt: 1_000 },
        ],
      },
      {
        path: "future.txt",
        expectedVersion: null,
        versions: [{ kind: "put", body: "future", createdAt: 2_001 }],
      },
      {
        path: "too-many.txt",
        expectedVersion: null,
        versions: Array.from({ length: 21 }, (_, index) => ({
          kind: "put",
          body: String(index),
          createdAt: 1_000 + index,
        })),
      },
    ];
    for (const input of cases) {
      const before = await counts("invalid-import");
      const result = await store.importFile("invalid-import", input as ImportBody);
      expect(result).toMatchObject({ ok: false, error: { code: "validation", status: 400 } });
      expect(await counts("invalid-import")).toEqual(before);
    }
  });

  it("rejects an already-stored tombstone rollback target without writes", async () => {
    await seedStash("stored-tombstone");
    const store = importer();
    await store.importFile("stored-tombstone", {
      path: "history.txt",
      expectedVersion: null,
      versions: [
        { kind: "put", body: "one", createdAt: 1_000 },
        { kind: "delete", body: null, createdAt: 1_001 },
      ],
    });
    const before = await counts("stored-tombstone");
    const tombstoneCalls: BlobCallCounts = { get: -1, put: -1 };
    const result = await importer(
      10_000,
      wrapBlobs(workerEnv, { count: tombstoneCalls }),
    ).importFile("stored-tombstone", {
      path: "history.txt",
      expectedVersion: 2,
      versions: [
        { kind: "put", body: spilledBody("BEFORE_BAD_ROLLBACK", "x"), createdAt: 1_002 },
        { kind: "rollback", body: null, rollbackOf: 2, createdAt: 1_003 },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation", status: 400 } });
    expect(tombstoneCalls).toEqual({ get: 0, put: 0 });
    expect(await counts("stored-tombstone")).toEqual(before);
    expect((await env.BLOBS.list({ prefix: "v2/stored-tombstone/" })).objects).toEqual([]);
  });

  it("keeps the SQL batch fenced and writes the final tombstone head last", async () => {
    await seedStash("batch-fence");
    const writes = createWrites(workerEnv, { now: () => 1_000, createId: () => "unused" });
    await writes.put("batch-fence", "race.txt", { body: "one", expectedVersion: null });
    const db = env.DB.withSession("first-primary");
    const prepared: PreparedImportVersion[] = [
      {
        version: 2,
        kind: "put",
        body: "loser",
        r2_key: null,
        hash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: 5,
        rollbackOf: null,
        author: "",
        message: "",
        metaJson: "{}",
        createdAt: 1_001,
      },
    ];
    const built = importBatch(db, {
      stash: "batch-fence",
      path: "race.txt",
      expectedVersion: 1,
      versions: prepared,
    });
    await writes.put("batch-fence", "race.txt", { body: "winner", expectedVersion: 1 });
    const before = await counts("batch-fence");
    const results = await db.batch(built.statements);
    expect(results.at(-1)?.meta.changes).toBe(0);
    expect(await counts("batch-fence")).toEqual(before);

    const deleted = await importer().importFile("batch-fence", {
      path: "delete-last.txt",
      expectedVersion: null,
      versions: [
        { kind: "put", body: "live", createdAt: 1_000 },
        { kind: "delete", body: null, createdAt: 1_001 },
      ],
    });
    expect(deleted).toMatchObject({ ok: true, value: { headVersion: 2 } });
    expect(
      await env.DB.prepare(
        `SELECT head_version, head_hash, deleted FROM files
         WHERE stash_name = ? AND path = ?`,
      )
        .bind("batch-fence", "delete-last.txt")
        .first(),
    ).toEqual({ head_version: 2, head_hash: null, deleted: 1 });
  });
});
