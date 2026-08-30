import type { ChangeSetEntryRow, CommitRow } from "../schema.js";
import type { PreparedBlob } from "../blobs.js";
import type { PreparedByteWrite } from "../byte-writes.js";
import { insertLedger, type LedgerInsert, type SqlFragment } from "./write-primitives.js";

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
  expectedLastChangePrefixLo?: string;
  expectedLastChangePrefixHi?: string;
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
      input.expectedLastChangePrefixLo ?? null,
      row.stash_name,
      input.expectedLastChangeId ?? null,
      input.expectedLastChangePrefixLo ?? null,
      row.stash_name,
      input.expectedLastChangeId ?? null,
      input.expectedLastChangePrefixLo ?? null,
      input.expectedLastChangePrefixHi ?? null,
      JSON.stringify(input.entries),
      row.stash_name,
      row.stash_name,
      row.stash_name,
    );
}

export function commitFence(stash: string, id: string): SqlFragment {
  return {
    sql: "EXISTS (SELECT 1 FROM commits WHERE stash_name = ? AND id = ? AND sealed = 0)",
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
        representation: "text";
        hash: string;
        size: number;
        contentType: string;
      })
  | (PreparedCommitBase &
      PreparedByteWrite & {
        op: "put";
        representation: "binary";
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
  ledger?: LedgerInsert;
  expectedLastChangeId?: number;
  expectedLastChangePrefixLo?: string;
  expectedLastChangePrefixHi?: string;
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
  const storedBlob =
    entry.representation === "text"
      ? `EXISTS (SELECT 1 FROM blobs
          WHERE stash_name = ? AND hash = ? AND size_bytes = ?
            AND ((body IS NOT NULL AND r2_key IS NULL)
              OR (body IS NULL AND r2_key IS NOT NULL)))`
      : `EXISTS (SELECT 1 FROM byte_blobs
          WHERE stash_name = ? AND hash = ? AND size_bytes = ?
            AND ((body_bytes IS NOT NULL AND r2_key IS NULL)
              OR (body_bytes IS NULL AND r2_key IS NOT NULL)))`;
  const blobStatement =
    entry.representation === "text"
      ? db
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
          )
      : db
          .prepare(
            `INSERT INTO byte_blobs
              (stash_name, hash, body_bytes, r2_key, storage_generation, size_bytes, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${fence.sql}
             ON CONFLICT(stash_name, hash) DO NOTHING`,
          )
          .bind(
            input.row.stash_name,
            entry.hash,
            entry.bodyBytes,
            entry.r2Key,
            entry.storageGeneration,
            entry.size,
            entry.createdAt,
            ...fence.params,
          );
  return [
    blobStatement,
    db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at, representation,
           application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
         SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
         WHERE ${fence.sql} AND ${storedBlob}`,
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
        entry.representation,
        entry.representation === "binary" ? entry.hash : null,
        entry.representation === "binary" ? "bytes" : "legacy",
        input.row.id,
        ...fence.params,
        input.row.stash_name,
        entry.hash,
        entry.size,
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
           application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
         SELECT ?, ?, ?, 'delete', NULL, 0, current.content_type, NULL, ?, ?, ?, ?,
           current.representation, NULL, current.content_storage, ?, NULL, NULL
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
  const copiedFromPath = entry.op === "copy" ? "source.path" : "NULL";
  const copiedFromVersion = entry.op === "copy" ? "source.version" : "NULL";
  return db
    .prepare(
      `INSERT INTO versions
        (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
         rollback_of, author, message, meta_json, created_at, representation,
         application_etag, content_storage, commit_id, copied_from_path, copied_from_version)
       SELECT ?, ?, ?, '${kind}', source.blob_hash, source.size_bytes, source.content_type,
         ${rollbackOf}, ?, ?, ?, ?, source.representation, source.application_etag,
         source.content_storage, ?, ${copiedFromPath}, ${copiedFromVersion}
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
      ...(input.expectedLastChangePrefixLo === undefined
        ? {}
        : {
            expectedLastChangePrefixLo: input.expectedLastChangePrefixLo,
            expectedLastChangePrefixHi: input.expectedLastChangePrefixHi,
          }),
    }),
  ];
  for (const entry of input.entries) {
    if (entry.op === "put") statements.push(...putEntryStatements(db, input, entry));
    else statements.push(derivedEntryStatement(db, input, entry));
    statements.push(headStatement(db, input, entry));
  }
  // This ledger statement may sit here only because it is fenced on position-independent commitFence(stash, id), not the operation fence; an operation fence here would write zero rows and break idempotent replay.
  if (input.ledger) {
    const entry = input.entries[0];
    if (input.entries.length !== 1 || !entry) {
      throw new Error("Commit batch ledger requires exactly one entry");
    }
    statements.push(
      insertLedger(db, {
        stash: input.row.stash_name,
        path: entry.path,
        version: entry.version,
        createdAt: entry.createdAt,
        ledger: input.ledger,
        operationFence: commitFence(input.row.stash_name, input.row.id),
      }),
    );
  }
  statements.push(commitSealStatement(db, input));
  return statements;
}

