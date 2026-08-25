import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportBody } from "@takazudo/zudo-history-stash-core";
import type { Env } from "../../src/env.js";
import { createImport } from "../../src/d1/import.js";
import { importBatch, type PreparedImportVersion } from "../../src/d1/sql/import.js";
import { createWrites } from "../../src/d1/writes.js";
import { resetDatabase } from "../helpers/app.js";

const workerEnv = env as Env;

async function seedStash(name: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, '', '{}', ?)",
  )
    .bind(name, 1_000)
    .run();
}

function importer(now = 10_000) {
  return createImport(workerEnv, { now: () => now, createId: () => "unused" });
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
    const duplicate = await store.importFile("continuation", {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: "duplicate", createdAt: 1_006 }],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: "exists", status: 409 },
      current: { version: 5 },
    });
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
    const stale = await store.importFile("stale-import", {
      path: "history.txt",
      expectedVersion: 2,
      versions: [{ kind: "put", body: "must-not-leak", createdAt: 1_002 }],
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "stale", status: 409 },
      current: { version: 1 },
    });
    expect(await counts("stale-import")).toEqual(before);
    expect(
      await env.DB.prepare("SELECT 1 FROM blobs WHERE stash_name = ? AND body = ?")
        .bind("stale-import", "must-not-leak")
        .first(),
    ).toBeNull();
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
    const result = await store.importFile("stored-tombstone", {
      path: "history.txt",
      expectedVersion: 2,
      versions: [{ kind: "rollback", body: null, rollbackOf: 2, createdAt: 1_002 }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation", status: 400 } });
    expect(await counts("stored-tombstone")).toEqual(before);
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
