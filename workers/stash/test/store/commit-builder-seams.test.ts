import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitBatch,
  commitFence,
  type CommitBatchInput,
  type PreparedCommitEntry,
} from "../../src/d1/sql/commits.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

const CREATED_AT = 1_000;

function input(stash: string, entry: PreparedCommitEntry): CommitBatchInput {
  return {
    row: {
      id: `cmt-${stash}`,
      stash_name: stash,
      source: "commit",
      source_id: null,
      author: "author",
      message: "message",
      meta_json: "{}",
      entry_count: 1,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: "request-hash",
      created_by: "test",
      created_at: CREATED_AT,
    },
    entries: [entry],
  };
}

function textPut(stash: string): PreparedCommitEntry {
  return {
    op: "put",
    representation: "text",
    path: "file.txt",
    expectedVersion: null,
    version: 1,
    hash: `hash-${stash}`,
    size: 4,
    contentType: "text/plain",
    body: "body",
    r2_key: null,
    author: "author",
    message: "message",
    metaJson: "{}",
    createdAt: CREATED_AT,
  };
}

function stagedPut(
  path: string,
  representation: "text" | "binary",
  tier: "d1" | "r2",
  sessionId: string,
  hash: string,
  size: number,
  generation: number,
): PreparedCommitEntry {
  return {
    op: "put",
    content: "staged",
    representation,
    path,
    expectedVersion: null,
    version: 1,
    hash,
    size,
    contentType: representation === "text" ? "text/plain" : "application/octet-stream",
    staged: { tier, sessionId, generation },
    author: "author",
    message: "message",
    metaJson: "{}",
    createdAt: CREATED_AT,
  };
}

async function counts(stash: string) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM commits WHERE stash_name = ?) AS commits,
       (SELECT COUNT(*) FROM versions WHERE stash_name = ?) AS versions,
       (SELECT COUNT(*) FROM files WHERE stash_name = ?) AS files,
       (SELECT COUNT(*) FROM blobs WHERE stash_name = ?) AS blobs,
       (SELECT COUNT(*) FROM byte_blobs WHERE stash_name = ?) AS byteBlobs`,
  )
    .bind(stash, stash, stash, stash, stash)
    .first<{
      commits: number;
      versions: number;
      files: number;
      blobs: number;
      byteBlobs: number;
    }>();
  if (!row) throw new Error("Missing commit-builder counts");
  return row;
}

async function seedUploadSession(input: {
  id: string;
  stash: string;
  path: string;
  tier: "d1" | "r2";
  representation: "text" | "binary";
  generation: number;
  hash: string;
  size: number;
  r2Key?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO upload_sessions
       (id, stash_name, path, principal_kind, declared_size, representation, content_type,
        upload_mode, storage_tier, state, expires_at, attempt_generation, create_fingerprint,
        uploaded_size, uploaded_hash, staged_r2_key, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', ?, ?, ?, 'single', ?, 'uploaded', 999999, ?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      input.id,
      input.stash,
      input.path,
      input.size,
      input.representation,
      input.representation === "text" ? "text/plain" : "application/octet-stream",
      input.tier,
      input.generation,
      `create-${input.id}`,
      input.size,
      input.hash,
      input.r2Key ?? null,
    )
    .run();
}

beforeEach(async () => {
  await resetDatabase();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS commit_builder_seam_marks (
       commit_id TEXT PRIMARY KEY,
       observed_versions INTEGER NOT NULL
     )`,
  ).run();
  await env.DB.prepare("DELETE FROM commit_builder_seam_marks").run();
});

