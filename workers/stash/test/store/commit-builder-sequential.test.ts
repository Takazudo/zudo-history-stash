import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitBatch,
  type CommitBatchInput,
  type PreparedCommitEntry,
} from "../../src/d1/sql/commits.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

type CapturedStatement = { sql: string; params: unknown[] };

function captureStatements(input: CommitBatchInput): CapturedStatement[] {
  const captured: CapturedStatement[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = { sql, params };
          captured.push(statement);
          return statement as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  };
  commitBatch(db, input);
  return captured;
}

function put(
  path: string,
  expectedVersion: number | null,
  version: number,
  createdAt = 1_001,
): Extract<PreparedCommitEntry, { op: "put" }> {
  return {
    op: "put",
    representation: "text",
    path,
    expectedVersion,
    version,
    hash: `sha256-${path}-${version}`,
    size: 4,
    contentType: "text/plain; charset=utf-8",
    body: `body-${version}`,
    r2_key: null,
    author: "author",
    message: "message",
    metaJson: "{}",
    createdAt,
  };
}

function derived(
  op: "delete",
  path: string,
  expectedVersion: number | null,
  version: number,
): Extract<PreparedCommitEntry, { op: "delete" }>;
function derived(
  op: "rollback",
  path: string,
  expectedVersion: number | null,
  version: number,
): Extract<PreparedCommitEntry, { op: "rollback" }>;
function derived(
  op: "copy",
  path: string,
  expectedVersion: number | null,
  version: number,
): Extract<PreparedCommitEntry, { op: "copy" }>;
function derived(
  op: "delete" | "rollback" | "copy",
  path: string,
  expectedVersion: number | null,
  version: number,
): PreparedCommitEntry {
  const base = {
    path,
    expectedVersion,
    version,
    author: "author",
    message: "message",
    metaJson: "{}",
    createdAt: 1_002,
  };
  if (op === "rollback") return { ...base, op, toVersion: 1 };
  if (op === "copy") return { ...base, op, from: { path: "source.txt", version: 1 } };
  return { ...base, op };
}

function batchInput(stash: string, entries: PreparedCommitEntry[]): CommitBatchInput {
  return {
    row: {
      id: `cmt-${stash}`,
      stash_name: stash,
      source: "commit",
      source_id: null,
      author: "author",
      message: "message",
      meta_json: "{}",
      entry_count: entries.length,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: "request-hash",
      created_by: "test",
      created_at: 1_000,
    },
    entries,
  };
}