/**
 * Sealing is the final aggregate invariant. Once the gate inserted the commit, every generated
 * version and file-head write must be visible or the existing commits CHECK is intentionally
 * violated so D1 rolls the whole batch back.
 */
function commitSealStatement(db: Preparer, input: CommitBatchInput): D1PreparedStatement {
  const expectedHeads = input.entries.map((entry) => ({
    path: entry.path,
    version: entry.version,
    deleted: entry.op === "delete" ? 1 : 0,
  }));
  return db
    .prepare(
      `UPDATE commits
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
       WHERE stash_name = ? AND id = ? AND sealed = 0`,
    )
    .bind(JSON.stringify(expectedHeads), input.row.stash_name, input.row.id);
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

export interface ChangeSetCommitBatchInput {
  row: CommitInsertRow;
  changeSetId: string;
  attempt: string;
  entries: ChangeSetEntryRow[];
}

function changeSetFence(input: ChangeSetCommitBatchInput): SqlFragment {
  return {
    sql: `EXISTS (SELECT 1 FROM change_sets
      WHERE stash_name = ? AND id = ? AND status = 'applied' AND decision_attempt = ?)`,
    params: [input.row.stash_name, input.changeSetId, input.attempt],
  };
}

function changeSetVersionStatement(
  db: Preparer,
  input: ChangeSetCommitBatchInput,
  entry: ChangeSetEntryRow,
): D1PreparedStatement {
  const fence = changeSetFence(input);
  const commonColumns = `(stash_name, path, version, kind, blob_hash, size_bytes, content_type,
    rollback_of, author, message, meta_json, created_at, representation, application_etag,
    content_storage, commit_id, copied_from_path, copied_from_version)`;
  if (entry.op === "put") {
    return db
      .prepare(
        `INSERT INTO versions ${commonColumns}
         SELECT e.stash_name, e.path, COALESCE(e.base_version, 0) + 1, 'put', e.blob_hash,
           e.size_bytes, e.content_type, NULL, ?, ?, ?, ?, e.representation,
           e.application_etag, e.content_storage, ?, NULL, NULL
         FROM change_set_entries AS e
         WHERE e.change_set_id = ? AND e.stash_name = ? AND e.path = ? AND e.op = ?
           AND ${fence.sql}
           AND e.blob_hash IS NOT NULL AND e.size_bytes IS NOT NULL
           AND e.content_type IS NOT NULL AND e.representation IS NOT NULL
           AND e.content_storage IS NOT NULL`,
      )
      .bind(
        input.row.author,
        input.row.message,
        input.row.meta_json,
        input.row.created_at,
        input.row.id,
        input.changeSetId,
        input.row.stash_name,
        entry.path,
        entry.op,
        ...fence.params,
      );
  }
  if (entry.op === "delete") {
    return db
      .prepare(
        `INSERT INTO versions ${commonColumns}
         SELECT e.stash_name, e.path, e.base_version + 1, 'delete', NULL, 0,
           current.content_type, NULL, ?, ?, ?, ?, current.representation, NULL,
           current.content_storage, ?, NULL, NULL
         FROM change_set_entries AS e
         JOIN versions AS current ON current.stash_name = e.stash_name
           AND current.path = e.path AND current.version = e.base_version
         WHERE e.change_set_id = ? AND e.stash_name = ? AND e.path = ? AND e.op = ?
           AND ${fence.sql}`,
      )
      .bind(
        input.row.author,
        input.row.message,
        input.row.meta_json,
        input.row.created_at,
        input.row.id,
        input.changeSetId,
        input.row.stash_name,
        entry.path,
        entry.op,
        ...fence.params,
      );
  }
  const sourcePath = entry.op === "copy" ? "e.copied_from_path" : "e.path";
  const sourceVersion = entry.op === "copy" ? "e.copied_from_version" : "e.rollback_to";
  const kind = entry.op === "rollback" ? "rollback" : "put";
  const rollbackOf = entry.op === "rollback" ? "source.version" : "NULL";
  const copiedPath = entry.op === "copy" ? "source.path" : "NULL";
  const copiedVersion = entry.op === "copy" ? "source.version" : "NULL";
  return db
    .prepare(
      `INSERT INTO versions ${commonColumns}
       SELECT e.stash_name, e.path, COALESCE(e.base_version, 0) + 1, '${kind}',
         source.blob_hash, source.size_bytes, source.content_type, ${rollbackOf}, ?, ?, ?, ?,
         source.representation, source.application_etag, source.content_storage, ?,
         ${copiedPath}, ${copiedVersion}
       FROM change_set_entries AS e
       JOIN versions AS source ON source.stash_name = e.stash_name
         AND source.path = ${sourcePath} AND source.version = ${sourceVersion}
       WHERE e.change_set_id = ? AND e.stash_name = ? AND e.path = ? AND e.op = ?
         AND source.blob_hash IS NOT NULL
         AND ${fence.sql}`,
    )
    .bind(
      input.row.author,
      input.row.message,
      input.row.meta_json,
      input.row.created_at,
      input.row.id,
      input.changeSetId,
      input.row.stash_name,
      entry.path,
      entry.op,
      ...fence.params,
    );
}

function changeSetHeadStatement(
  db: Preparer,
  input: ChangeSetCommitBatchInput,
  entry: ChangeSetEntryRow,
): D1PreparedStatement {
  const fence = changeSetFence(input);
  if (entry.base_version === null) {
    return db
      .prepare(
        `INSERT INTO files (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
         SELECT e.stash_name, e.path, 1, committed.blob_hash,
           CASE WHEN e.op = 'delete' THEN 1 ELSE 0 END, ?, ?
         FROM change_set_entries AS e
         JOIN versions AS committed ON committed.stash_name = e.stash_name
           AND committed.path = e.path AND committed.version = 1 AND committed.commit_id = ?
         WHERE e.change_set_id = ? AND e.path = ? AND ${fence.sql}
           AND NOT EXISTS (SELECT 1 FROM files AS existing
             WHERE existing.stash_name = e.stash_name AND existing.path = e.path)`,
      )
      .bind(
        input.row.created_at,
        input.row.created_at,
        input.row.id,
        input.changeSetId,
        entry.path,
        ...fence.params,
      );
  }
  return db
    .prepare(
      `UPDATE files SET
         head_version = (SELECT e.base_version + 1 FROM change_set_entries AS e
           WHERE e.change_set_id = ? AND e.path = ?),
         head_hash = (SELECT committed.blob_hash FROM versions AS committed
           WHERE committed.stash_name = ? AND committed.path = ?
             AND committed.version = ? AND committed.commit_id = ?),
         deleted = (SELECT CASE WHEN e.op = 'delete' THEN 1 ELSE 0 END
           FROM change_set_entries AS e WHERE e.change_set_id = ? AND e.path = ?),
         updated_at = ?
       WHERE stash_name = ? AND path = ? AND head_version = ? AND ${fence.sql}
         AND EXISTS (SELECT 1 FROM versions AS committed
           WHERE committed.stash_name = ? AND committed.path = ?
             AND committed.version = ? AND committed.commit_id = ?)`,
    )
    .bind(
      input.changeSetId,
      entry.path,
      input.row.stash_name,
      entry.path,
      entry.base_version + 1,
      input.row.id,
      input.changeSetId,
      entry.path,
      input.row.created_at,
      input.row.stash_name,
      entry.path,
      entry.base_version,
      ...fence.params,
      input.row.stash_name,
      entry.path,
      entry.base_version + 1,
      input.row.id,
    );
}

function changeSetSealStatement(
  db: Preparer,
  input: ChangeSetCommitBatchInput,
): D1PreparedStatement {
  const fence = changeSetFence(input);
  return db
    .prepare(
      `UPDATE commits
       SET change_count = CASE WHEN
             entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
             AND entry_count = (SELECT COUNT(*) FROM change_set_entries WHERE change_set_id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM change_set_entries AS e
               LEFT JOIN versions AS committed ON committed.stash_name = e.stash_name
                 AND committed.path = e.path AND committed.version = COALESCE(e.base_version, 0) + 1
                 AND committed.commit_id = commits.id
               LEFT JOIN files AS f ON f.stash_name = e.stash_name AND f.path = e.path
               WHERE e.change_set_id = ? AND (
                 e.stash_name <> commits.stash_name OR committed.id IS NULL OR f.path IS NULL
                 OR f.head_version <> committed.version
                 OR f.deleted <> CASE WHEN e.op = 'delete' THEN 1 ELSE 0 END
                 OR f.head_hash IS NOT committed.blob_hash
               )
             )
           THEN (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
           ELSE -1 END,
           first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
           last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
           sealed = 1
       WHERE stash_name = ? AND id = ? AND sealed = 0 AND ${fence.sql}`,
    )
    .bind(
      input.changeSetId,
      input.changeSetId,
      input.row.stash_name,
      input.row.id,
      ...fence.params,
    );
}

/** The claim is first and the seal is last; any failed derived write trips the seal CHECK. */
export function changeSetCommitBatch(
  db: Preparer,
  input: ChangeSetCommitBatchInput,
  claim: D1PreparedStatement,
): D1PreparedStatement[] {
  if (input.entries.length === 0) throw new Error("Change-set commit requires entries");
  const fence = changeSetFence(input);
  const statements: D1PreparedStatement[] = [
    claim,
    db
      .prepare(
        `INSERT INTO commits
          (id, stash_name, source, source_id, author, message, meta_json, entry_count,
           reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
         SELECT ?, ?, 'change-set', ?, ?, ?, ?,
           (SELECT COUNT(*) FROM change_set_entries WHERE change_set_id = ?),
           NULL, NULL, NULL, ?, ? WHERE ${fence.sql}`,
      )
      .bind(
        input.row.id,
        input.row.stash_name,
        input.changeSetId,
        input.row.author,
        input.row.message,
        input.row.meta_json,
        input.changeSetId,
        input.row.created_by,
        input.row.created_at,
        ...fence.params,
      ),
  ];
  for (const entry of input.entries) {
    statements.push(changeSetVersionStatement(db, input, entry));
    statements.push(changeSetHeadStatement(db, input, entry));
  }
  statements.push(changeSetSealStatement(db, input));
  return statements;
}