describe("commitBatch predicate and post-entry seams", () => {
  it("fences every write when the extra gate predicate is false", async () => {
    const stash = "seam-gate-false";
    await seedStash(stash);
    const batch = input(stash, textPut(stash));
    batch.extraGatePredicate = { sql: "? = 1", params: [0] };

    const results = await env.DB.batch(commitBatch(env.DB, batch));

    expect(results.every(({ meta }) => meta.changes === 0)).toBe(true);
    await expect(counts(stash)).resolves.toEqual({
      commits: 0,
      versions: 0,
      files: 0,
      blobs: 0,
      byteBlobs: 0,
    });
  });

  it("rolls back the whole batch through the seal CHECK when the extra seal predicate is false", async () => {
    const stash = "seam-seal-false";
    await seedStash(stash);
    const batch = input(stash, textPut(stash));
    batch.extraSealPredicate = { sql: "? = 1", params: [0] };

    await expect(env.DB.batch(commitBatch(env.DB, batch))).rejects.toThrow(/SQLITE_CONSTRAINT/su);
    await expect(counts(stash)).resolves.toEqual({
      commits: 0,
      versions: 0,
      files: 0,
      blobs: 0,
      byteBlobs: 0,
    });
  });

  it("runs fenced post-entry statements after entry writes and before the seal", async () => {
    const stash = "seam-post-entry";
    await seedStash(stash);
    const batch = input(stash, textPut(stash));
    const fence = commitFence(stash, batch.row.id);
    batch.postEntryStatements = [
      env.DB.prepare(
        `INSERT INTO commit_builder_seam_marks (commit_id, observed_versions)
         SELECT ?, COUNT(*) FROM versions WHERE commit_id = ? AND ${fence.sql}
         HAVING COUNT(*) = 1`,
      ).bind(batch.row.id, batch.row.id, ...fence.params),
    ];
    batch.extraSealPredicate = {
      sql: "EXISTS (SELECT 1 FROM commit_builder_seam_marks WHERE commit_id = ?)",
      params: [batch.row.id],
    };

    const results = await env.DB.batch(commitBatch(env.DB, batch));

    expect(results.at(-1)?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare("SELECT * FROM commit_builder_seam_marks WHERE commit_id = ?")
        .bind(batch.row.id)
        .first(),
    ).resolves.toEqual({ commit_id: batch.row.id, observed_versions: 1 });
  });

  it("writes no post-entry side row when the gate fails", async () => {
    const stash = "seam-post-gate-false";
    await seedStash(stash);
    const batch = input(stash, textPut(stash));
    const fence = commitFence(stash, batch.row.id);
    batch.extraGatePredicate = { sql: "0", params: [] };
    batch.postEntryStatements = [
      env.DB.prepare(
        `INSERT INTO commit_builder_seam_marks (commit_id, observed_versions)
         SELECT ?, COUNT(*) FROM versions WHERE commit_id = ? AND ${fence.sql}
         HAVING COUNT(*) = 1`,
      ).bind(batch.row.id, batch.row.id, ...fence.params),
    ];

    await env.DB.batch(commitBatch(env.DB, batch));

    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM commit_builder_seam_marks").first(),
    ).resolves.toEqual({ count: 0 });
  });
});

