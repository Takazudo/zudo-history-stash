import type { CommitRow } from "../schema.js";
import type { PreparedBlob } from "../blobs.js";
import type { SqlFragment } from "./writes.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

export type CommitInsertRow = Omit<
  CommitRow,
  "change_count" | "sealed" | "first_change_id" | "last_change_id"
>;

export function mintCommitId(now: number, createId: () => string): string {
  const timestamp = String(now).padStart(13, "0");
  let hash = 0x811c9dc5;
  for (const character of createId()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  const randomHex = (hash >>> 0).toString(16).padStart(8, "0");
  return `cmt_${timestamp}${randomHex}`;
}

export function commitInsertStatement(
  db: Preparer,
  row: CommitInsertRow,
  fence: SqlFragment,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO commits
        (id, stash_name, source, source_id, author, message, meta_json, entry_count,
         reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.sql}`,
    )
    .bind(
      row.id,
      row.stash_name,
      row.source,
      row.source_id,
      row.author,
      row.message,
      row.meta_json,
      row.entry_count,
      row.reverts_commit_id,
      row.idempotency_key,
      row.request_hash,
      row.created_by,
      row.created_at,
      ...fence.params,
    );
}

export interface CommitGateEntry {
  op: "put" | "copy" | "delete" | "rollback";
  path: string;
  expectedVersion: number | null;
  toVersion?: number;
  from?: { path: string; version: number };
}

export interface CommitGateInput {
  row: CommitInsertRow;
  entries: CommitGateEntry[];
  expectedLastChangeId?: number;
}

/**
 * The entry list is deliberately one JSON binding. The number of SQLite parameters therefore
 * remains constant as MAX_COMMIT_ENTRIES changes, and an absent LEFT JOIN row is an explicit
 * refusal for every operation except create.
 */
export function commitGateStatement(db: Preparer, input: CommitGateInput): D1PreparedStatement {
  const row = input.row;
  return db
    .prepare(
      `INSERT INTO commits
        (id, stash_name, source, source_id, author, message, meta_json, entry_count,
         reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
         AND (? IS NULL OR COALESCE(
           (SELECT MAX(id) FROM versions WHERE stash_name = ?), 0
         ) = ?)
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
         )`,
    )
    .bind(
      row.id,
      row.stash_name,
      row.source,
      row.source_id,
      row.author,
      row.message,
      row.meta_json,
      row.entry_count,
      row.reverts_commit_id,
      row.idempotency_key,
      row.request_hash,
      row.created_by,
      row.created_at,
      row.stash_name,
      input.expectedLastChangeId ?? null,
      row.stash_name,
      input.expectedLastChangeId ?? null,
      JSON.stringify(input.entries),
      row.stash_name,
      row.stash_name,
      row.stash_name,
    );
}

export function commitFence(stash: string, id: string): SqlFragment {
  return {
    sql: "EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ?)",
    params: [stash, id],
  };
}

interface PreparedCommitBase {
  op: CommitGateEntry["op"];
  path: string;
  expectedVersion: number | null;
  version: number;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
}

export type PreparedCommitEntry =
  | (PreparedCommitBase &
      PreparedBlob & {
        op: "put";
        hash: string;
        size: number;
        contentType: string;
      })
  | (PreparedCommitBase & { op: "copy"; from: { path: string; version: number } })
  | (PreparedCommitBase & { op: "delete" })
  | (PreparedCommitBase & { op: "rollback"; toVersion: number });

export interface CommitBatchInput {
  row: CommitInsertRow;
  entries: PreparedCommitEntry[];
  expectedLastChangeId?: number;
}

function entryFence(input: CommitBatchInput): SqlFragment {
  return commitFence(input.row.stash_name, input.row.id);
}

function putEntryStatements(
  db: Preparer,
  input: CommitBatchInput,
  entry: Extract<PreparedCommitEntry, { op: "put" }>,
): D1PreparedStatement[] {
  const fence = entryFence(input);
  return [
    db
      .prepare(
        `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${fence.sql}
         ON CONFLICT(stash_name, hash) DO NOTHING`,
      )
      .bind(
        input.row.stash_name,
        entry.hash,
        entry.body,
        entry.r2_key,
        entry.size,
        entry.createdAt,
        ...fence.params,
      ),
    db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at, commit_id)
         SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${fence.sql}`,
      )
      .bind(
        input.row.stash_name,
        entry.path,
        entry.version,
        entry.hash,
        entry.size,
        entry.contentType,
        entry.author,
        entry.message,
        entry.metaJson,
        entry.createdAt,
        input.row.id,
        ...fence.params,
      ),
  ];
}

