import { RunGcBody } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { blobKey } from "../src/d1/blobs.js";
import { GcLeaseLostError } from "../src/d1/gc-store.js";
import type { Env } from "../src/env.js";
import {
  GcCursorValidationError,
  createGcEngine,
  decodeGcCursor,
  encodeContentCursor,
  encodeLedgerCursor,
  encodeR2Cursor,
} from "../src/gc.js";
import { resetDatabase, seedStash } from "./helpers/app.js";
import { seedCommit } from "./helpers/seed-rows.js";

const STASH = "gc-content-paging";
const HASH = `sha256-${"a".repeat(64)}`;
const GENERATION = "11111111-1111-4111-8111-111111111111";
const NOW = 86_400_001;

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

function input(
  values: Partial<ReturnType<typeof RunGcBody.parse>> & {
    kind: "content" | "r2-orphans";
  },
) {
  return RunGcBody.parse(values);
}

function withR2Counts(bindings: Env, calls: { list: number; head: number; delete: number }): Env {
  const bucket = new Proxy(bindings.BLOBS, {
    get(target, property) {
      if (property === "list") {
        return async (...args: Parameters<R2Bucket["list"]>) => {
          calls.list += 1;
          return target.list(...args);
        };
      }
      if (property === "head") {
        return async (...args: Parameters<R2Bucket["head"]>) => {
          calls.head += 1;
          return target.head(...args);
        };
      }
      if (property === "delete") {
        return async (...args: Parameters<R2Bucket["delete"]>) => {
          calls.delete += 1;
          return target.delete(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...bindings, BLOBS: bucket };
}

async function seedLegacyBlob(hash: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
     VALUES (?, ?, 'body', NULL, 4, 0)`,
  )
    .bind(STASH, hash)
    .run();
}

async function survivingLegacyHashes(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT hash FROM blobs WHERE stash_name = ? ORDER BY hash")
    .bind(STASH)
    .all<{ hash: string }>();
  return rows.results.map(({ hash }) => hash);
}

async function persistedContentCursor(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT next_cursor FROM gc_jobs WHERE kind = 'content'").first<{
    next_cursor: string | null;
  }>();
  if (row === null) throw new Error("Missing content GC job");
  return row.next_cursor;
}

function malformedCursor(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("=", "");
}

describe("content GC paging and fences", () => {
  it("reclaims parseable R2 content only after both content phases remove its D1 row", async () => {
    const key = blobKey(STASH, HASH, GENERATION);
    const object = await env.BLOBS.put(key, "orphan candidate");
    if (object === null) throw new Error("R2 put failed");
    await env.DB.prepare(
      `INSERT INTO byte_blobs
         (stash_name, hash, body_bytes, r2_key, storage_generation, size_bytes, created_at)
       VALUES (?, ?, NULL, ?, 1, 16, 0)`,
    )
      .bind(STASH, HASH, key)
      .run();

    await seedCommit(STASH, "cmt_gc_content_history", 0);
    await env.DB.prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, size_bytes, content_storage,
          created_at, commit_id)
       VALUES (?, 'history.txt', 1, 'put', ?, 16, 'legacy', 0, ?)`,
    )
      .bind(STASH, HASH, "cmt_gc_content_history")
      .run();
    await env.DB.prepare(
      `INSERT INTO files
         (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
       VALUES (?, 'history.txt', 1, ?, 0, 0, 0)`,
    )
      .bind(STASH, HASH)
      .run();
    const historyBefore = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM files) AS files",
    ).first<{ versions: number; files: number }>();
    expect(historyBefore).toEqual({ versions: 1, files: 1 });

    const now = object.uploaded.getTime() + 900_001;
    const protectedPage = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans" }),
    );
    expect(protectedPage).toMatchObject({ scanned: 1, eligible: 0, deleted: 0, error: null });
    await expect(env.BLOBS.head(key)).resolves.not.toBeNull();

    const calls = { list: 0, head: 0, delete: 0 };
    let cursor: string | null | undefined;
    const contentPages: Array<{
      scanned: number;
      eligible: number;
      deleted: number;
      cursor: string | null;
    }> = [];
    do {
      const page = await createGcEngine(withR2Counts(env, calls), { now: () => now }).run(
        input({ kind: "content", ...(typeof cursor === "string" ? { cursor } : {}) }),
      );
      expect(page.error).toBeNull();
      contentPages.push({
        scanned: page.scanned,
        eligible: page.eligible,
        deleted: page.deleted,
        cursor: page.cursor,
      });
      cursor = page.cursor;
    } while (cursor !== null && contentPages.length < 5);

    expect(contentPages).toHaveLength(2);
    expect(contentPages[0]).toMatchObject({ scanned: 0, eligible: 0, deleted: 0 });
    expect(decodeGcCursor("content", contentPages[0]!.cursor!)).toEqual({
      v: 1,
      kind: "content",
      table: "byte_blobs",
      after: null,
    });
    expect(contentPages[1]).toEqual({ scanned: 1, eligible: 1, deleted: 1, cursor: null });
    expect(cursor).toBeNull();
    expect(calls).toEqual({ list: 0, head: 0, delete: 0 });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM byte_blobs WHERE r2_key = ?")
        .bind(key)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
    await expect(env.BLOBS.head(key)).resolves.not.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM files) AS files",
      ).first<{ versions: number; files: number }>(),
    ).resolves.toEqual(historyBefore);

    const reclaimedPage = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans" }),
    );
    expect(reclaimedPage).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    await expect(env.BLOBS.head(key)).resolves.toBeNull();
  });

  it("persists maxObjects keyset progress and the blobs-to-byte_blobs transition only for non-dry pages", async () => {
    const hashes = Array.from(
      { length: 5 },
      (_, index) => `sha256-${String(index).padStart(64, "0")}`,
    );
    for (const hash of hashes) await seedLegacyBlob(hash);

    const dry = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", dryRun: true, maxObjects: 2 }),
    );
    expect(dry).toMatchObject({ scanned: 2, eligible: 2, deleted: 0 });
    expect(dry.cursor).not.toBeNull();
    await expect(persistedContentCursor()).resolves.toBeNull();
    await expect(survivingLegacyHashes()).resolves.toEqual(hashes);

    const first = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", maxObjects: 2 }),
    );
    expect(first).toMatchObject({ scanned: 2, eligible: 2, deleted: 2, error: null });
    expect(first.cursor).not.toBeNull();
    expect(decodeGcCursor("content", first.cursor!)).toEqual({
      v: 1,
      kind: "content",
      table: "blobs",
      after: { stashName: STASH, hash: hashes[1] },
    });
    await expect(persistedContentCursor()).resolves.toBe(first.cursor);
    await expect(survivingLegacyHashes()).resolves.toEqual(hashes.slice(2));

    const second = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", maxObjects: 2, cursor: first.cursor! }),
    );
    expect(second).toMatchObject({ scanned: 2, eligible: 2, deleted: 2, error: null });
    expect(decodeGcCursor("content", second.cursor!)).toEqual({
      v: 1,
      kind: "content",
      table: "blobs",
      after: { stashName: STASH, hash: hashes[3] },
    });
    await expect(persistedContentCursor()).resolves.toBe(second.cursor);
    await expect(survivingLegacyHashes()).resolves.toEqual(hashes.slice(4));

    const transition = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", maxObjects: 2, cursor: second.cursor! }),
    );
    expect(transition).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    expect(decodeGcCursor("content", transition.cursor!)).toEqual({
      v: 1,
      kind: "content",
      table: "byte_blobs",
      after: null,
    });
    await expect(persistedContentCursor()).resolves.toBe(transition.cursor);
    await expect(survivingLegacyHashes()).resolves.toEqual([]);

    const complete = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", maxObjects: 2, cursor: transition.cursor! }),
    );
    expect(complete).toMatchObject({
      scanned: 0,
      eligible: 0,
      deleted: 0,
      cursor: null,
      error: null,
    });
    await expect(persistedContentCursor()).resolves.toBeNull();
  });

  it("rejects cross-kind and malformed content cursor envelopes", () => {
    expect(() => decodeGcCursor("ledger", encodeContentCursor("blobs", null))).toThrow(
      GcCursorValidationError,
    );
    expect(() => decodeGcCursor("content", encodeLedgerCursor(10, 2))).toThrow(
      GcCursorValidationError,
    );
    expect(() => decodeGcCursor("content", encodeR2Cursor("opaque"))).toThrow(
      GcCursorValidationError,
    );

    for (const cursor of [
      malformedCursor({ v: 1, kind: "content", table: "versions", after: null }),
      malformedCursor({ v: 1, kind: "content", table: "blobs", after: null, extra: true }),
      malformedCursor({
        v: 1,
        kind: "content",
        table: "blobs",
        after: { stashName: STASH, hash: "" },
      }),
    ]) {
      expect(() => decodeGcCursor("content", cursor)).toThrow(GcCursorValidationError);
    }
  });

  it("rechecks content eligibility inside the lease-fenced delete", async () => {
    const protectedHash = `sha256-${"b".repeat(64)}`;
    const deletedHash = `sha256-${"c".repeat(64)}`;
    await seedLegacyBlob(protectedHash);
    await seedLegacyBlob(deletedHash);
    await seedCommit(STASH, "cmt_gc_content_fence", 0);

    let hookCalls = 0;
    const result = await createGcEngine(env, {
      now: () => NOW,
      hooks: {
        beforeDelete: async () => {
          hookCalls += 1;
          await env.DB.prepare(
            `INSERT INTO versions
               (stash_name, path, version, kind, blob_hash, size_bytes, content_storage,
                created_at, commit_id)
             VALUES (?, 'protected.txt', 1, 'put', ?, 4, 'legacy', 0, ?)`,
          )
            .bind(STASH, protectedHash, "cmt_gc_content_fence")
            .run();
        },
      },
    }).run(input({ kind: "content" }));

    expect(hookCalls).toBe(1);
    expect(result).toMatchObject({ eligible: 2, deleted: 1, error: null });
    expect(result.eligible).toBeGreaterThan(result.deleted);
    await expect(survivingLegacyHashes()).resolves.toEqual([protectedHash]);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM versions WHERE stash_name = ? AND blob_hash = ?",
      )
        .bind(STASH, protectedHash)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("rejects lease-generation loss without deleting content or finishing the run", async () => {
    const runId = "run-content-lease-loss";
    await seedLegacyBlob(HASH);
    const engine = createGcEngine(env, {
      now: () => NOW,
      createId: () => runId,
      hooks: {
        beforeDelete: async () => {
          await env.DB.prepare(
            "UPDATE gc_jobs SET lease_generation = lease_generation + 1 WHERE kind = 'content'",
          ).run();
        },
      },
    });

    await expect(engine.run(input({ kind: "content" }))).rejects.toThrow(GcLeaseLostError);
    await expect(survivingLegacyHashes()).resolves.toEqual([HASH]);
    await expect(
      env.DB.prepare("SELECT finished_at FROM gc_runs WHERE id = ?")
        .bind(runId)
        .first<{ finished_at: number | null }>(),
    ).resolves.toEqual({ finished_at: null });
  });
});