describe("commitBatch staged-content puts", () => {
  it.each([
    {
      name: "D1 bytes with text representation",
      stash: "seam-staged-d1",
      path: "text.txt",
      tier: "d1" as const,
      representation: "text" as const,
      sessionId: "upl_seam_d1",
      generation: 3,
      hash: "hash-staged-d1",
      bytes: new Uint8Array([1, 2, 3, 4]),
      r2Key: null,
    },
    {
      name: "R2 bytes with binary representation",
      stash: "seam-staged-r2",
      path: "asset.bin",
      tier: "r2" as const,
      representation: "binary" as const,
      sessionId: "upl_seam_r2",
      generation: 7,
      hash: "hash-staged-r2",
      bytes: new Uint8Array([5, 6, 7, 8]),
      r2Key: "staging/r2-object",
    },
  ])("promotes $name owned by its upload session", async (fixture) => {
    await seedStash(fixture.stash);
    await seedUploadSession({
      id: fixture.sessionId,
      stash: fixture.stash,
      path: fixture.path,
      tier: fixture.tier,
      representation: fixture.representation,
      generation: fixture.generation,
      hash: fixture.hash,
      size: fixture.bytes.byteLength,
      r2Key: fixture.r2Key,
    });
    if (fixture.tier === "d1") {
      await env.DB.prepare(
        `INSERT INTO upload_staged_bytes
           (session_id, generation, body_bytes, size_bytes, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          fixture.sessionId,
          fixture.generation,
          fixture.bytes.buffer,
          fixture.bytes.byteLength,
          fixture.hash,
          CREATED_AT,
        )
        .run();
    }
    const batch = input(
      fixture.stash,
      stagedPut(
        fixture.path,
        fixture.representation,
        fixture.tier,
        fixture.sessionId,
        fixture.hash,
        fixture.bytes.byteLength,
        fixture.generation,
      ),
    );

    const results = await env.DB.batch(commitBatch(env.DB, batch));

    expect(results.at(-1)?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT hex(body_bytes) AS bodyHex, body_bytes IS NULL AS bodyIsNull,
           r2_key, storage_generation, size_bytes
         FROM byte_blobs WHERE stash_name = ? AND hash = ?`,
      )
        .bind(fixture.stash, fixture.hash)
        .first(),
    ).resolves.toEqual({
      bodyHex: fixture.tier === "d1" ? "01020304" : "",
      bodyIsNull: fixture.tier === "r2" ? 1 : 0,
      r2_key: fixture.r2Key,
      storage_generation: fixture.generation,
      size_bytes: fixture.bytes.byteLength,
    });
    await expect(
      env.DB.prepare(
        `SELECT blob_hash, size_bytes, representation, application_etag, content_storage
         FROM versions WHERE commit_id = ?`,
      )
        .bind(batch.row.id)
        .first(),
    ).resolves.toEqual({
      blob_hash: fixture.hash,
      size_bytes: fixture.bytes.byteLength,
      representation: fixture.representation,
      application_etag: fixture.hash,
      content_storage: "bytes",
    });
  });

  it.each([
    { name: "wrong generation", generation: 4, size: 4, ownerStash: null, ownerPath: null },
    { name: "wrong size", generation: 3, size: 5, ownerStash: null, ownerPath: null },
    {
      name: "different owning stash",
      generation: 3,
      size: 4,
      ownerStash: "seam-staged-owner",
      ownerPath: null,
    },
    {
      name: "different owning path",
      generation: 3,
      size: 4,
      ownerStash: null,
      ownerPath: "other.txt",
    },
  ])("rolls back every commit row for a $name mismatch", async (fixture) => {
    const stash = `seam-staged-${fixture.name.replaceAll(" ", "-")}`;
    const ownerStash = fixture.ownerStash ?? stash;
    const ownerPath = fixture.ownerPath ?? "file.txt";
    if (ownerStash !== stash) await seedStash(ownerStash);
    await seedStash(stash);
    await seedUploadSession({
      id: `upl_${fixture.name.replaceAll(" ", "_")}`,
      stash: ownerStash,
      path: ownerPath,
      tier: "d1",
      representation: "binary",
      generation: fixture.generation,
      hash: "hash-negative",
      size: fixture.size,
    });
    const sessionId = `upl_${fixture.name.replaceAll(" ", "_")}`;
    await env.DB.prepare(
      `INSERT INTO upload_staged_bytes
         (session_id, generation, body_bytes, size_bytes, hash, created_at)
       VALUES (?, 3, ?, 4, 'hash-negative', ?)`,
    )
      .bind(sessionId, new Uint8Array([1, 2, 3, 4]).buffer, CREATED_AT)
      .run();
    const batch = input(
      stash,
      stagedPut(
        "file.txt",
        "binary",
        "d1",
        sessionId,
        "hash-negative",
        fixture.size,
        fixture.generation,
      ),
    );

    await expect(env.DB.batch(commitBatch(env.DB, batch))).rejects.toThrow(/SQLITE_CONSTRAINT/su);
    await expect(counts(stash)).resolves.toEqual({
      commits: 0,
      versions: 0,
      files: 0,
      blobs: 0,
      byteBlobs: 0,
    });
  });
});
