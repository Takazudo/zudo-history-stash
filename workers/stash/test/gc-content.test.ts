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
import { seedCommit } from "./helpers/seed-rows.js";

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

async function seedLegacyBlob(hash: string, createdAt = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO blobs (stash_name, hash, body, size_bytes, created_at)
     VALUES (?, ?, 'body', 4, ?)`,
  )
    .bind(STASH, hash, createdAt)
    .run();
}

async function seedByteBlob(hash: string, createdAt = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO byte_blobs (stash_name, hash, body_bytes, size_bytes, created_at)
     VALUES (?, ?, ?, 4, ?)`,
  )
    .bind(STASH, hash, new Uint8Array([1, 2, 3, 4]), createdAt)
    .run();
}

async function legacyHashes(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT hash FROM blobs WHERE stash_name = ? ORDER BY hash")
    .bind(STASH)
    .all<{ hash: string }>();
  return rows.results.map(({ hash }) => hash);
}

async function byteHashes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT hash FROM byte_blobs WHERE stash_name = ? ORDER BY hash",
  )
    .bind(STASH)
    .all<{ hash: string }>();
  return rows.results.map(({ hash }) => hash);
}

async function seedVersion(
  hash: string,
  storage: "legacy" | "bytes",
  suffix: string,
): Promise<void> {
  const commitId = await seedCommit(STASH, `cmt_gc_content_${suffix}`, 0);
  await env.DB.prepare(
    `INSERT INTO versions
     (stash_name, path, version, kind, blob_hash, size_bytes, content_storage,
        representation, created_at, commit_id)
     VALUES (?, ?, 1, 'put', ?, 4, ?, ?, 0, ?)`,
  )
    .bind(STASH, `${suffix}.txt`, hash, storage, storage === "legacy" ? "text" : "binary", commitId)
    .run();
}

async function seedChangeSet(
  suffix: string,
  hash: string,
  status: "open" | "rejected" | "applied",
  expiresAt: number,
): Promise<void> {
  const id = `chs_gc_content_${suffix}`;
  await env.DB.prepare(
    `INSERT INTO change_sets
       (id, stash_name, status, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'test', 0)`,
  )
    .bind(id, STASH, status, expiresAt)
    .run();
  await env.DB.prepare(
    `INSERT INTO change_set_entries
       (change_set_id, stash_name, path, op, blob_hash, content_storage,
        representation, size_bytes)
     VALUES (?, ?, ?, 'put', ?, 'legacy', 'text', 4)`,
  )
    .bind(id, STASH, `${suffix}.txt`, hash)
    .run();
}