describe("commitBatch legacy statement shape", () => {
  it("pins existing caller SQL and bindings", () => {
    const cases: [string, PreparedCommitEntry[]][] = [
      ["text put create", [put("create.txt", null, 1)]],
      ["text put update", [put("update.txt", 3, 4)]],
      ["delete", [derived("delete", "delete.txt", 3, 4)]],
      ["rollback", [derived("rollback", "rollback.txt", 3, 4)]],
      ["copy", [derived("copy", "copy.txt", null, 1)]],
      [
        "three-path createCommit",
        [
          put("create.txt", null, 1),
          put("update.txt", 3, 4),
          derived("delete", "delete.txt", 3, 4),
        ],
      ],
    ];
    expect(
      cases.map(([name, entries]) => ({
        name,
        statements: captureStatements(batchInput(`shape-${name}`, entries)),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "name": "text put create",
          "statements": [
            {
              "params": [
                "cmt-shape-text put create",
                "shape-text put create",
                "commit",
                null,
                "author",
                "message",
                "{}",
                1,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-text put create",
                null,
                null,
                "shape-text put create",
                null,
                null,
                "shape-text put create",
                null,
                null,
                null,
                "[{"op":"put","path":"create.txt","expectedVersion":null}]",
                "shape-text put create",
                "shape-text put create",
                "shape-text put create",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-text put create",
                "sha256-create.txt-1",
                "body-1",
                null,
                4,
                1001,
                "shape-text put create",
                "cmt-shape-text put create",
              ],
              "sql": "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
                   SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                   ON CONFLICT(stash_name, hash) DO NOTHING",
            },
            {
              "params": [
                "shape-text put create",
                "create.txt",
                1,
                "sha256-create.txt-1",
                4,
                "text/plain; charset=utf-8",
                "author",
                "message",
                "{}",
                1001,
                "text",
                null,
                "legacy",
                "cmt-shape-text put create",
                "shape-text put create",
                "cmt-shape-text put create",
                "shape-text put create",
                "sha256-create.txt-1",
                4,
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
                 rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
               WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0) AND EXISTS (SELECT 1 FROM blobs
                WHERE stash_name = ? AND hash = ? AND size_bytes = ?
                  AND ((body IS NOT NULL AND r2_key IS NULL)
                    OR (body IS NULL AND r2_key IS NOT NULL)))",
            },
            {
              "params": [
                "shape-text put create",
                "create.txt",
                1,
                "shape-text put create",
                "create.txt",
                1,
                0,
                1001,
                1001,
                "shape-text put create",
                "cmt-shape-text put create",
                "shape-text put create",
                "create.txt",
                "shape-text put create",
                "create.txt",
                1,
              ],
              "sql": "INSERT INTO files
                (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
               SELECT ?, ?, ?, (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                 AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)
                 AND EXISTS (SELECT 1 FROM versions
                   WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"create.txt","version":1,"deleted":0}]",
                "shape-text put create",
                "cmt-shape-text put create",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
        {
          "name": "text put update",
          "statements": [
            {
              "params": [
                "cmt-shape-text put update",
                "shape-text put update",
                "commit",
                null,
                "author",
                "message",
                "{}",
                1,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-text put update",
                null,
                null,
                "shape-text put update",
                null,
                null,
                "shape-text put update",
                null,
                null,
                null,
                "[{"op":"put","path":"update.txt","expectedVersion":3}]",
                "shape-text put update",
                "shape-text put update",
                "shape-text put update",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-text put update",
                "sha256-update.txt-4",
                "body-4",
                null,
                4,
                1001,
                "shape-text put update",
                "cmt-shape-text put update",
              ],
              "sql": "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
                   SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                   ON CONFLICT(stash_name, hash) DO NOTHING",
            },
            {
              "params": [
                "shape-text put update",
                "update.txt",
                4,
                "sha256-update.txt-4",
                4,
                "text/plain; charset=utf-8",
                "author",
                "message",
                "{}",
                1001,
                "text",
                null,
                "legacy",
                "cmt-shape-text put update",
                "shape-text put update",
                "cmt-shape-text put update",
                "shape-text put update",
                "sha256-update.txt-4",
                4,
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
                 rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
               WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0) AND EXISTS (SELECT 1 FROM blobs
                WHERE stash_name = ? AND hash = ? AND size_bytes = ?
                  AND ((body IS NOT NULL AND r2_key IS NULL)
                    OR (body IS NULL AND r2_key IS NOT NULL)))",
            },
            {
              "params": [
                4,
                "shape-text put update",
                "update.txt",
                4,
                0,
                1001,
                "shape-text put update",
                "update.txt",
                3,
                "shape-text put update",
                "cmt-shape-text put update",
                "shape-text put update",
                "update.txt",
                4,
              ],
              "sql": "UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), deleted = ?, updated_at = ?
             WHERE stash_name = ? AND path = ? AND head_version = ? AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
               AND EXISTS (SELECT 1 FROM versions
                 WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"update.txt","version":4,"deleted":0}]",
                "shape-text put update",
                "cmt-shape-text put update",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
        {
          "name": "delete",
          "statements": [
            {
              "params": [
                "cmt-shape-delete",
                "shape-delete",
                "commit",
                null,
                "author",
                "message",
                "{}",
                1,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-delete",
                null,
                null,
                "shape-delete",
                null,
                null,
                "shape-delete",
                null,
                null,
                null,
                "[{"op":"delete","path":"delete.txt","expectedVersion":3}]",
                "shape-delete",
                "shape-delete",
                "shape-delete",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-delete",
                "delete.txt",
                4,
                "author",
                "message",
                "{}",
                1002,
                "cmt-shape-delete",
                "shape-delete",
                "delete.txt",
                3,
                "shape-delete",
                "cmt-shape-delete",
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
               rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'delete', NULL, 0, current.content_type, NULL, ?, ?, ?, ?,
                 current.representation, NULL, current.content_storage, ?, NULL, NULL
               FROM versions AS current
               WHERE current.stash_name = ? AND current.path = ? AND current.version = ?
                 AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)",
            },
            {
              "params": [
                4,
                "shape-delete",
                "delete.txt",
                4,
                1,
                1002,
                "shape-delete",
                "delete.txt",
                3,
                "shape-delete",
                "cmt-shape-delete",
                "shape-delete",
                "delete.txt",
                4,
              ],
              "sql": "UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), deleted = ?, updated_at = ?
             WHERE stash_name = ? AND path = ? AND head_version = ? AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
               AND EXISTS (SELECT 1 FROM versions
                 WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"delete.txt","version":4,"deleted":1}]",
                "shape-delete",
                "cmt-shape-delete",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
        {
          "name": "rollback",
          "statements": [
            {
              "params": [
                "cmt-shape-rollback",
                "shape-rollback",
                "commit",
                null,
                "author",
                "message",
                "{}",
                1,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-rollback",
                null,
                null,
                "shape-rollback",
                null,
                null,
                "shape-rollback",
                null,
                null,
                null,
                "[{"op":"rollback","path":"rollback.txt","expectedVersion":3,"toVersion":1}]",
                "shape-rollback",
                "shape-rollback",
                "shape-rollback",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-rollback",
                "rollback.txt",
                4,
                "author",
                "message",
                "{}",
                1002,
                "cmt-shape-rollback",
                "shape-rollback",
                "rollback.txt",
                1,
                "shape-rollback",
                "cmt-shape-rollback",
              ],
              "sql": "INSERT INTO versions
              (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
               rollback_of, author, message, meta_json, created_at, representation,
               application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
             SELECT ?, ?, ?, 'rollback', source.blob_hash, source.size_bytes, source.content_type,
               source.version, ?, ?, ?, ?, source.representation, source.application_etag,
               source.content_storage, ?, NULL, NULL
             FROM versions AS source
             WHERE source.stash_name = ? AND source.path = ? AND source.version = ?
               AND source.blob_hash IS NOT NULL AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)",
            },
            {
              "params": [
                4,
                "shape-rollback",
                "rollback.txt",
                4,
                0,
                1002,
                "shape-rollback",
                "rollback.txt",
                3,
                "shape-rollback",
                "cmt-shape-rollback",
                "shape-rollback",
                "rollback.txt",
                4,
              ],
              "sql": "UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), deleted = ?, updated_at = ?
             WHERE stash_name = ? AND path = ? AND head_version = ? AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
               AND EXISTS (SELECT 1 FROM versions
                 WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"rollback.txt","version":4,"deleted":0}]",
                "shape-rollback",
                "cmt-shape-rollback",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
        {
          "name": "copy",
          "statements": [
            {
              "params": [
                "cmt-shape-copy",
                "shape-copy",
                "commit",
                null,
                "author",
                "message",
                "{}",
                1,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-copy",
                null,
                null,
                "shape-copy",
                null,
                null,
                "shape-copy",
                null,
                null,
                null,
                "[{"op":"copy","path":"copy.txt","expectedVersion":null,"from":{"path":"source.txt","version":1}}]",
                "shape-copy",
                "shape-copy",
                "shape-copy",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-copy",
                "copy.txt",
                1,
                "author",
                "message",
                "{}",
                1002,
                "cmt-shape-copy",
                "shape-copy",
                "source.txt",
                1,
                "shape-copy",
                "cmt-shape-copy",
              ],
              "sql": "INSERT INTO versions
              (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
               rollback_of, author, message, meta_json, created_at, representation,
               application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
             SELECT ?, ?, ?, 'put', source.blob_hash, source.size_bytes, source.content_type,
               NULL, ?, ?, ?, ?, source.representation, source.application_etag,
               source.content_storage, ?, source.path, source.version
             FROM versions AS source
             WHERE source.stash_name = ? AND source.path = ? AND source.version = ?
               AND source.blob_hash IS NOT NULL AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)",
            },
            {
              "params": [
                "shape-copy",
                "copy.txt",
                1,
                "shape-copy",
                "copy.txt",
                1,
                0,
                1002,
                1002,
                "shape-copy",
                "cmt-shape-copy",
                "shape-copy",
                "copy.txt",
                "shape-copy",
                "copy.txt",
                1,
              ],
              "sql": "INSERT INTO files
                (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
               SELECT ?, ?, ?, (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                 AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)
                 AND EXISTS (SELECT 1 FROM versions
                   WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"copy.txt","version":1,"deleted":0}]",
                "shape-copy",
                "cmt-shape-copy",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
        {
          "name": "three-path createCommit",
          "statements": [
            {
              "params": [
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "commit",
                null,
                "author",
                "message",
                "{}",
                3,
                null,
                null,
                "request-hash",
                "test",
                1000,
                "shape-three-path createCommit",
                null,
                null,
                "shape-three-path createCommit",
                null,
                null,
                "shape-three-path createCommit",
                null,
                null,
                null,
                "[{"op":"put","path":"create.txt","expectedVersion":null},{"op":"put","path":"update.txt","expectedVersion":3},{"op":"delete","path":"delete.txt","expectedVersion":3}]",
                "shape-three-path createCommit",
                "shape-three-path createCommit",
                "shape-three-path createCommit",
              ],
              "sql": "INSERT INTO commits
              (id, stash_name, source, source_id, author, message, meta_json, entry_count,
               reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
               AND (
                 ? IS NULL
                 OR (
                   ? IS NULL
                   AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?
                 )
                 OR (
                   ? IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM versions
                     WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
                   )
                 )
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?) AS e
                 LEFT JOIN files AS f
                   ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
                 WHERE
                   (json_extract(e.value, '$.expectedVersion') IS NULL AND f.path IS NOT NULL)
                   OR
                   (json_extract(e.value, '$.expectedVersion') IS NOT NULL AND (
                     f.path IS NULL
                     OR f.head_version IS NULL
                     OR f.head_version <> json_extract(e.value, '$.expectedVersion')
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'delete' AND COALESCE(f.deleted, 1) = 1)
                   OR
                   (json_extract(e.value, '$.op') = 'rollback' AND NOT EXISTS (
                     SELECT 1 FROM versions AS target
                     WHERE target.stash_name = ?
                       AND target.path = json_extract(e.value, '$.path')
                       AND target.version = json_extract(e.value, '$.toVersion')
                       AND target.blob_hash IS NOT NULL
                   ))
                   OR
                   (json_extract(e.value, '$.op') = 'copy' AND NOT EXISTS (
                     SELECT 1 FROM versions AS source
                     WHERE source.stash_name = ?
                       AND source.path = json_extract(e.value, '$.from.path')
                       AND source.version = json_extract(e.value, '$.from.version')
                       AND source.blob_hash IS NOT NULL
                   ))
               )",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "sha256-create.txt-1",
                "body-1",
                null,
                4,
                1001,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
              ],
              "sql": "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
                   SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                   ON CONFLICT(stash_name, hash) DO NOTHING",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "create.txt",
                1,
                "sha256-create.txt-1",
                4,
                "text/plain; charset=utf-8",
                "author",
                "message",
                "{}",
                1001,
                "text",
                null,
                "legacy",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "sha256-create.txt-1",
                4,
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
                 rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
               WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0) AND EXISTS (SELECT 1 FROM blobs
                WHERE stash_name = ? AND hash = ? AND size_bytes = ?
                  AND ((body IS NOT NULL AND r2_key IS NULL)
                    OR (body IS NULL AND r2_key IS NOT NULL)))",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "create.txt",
                1,
                "shape-three-path createCommit",
                "create.txt",
                1,
                0,
                1001,
                1001,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "create.txt",
                "shape-three-path createCommit",
                "create.txt",
                1,
              ],
              "sql": "INSERT INTO files
                (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
               SELECT ?, ?, ?, (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                 AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)
                 AND EXISTS (SELECT 1 FROM versions
                   WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "sha256-update.txt-4",
                "body-4",
                null,
                4,
                1001,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
              ],
              "sql": "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
                   SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
                   ON CONFLICT(stash_name, hash) DO NOTHING",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "update.txt",
                4,
                "sha256-update.txt-4",
                4,
                "text/plain; charset=utf-8",
                "author",
                "message",
                "{}",
                1001,
                "text",
                null,
                "legacy",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "sha256-update.txt-4",
                4,
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
                 rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
               WHERE EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0) AND EXISTS (SELECT 1 FROM blobs
                WHERE stash_name = ? AND hash = ? AND size_bytes = ?
                  AND ((body IS NOT NULL AND r2_key IS NULL)
                    OR (body IS NULL AND r2_key IS NOT NULL)))",
            },
            {
              "params": [
                4,
                "shape-three-path createCommit",
                "update.txt",
                4,
                0,
                1001,
                "shape-three-path createCommit",
                "update.txt",
                3,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "update.txt",
                4,
              ],
              "sql": "UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), deleted = ?, updated_at = ?
             WHERE stash_name = ? AND path = ? AND head_version = ? AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
               AND EXISTS (SELECT 1 FROM versions
                 WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "shape-three-path createCommit",
                "delete.txt",
                4,
                "author",
                "message",
                "{}",
                1002,
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "delete.txt",
                3,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
              ],
              "sql": "INSERT INTO versions
                (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
               rollback_of, author, message, meta_json, created_at, representation,
                 application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
               SELECT ?, ?, ?, 'delete', NULL, 0, current.content_type, NULL, ?, ?, ?, ?,
                 current.representation, NULL, current.content_storage, ?, NULL, NULL
               FROM versions AS current
               WHERE current.stash_name = ? AND current.path = ? AND current.version = ?
                 AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)",
            },
            {
              "params": [
                4,
                "shape-three-path createCommit",
                "delete.txt",
                4,
                1,
                1002,
                "shape-three-path createCommit",
                "delete.txt",
                3,
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
                "shape-three-path createCommit",
                "delete.txt",
                4,
              ],
              "sql": "UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?), deleted = ?, updated_at = ?
             WHERE stash_name = ? AND path = ? AND head_version = ? AND EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)
               AND EXISTS (SELECT 1 FROM versions
                 WHERE stash_name = ? AND path = ? AND version = ?)",
            },
            {
              "params": [
                "[{"path":"create.txt","version":1,"deleted":0},{"path":"update.txt","version":4,"deleted":0},{"path":"delete.txt","version":4,"deleted":1}]",
                "shape-three-path createCommit",
                "cmt-shape-three-path createCommit",
              ],
              "sql": "UPDATE commits
             SET change_count = CASE WHEN
                   entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?) AS expected
                     LEFT JOIN files AS f
                       ON f.stash_name = commits.stash_name
                         AND f.path = json_extract(expected.value, '$.path')
                     WHERE f.path IS NULL
                       OR f.head_version <> json_extract(expected.value, '$.version')
                       OR f.deleted <> json_extract(expected.value, '$.deleted')
                       OR f.head_hash IS NOT (
                         SELECT committed.blob_hash FROM versions AS committed
                         WHERE committed.stash_name = commits.stash_name
                           AND committed.path = json_extract(expected.value, '$.path')
                           AND committed.version = json_extract(expected.value, '$.version')
                       )
                   )
                 THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
                 ELSE -1 END,
                 first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
                 last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
                 sealed = 1
             WHERE stash_name = ? AND id = ? AND sealed = 0",
            },
          ],
        },
      ]
    `);
  });
});

beforeEach(async () => {
  await resetDatabase();
});

describe("commitBatch sequential per-path chains", () => {
  async function run(input: CommitBatchInput): Promise<D1Result<unknown>[]> {
    return env.DB.batch(commitBatch(env.DB, input));
  }

  async function counts(stash: string) {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM commits WHERE stash_name = ?) AS commits,
         (SELECT COUNT(*) FROM versions WHERE stash_name = ?) AS versions,
         (SELECT COUNT(*) FROM files WHERE stash_name = ?) AS files,
         (SELECT COUNT(*) FROM blobs WHERE stash_name = ?) AS blobs`,
    )
      .bind(stash, stash, stash, stash)
      .first<{ commits: number; versions: number; files: number; blobs: number }>();
    if (!row) throw new Error("Missing table counts");
    return row;
  }

  it("commits a new put-put-delete chain with one final head", async () => {
    const stash = "sequential-new";
    await seedStash(stash);
    const input = batchInput(stash, [
      put("chain.txt", null, 1, 1_001),
      put("chain.txt", 1, 2, 1_002),
      { ...derived("delete", "chain.txt", 2, 3), createdAt: 1_003 },
    ]);

    const results = await run(input);

    expect(results.at(-1)?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT entry_count, change_count, sealed, first_change_id, last_change_id
         FROM commits WHERE id = ?`,
      )
        .bind(input.row.id)
        .first(),
    ).resolves.toMatchObject({ entry_count: 3, change_count: 3, sealed: 1 });
    const versions = await env.DB.prepare(
      `SELECT id, version, kind FROM versions WHERE commit_id = ? ORDER BY id`,
    )
      .bind(input.row.id)
      .all<{ id: number; version: number; kind: string }>();
    expect(versions.results.map(({ version, kind }) => ({ version, kind }))).toEqual([
      { version: 1, kind: "put" },
      { version: 2, kind: "put" },
      { version: 3, kind: "delete" },
    ]);
    expect(versions.results.map(({ id }) => id)).toEqual([
      versions.results[0]!.id,
      versions.results[0]!.id + 1,
      versions.results[0]!.id + 2,
    ]);
    await expect(
      env.DB.prepare(
        `SELECT head_version, head_hash, deleted, created_at, updated_at
         FROM files WHERE stash_name = ? AND path = ?`,
      )
        .bind(stash, "chain.txt")
        .first(),
    ).resolves.toEqual({
      head_version: 3,
      head_hash: null,
      deleted: 1,
      created_at: 1_001,
      updated_at: 1_003,
    });
  });

  it("writes no rows when the pre-batch head moved", async () => {
    const stash = "sequential-stale";
    await seedStash(stash);
    const seed = batchInput(stash, [put("chain.txt", null, 1)]);
    await run(seed);
    const moved = batchInput(stash, [put("chain.txt", 1, 2)]);
    moved.row.id = "cmt-sequential-stale-moved";
    await run(moved);
    const before = await counts(stash);
    const stale = batchInput(stash, [put("chain.txt", 1, 2), put("chain.txt", 2, 3)]);
    stale.row.id = "cmt-sequential-stale-loser";

    const results = await run(stale);

    expect(results.every(({ meta }) => meta.changes === 0)).toBe(true);
    expect(await counts(stash)).toEqual(before);
  });

  it("rolls back to an earlier entry in the same chain", async () => {
    const stash = "sequential-rollback";
    await seedStash(stash);
    const first = put("chain.txt", null, 1, 1_001);
    const input = batchInput(stash, [
      first,
      put("chain.txt", 1, 2, 1_002),
      { ...derived("rollback", "chain.txt", 2, 3), toVersion: 1, createdAt: 1_003 },
    ]);

    const results = await run(input);

    expect(results.at(-1)?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT version, kind, blob_hash, size_bytes, rollback_of
         FROM versions WHERE commit_id = ? ORDER BY version`,
      )
        .bind(input.row.id)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { version: 1, kind: "put", blob_hash: first.hash, size_bytes: first.size },
        { version: 2, kind: "put" },
        {
          version: 3,
          kind: "rollback",
          blob_hash: first.hash,
          size_bytes: first.size,
          rollback_of: 1,
        },
      ],
    });
  });

  it("rolls the whole batch back when an in-chain rollback targets a tombstone", async () => {
    const stash = "sequential-tombstone";
    await seedStash(stash);
    const input = batchInput(stash, [
      put("chain.txt", null, 1),
      derived("delete", "chain.txt", 1, 2),
      { ...derived("rollback", "chain.txt", 2, 3), toVersion: 2 },
    ]);

    await expect(run(input)).rejects.toThrow(/SQLITE_CONSTRAINT/su);
    await expect(counts(stash)).resolves.toEqual({ commits: 0, versions: 0, files: 0, blobs: 0 });
  });

  it("seals a chain mixed with an independent path", async () => {
    const stash = "sequential-mixed";
    await seedStash(stash);
    const input = batchInput(stash, [
      put("chain.txt", null, 1, 1_001),
      put("other.txt", null, 1, 1_002),
      put("chain.txt", 1, 2, 1_003),
    ]);

    const results = await run(input);

    expect(results.at(-1)?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT path, head_version, head_hash, deleted, created_at, updated_at
         FROM files WHERE stash_name = ? ORDER BY path`,
      )
        .bind(stash)
        .all(),
    ).resolves.toEqual({
      success: true,
      meta: expect.any(Object),
      results: [
        {
          path: "chain.txt",
          head_version: 2,
          head_hash: "sha256-chain.txt-2",
          deleted: 0,
          created_at: 1_001,
          updated_at: 1_003,
        },
        {
          path: "other.txt",
          head_version: 1,
          head_hash: "sha256-other.txt-1",
          deleted: 0,
          created_at: 1_002,
          updated_at: 1_002,
        },
      ],
    });
  });

  it.each([
    ["gap", [put("chain.txt", null, 1), put("chain.txt", 1, 3)]],
    ["wrong expected version", [put("chain.txt", null, 1), put("chain.txt", 2, 3)]],
    ["out of order", [put("chain.txt", 1, 2), put("chain.txt", null, 1)]],
    ["single jump", [put("chain.txt", 3, 5)]],
  ] as const)("rejects a non-contiguous %s before preparing SQL", (_, entries) => {
    expect(() => commitBatch(env.DB, batchInput("sequential-invalid", [...entries]))).toThrow(
      /not a contiguous version chain/u,
    );
  });
});