function derivedEntryStatement(
  db: Preparer,
  input: CommitBatchInput,
  entry: Exclude<PreparedCommitEntry, { op: "put" }>,
): D1PreparedStatement {
  const fence = entryFence(input);
  if (entry.op === "delete") {
    return db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at, representation,
           application_etag, content_storage, commit_id)
         SELECT ?, ?, ?, 'delete', NULL, 0, current.content_type, NULL, ?, ?, ?, ?,
           current.representation, NULL, current.content_storage, ?
         FROM versions AS current
         WHERE current.stash_name = ? AND current.path = ? AND current.version = ?
           AND ${fence.sql}`,
      )
      .bind(
        input.row.stash_name,
        entry.path,
        entry.version,
        entry.author,
        entry.message,
        entry.metaJson,
        entry.createdAt,
        input.row.id,
        input.row.stash_name,
        entry.path,
        entry.expectedVersion,
        ...fence.params,
      );
  }
  const source = entry.op === "copy" ? entry.from : { path: entry.path, version: entry.toVersion };
  const kind = entry.op === "rollback" ? "rollback" : "put";
  const rollbackOf = entry.op === "rollback" ? "source.version" : "NULL";
  return db
    .prepare(
      `INSERT INTO versions
        (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
         rollback_of, author, message, meta_json, created_at, representation,
         application_etag, content_storage, commit_id)
       SELECT ?, ?, ?, '${kind}', source.blob_hash, source.size_bytes, source.content_type,
         ${rollbackOf}, ?, ?, ?, ?, source.representation, source.application_etag,
         source.content_storage, ?
       FROM versions AS source
       WHERE source.stash_name = ? AND source.path = ? AND source.version = ?
         AND source.blob_hash IS NOT NULL AND ${fence.sql}`,
    )
    .bind(
      input.row.stash_name,
      entry.path,
      entry.version,
      entry.author,
      entry.message,
      entry.metaJson,
      entry.createdAt,
      input.row.id,
      input.row.stash_name,
      source.path,
      source.version,
      ...fence.params,
    );
}

function headStatement(
  db: Preparer,
  input: CommitBatchInput,
  entry: PreparedCommitEntry,
): D1PreparedStatement {
  const fence = entryFence(input);
  const hash = `(SELECT blob_hash FROM versions WHERE stash_name = ? AND path = ? AND version = ?)`;
  const deleted = entry.op === "delete" ? 1 : 0;
  if (entry.expectedVersion === null) {
    return db
      .prepare(
        `INSERT INTO files
          (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
         SELECT ?, ?, ?, ${hash}, ?, ?, ? WHERE ${fence.sql}
           AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)
           AND EXISTS (SELECT 1 FROM versions
             WHERE stash_name = ? AND path = ? AND version = ?)`,
      )
      .bind(
        input.row.stash_name,
        entry.path,
        entry.version,
        input.row.stash_name,
        entry.path,
        entry.version,
        deleted,
        entry.createdAt,
        entry.createdAt,
        ...fence.params,
        input.row.stash_name,
        entry.path,
        input.row.stash_name,
        entry.path,
        entry.version,
      );
  }
  return db
    .prepare(
      `UPDATE files SET head_version = ?, head_hash = ${hash}, deleted = ?, updated_at = ?
       WHERE stash_name = ? AND path = ? AND head_version = ? AND ${fence.sql}
         AND EXISTS (SELECT 1 FROM versions
           WHERE stash_name = ? AND path = ? AND version = ?)`,
    )
    .bind(
      entry.version,
      input.row.stash_name,
      entry.path,
      entry.version,
      deleted,
      entry.createdAt,
      input.row.stash_name,
      entry.path,
      entry.expectedVersion,
      ...fence.params,
      input.row.stash_name,
      entry.path,
      entry.version,
    );
}

export function commitBatch(db: Preparer, input: CommitBatchInput): D1PreparedStatement[] {
  if (input.entries.length === 0 || input.entries.length !== input.row.entry_count) {
    throw new Error("Commit batch entry count mismatch");
  }
  const gateEntries: CommitGateEntry[] = input.entries.map((entry) => ({
    op: entry.op,
    path: entry.path,
    expectedVersion: entry.expectedVersion,
    ...(entry.op === "rollback" ? { toVersion: entry.toVersion } : {}),
    ...(entry.op === "copy" ? { from: entry.from } : {}),
  }));
  const statements: D1PreparedStatement[] = [
    commitGateStatement(db, {
      row: input.row,
      entries: gateEntries,
      ...(input.expectedLastChangeId === undefined
        ? {}
        : { expectedLastChangeId: input.expectedLastChangeId }),
    }),
  ];
  for (const entry of input.entries) {
    if (entry.op === "put") statements.push(...putEntryStatements(db, input, entry));
    else statements.push(derivedEntryStatement(db, input, entry));
    statements.push(headStatement(db, input, entry));
  }
  statements.push(sealStatement(db, { stash: input.row.stash_name, id: input.row.id }));
  return statements;
}

export function sealStatement(
  db: Preparer,
  input: { stash: string; id: string; extraPredicate?: SqlFragment },
): D1PreparedStatement {
  const extra = input.extraPredicate;
  return db
    .prepare(
      `UPDATE commits
       SET change_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id),
           first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
           last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
           sealed = 1
       WHERE stash_name = ? AND id = ? AND sealed = 0
         AND entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
         ${extra ? `AND (${extra.sql})` : ""}`,
    )
    .bind(input.stash, input.id, ...(extra?.params ?? []));
}

export const SELECT_COMMIT_VERSIONS = `
  SELECT id, path, version, kind
  FROM versions
  WHERE stash_name = ? AND commit_id = ?
  ORDER BY id
`;