async function seedUploadSession(
  suffix: string,
  hash: string,
  state:
    "open" | "uploaded" | "finalizing" | "committed" | "aborted" | "expired" | "stale" | "failed",
  hashField: "uploaded_hash" | "declared_hash",
): Promise<void> {
  const isFinalizing = state === "finalizing";
  await env.DB.prepare(
    `INSERT INTO upload_sessions
       (id, stash_name, path, principal_kind, declared_size, declared_hash,
        representation, content_type, upload_mode, storage_tier, state, expires_at,
        create_fingerprint, uploaded_hash, finalization_lease_owner,
        finalization_lease_until, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 4, ?, 'text', 'text/plain', 'single', 'd1', ?, ?,
       ?, ?, ?, ?, 0, 0)`,
  )
    .bind(
      `upl_gc_content_${suffix}`,
      STASH,
      `${suffix}.txt`,
      hashField === "declared_hash" ? hash : null,
      state,
      NOW + 1,
      `create-gc-content-${suffix}`,
      hashField === "uploaded_hash" ? hash : null,
      isFinalizing ? `owner-${suffix}` : null,
      isFinalizing ? NOW + 1 : null,
    )
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

  it("preserves content referenced by a matching legacy version", async () => {
    const survivor = `sha256-${"c".repeat(64)}`;
    const control = `sha256-${"d".repeat(64)}`;
    await seedLegacyBlob(survivor);
    await seedLegacyBlob(control);
    await seedVersion(survivor, "legacy", "matching-legacy");

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));

    expect(result).toMatchObject({ deleted: 1, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([survivor]);
  });

  it("preserves only content referenced by a live open change set", async () => {
    const live = `sha256-${"1".repeat(64)}`;
    const deadOpen = `sha256-${"2".repeat(64)}`;
    const rejected = `sha256-${"3".repeat(64)}`;
    const applied = `sha256-${"4".repeat(64)}`;
    for (const hash of [live, deadOpen, rejected, applied]) await seedLegacyBlob(hash);
    await seedChangeSet("live", live, "open", NOW + 1);
    await seedChangeSet("dead-open", deadOpen, "open", 0);
    await seedChangeSet("rejected", rejected, "rejected", NOW + 1);
    await seedChangeSet("applied", applied, "applied", NOW + 1);

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));

    expect(result).toMatchObject({ deleted: 3, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([live]);
  });

  it("preserves hashes held by every in-flight upload state and hash field", async () => {
    const openUploaded = `sha256-${"1".repeat(64)}`;
    const uploadedDeclared = `sha256-${"2".repeat(64)}`;
    const finalizingUploaded = `sha256-${"3".repeat(64)}`;
    const committed = `sha256-${"4".repeat(64)}`;
    const aborted = `sha256-${"5".repeat(64)}`;
    const expired = `sha256-${"6".repeat(64)}`;
    const stale = `sha256-${"7".repeat(64)}`;
    const failed = `sha256-${"8".repeat(64)}`;
    const hashes = [
      openUploaded,
      uploadedDeclared,
      finalizingUploaded,
      committed,
      aborted,
      expired,
      stale,
      failed,
    ];
    for (const hash of hashes) await seedLegacyBlob(hash);
    await seedUploadSession("open-uploaded", openUploaded, "open", "uploaded_hash");
    await seedUploadSession("uploaded-declared", uploadedDeclared, "uploaded", "declared_hash");
    await seedUploadSession(
      "finalizing-uploaded",
      finalizingUploaded,
      "finalizing",
      "uploaded_hash",
    );
    await seedUploadSession("committed", committed, "committed", "uploaded_hash");
    await seedUploadSession("aborted", aborted, "aborted", "uploaded_hash");
    await seedUploadSession("expired", expired, "expired", "uploaded_hash");
    await seedUploadSession("stale", stale, "stale", "uploaded_hash");
    await seedUploadSession("failed", failed, "failed", "uploaded_hash");

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));

    expect(result).toMatchObject({ deleted: 5, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([
      openUploaded,
      uploadedDeclared,
      finalizingUploaded,
    ]);
  });

  it("uses a strict age cutoff at the exact grace boundary", async () => {
    const atBoundary = `sha256-${"1".repeat(64)}`;
    const outsideBoundary = `sha256-${"2".repeat(64)}`;
    // The SQL uses strict `<`: exactly now - grace survives, while one millisecond older deletes.
    await seedLegacyBlob(atBoundary, NOW - GC_CONTENT_MIN_AGE_MS);
    await seedLegacyBlob(outsideBoundary, NOW - GC_CONTENT_MIN_AGE_MS - 1);

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));

    expect(result).toMatchObject({ deleted: 1, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([atBoundary]);
  });

  it("does not let a bytes version protect the same hash in legacy storage", async () => {
    const shared = `sha256-${"e".repeat(64)}`;
    await seedLegacyBlob(shared);
    await seedByteBlob(shared);
    await seedVersion(shared, "bytes", "bytes-discriminator");

    const result = await createGcEngine(env, { now: () => NOW }).run(input({ kind: "content" }));

    expect(result).toMatchObject({ deleted: 1, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([]);
    await expect(byteHashes()).resolves.toEqual([shared]);
  });

  it("does not let a legacy version protect the same hash in bytes storage", async () => {
    const shared = `sha256-${"f".repeat(64)}`;
    await seedLegacyBlob(shared);
    await seedByteBlob(shared);
    await seedVersion(shared, "legacy", "legacy-discriminator");

    const result = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "content", cursor: encodeContentCursor("byte_blobs", null) }),
    );

    expect(result).toMatchObject({ deleted: 1, error: null });
    expect(result.deleted).toBeGreaterThan(0);
    await expect(legacyHashes()).resolves.toEqual([shared]);
    await expect(byteHashes()).resolves.toEqual([]);
  });
});
