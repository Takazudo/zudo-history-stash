import { RunGcBody } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GC_CONTENT_MIN_AGE_MS,
  GcCursorValidationError,
  createGcEngine,
  decodeGcCursor,
  encodeContentCursor,
  encodeLedgerCursor,
} from "../src/gc.js";
import type { Env } from "../src/env.js";
import { resetDatabase, seedStash } from "./helpers/app.js";

const STASH = "gc-content-test";
const UNREFERENCED_HASH = `sha256-${"a".repeat(64)}`;
const REFERENCED_HASH = `sha256-${"b".repeat(64)}`;
const NOW = GC_CONTENT_MIN_AGE_MS + 1;

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

function input(values: Partial<ReturnType<typeof RunGcBody.parse>> & { kind: "content" }) {
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
    `INSERT INTO blobs (stash_name, hash, body, size_bytes, created_at)
     VALUES (?, ?, 'body', 4, 0)`,
  )
    .bind(STASH, hash)
    .run();
}

describe("content collection", () => {
  it("deletes old unreferenced legacy content while preserving version references", async () => {
    await seedLegacyBlob(UNREFERENCED_HASH);
    await seedLegacyBlob(REFERENCED_HASH);
    await env.DB.prepare(
      `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
       VALUES ('cmt_gc_content', ?, 'put', 1, 'test', 0)`,
    )
      .bind(STASH)
      .run();
    await env.DB.prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, size_bytes, content_storage,
          created_at, commit_id)
       VALUES (?, 'referenced.txt', 1, 'put', ?, 4, 'legacy', 0, 'cmt_gc_content')`,
    )
      .bind(STASH, REFERENCED_HASH)
      .run();

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));
    expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    const rows = await env.DB.prepare("SELECT hash FROM blobs WHERE stash_name = ? ORDER BY hash")
      .bind(STASH)
      .all<{ hash: string }>();
    expect(rows.results).toEqual([{ hash: REFERENCED_HASH }]);

    const content = encodeContentCursor("blobs", null);
    const ledger = encodeLedgerCursor(1, 1);
    expect(() => decodeGcCursor("ledger", content)).toThrow(GcCursorValidationError);
    expect(() => decodeGcCursor("content", ledger)).toThrow(GcCursorValidationError);
  });

  it("reports dry-run eligibility without deleting D1 content or accessing R2", async () => {
    await seedLegacyBlob(UNREFERENCED_HASH);
    const calls = { list: 0, head: 0, delete: 0 };
    const result = await createGcEngine(withR2Counts(env, calls), { now: () => NOW }).run(
      input({ kind: "content", dryRun: true }),
    );

    expect(result.eligible).toBeGreaterThan(0);
    expect(result.deleted).toBe(0);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM blobs WHERE stash_name = ?")
        .bind(STASH)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
    expect(calls).toEqual({ list: 0, head: 0, delete: 0 });
  });
});
