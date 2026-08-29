import { pathPrefixRange } from "@takazudo/zudo-history-stash-core";
import type { ChangeSetEntryRow, ChangeSetRow } from "../schema.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

export const SELECT_CHANGE_SET = `
  SELECT cs.* FROM change_sets cs
  JOIN stashes s ON s.name = cs.stash_name AND s.deleted_at IS NULL
  WHERE cs.stash_name = ? AND cs.id = ? LIMIT 1
`;

export const SELECT_CHANGE_SET_BY_KEY = `
  SELECT cs.* FROM change_sets cs
  JOIN stashes s ON s.name = cs.stash_name AND s.deleted_at IS NULL
  WHERE cs.stash_name = ? AND cs.idempotency_key = ? LIMIT 1
`;

export const SELECT_CHANGE_SET_ENTRIES = `
  SELECT * FROM change_set_entries WHERE change_set_id = ? ORDER BY path
`;

export interface ListChangeSetSqlInput {
  stash: string;
  status: "open" | "applied" | "rejected" | "expired" | "all";
  path: string | null;
  now: number;
  after: { createdAt: number; id: string } | null;
  limit: number;
}

function statusPredicate(status: ListChangeSetSqlInput["status"]): string {
  if (status === "all") return "1 = 1";
  if (status === "open") return "cs.status = 'open' AND cs.expires_at > ?";
  if (status === "expired") return "cs.status = 'open' AND cs.expires_at <= ?";
  return "cs.status = ?";
}

function statusParams(input: ListChangeSetSqlInput): unknown[] {
  return input.status === "all"
    ? []
    : input.status === "open" || input.status === "expired"
      ? [input.now]
      : [input.status];
}

export function selectChangeSets(db: Preparer, input: ListChangeSetSqlInput): D1PreparedStatement {
  return db
    .prepare(
      `SELECT cs.* FROM change_sets cs
       JOIN stashes s ON s.name = cs.stash_name AND s.deleted_at IS NULL
       WHERE cs.stash_name = ? AND ${statusPredicate(input.status)}
         AND (? IS NULL OR cs.id IN (
           SELECT e.change_set_id FROM change_set_entries e
           WHERE e.stash_name = cs.stash_name AND e.path = ?
         ))
         AND (? IS NULL OR cs.created_at < ? OR (cs.created_at = ? AND cs.id < ?))
       ORDER BY cs.created_at DESC, cs.id DESC LIMIT ?`,
    )
    .bind(
      input.stash,
      ...statusParams(input),
      input.path,
      input.path,
      input.after?.id ?? null,
      input.after?.createdAt ?? null,
      input.after?.createdAt ?? null,
      input.after?.id ?? null,
      input.limit,
    );
}

export function countChangeSets(
  db: Preparer,
  input: Omit<ListChangeSetSqlInput, "after" | "limit">,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS total FROM change_sets cs
       JOIN stashes s ON s.name = cs.stash_name AND s.deleted_at IS NULL
       WHERE cs.stash_name = ? AND ${statusPredicate(input.status)}
         AND (? IS NULL OR cs.id IN (
           SELECT e.change_set_id FROM change_set_entries e
           WHERE e.stash_name = cs.stash_name AND e.path = ?
         ))`,
    )
    .bind(
      input.stash,
      ...statusParams({ ...input, after: null, limit: 1 }),
      input.path,
      input.path,
    );
}

export function insertChangeSetStatement(db: Preparer, row: ChangeSetRow): D1PreparedStatement {
  const prefixResult = pathPrefixRange(row.expected_last_change_prefix ?? undefined);
  if (!prefixResult.ok) throw new Error(prefixResult.message);
  const prefixRange = prefixResult.range;
  const expectedFence = `(? IS NULL
    OR (? IS NULL AND COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?)
    OR (? IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM versions WHERE stash_name = ? AND id > ? AND path >= ? AND path < ?
    )))`;
  const expectedParams = [
    row.expected_last_change_id,
    row.expected_last_change_prefix,
    row.stash_name,
    row.expected_last_change_id,
    row.expected_last_change_prefix,
    row.stash_name,
    row.expected_last_change_id,
    prefixRange?.lo ?? null,
    prefixRange?.hi ?? null,
  ];
  return db
    .prepare(
      `INSERT INTO change_sets
       (id, stash_name, status, author, message, meta_json, expires_at, created_by, created_at,
        idempotency_key, request_hash, expected_last_change_id, decision_attempt, decided_at,
        decided_by, decision_reason, commit_id, expected_last_change_prefix)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
         AND ${expectedFence}`,
    )
    .bind(
      row.id,
      row.stash_name,
      row.status,
      row.author,
      row.message,
      row.meta_json,
      row.expires_at,
      row.created_by,
      row.created_at,
      row.idempotency_key,
      row.request_hash,
      row.expected_last_change_id,
      row.decision_attempt,
      row.decided_at,
      row.decided_by,
      row.decision_reason,
      row.commit_id,
      row.expected_last_change_prefix,
      row.stash_name,
      ...expectedParams,
    );
}

export function insertEntryStatement(db: Preparer, row: ChangeSetEntryRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO change_set_entries
       (change_set_id, stash_name, path, op, base_version, blob_hash, content_storage,
        representation, content_type, size_bytes, rollback_to, copied_from_path,
        copied_from_version, application_etag)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM change_sets WHERE id = ? AND stash_name = ?)`,
    )
    .bind(
      row.change_set_id,
      row.stash_name,
      row.path,
      row.op,
      row.base_version,
      row.blob_hash,
      row.content_storage,
      row.representation,
      row.content_type,
      row.size_bytes,
      row.rollback_to,
      row.copied_from_path,
      row.copied_from_version,
      row.application_etag,
      row.change_set_id,
      row.stash_name,
    );
}

export interface ChangeSetDecisionSqlInput {
  stash: string;
  id: string;
  attempt: string;
  commitId: string;
  now: number;
  decidedBy: string;
  prefixLo: string | null;
  prefixHi: string | null;
}

/**
 * Claims an approval only while every persisted entry still agrees with durable state. The
 * COALESCE around the CASE is intentional: corrupt or incomplete nullable rows are refusals.
 */
export function claimChangeSetStatement(
  db: Preparer,
  input: ChangeSetDecisionSqlInput,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE change_sets
       SET status = 'applied', decision_attempt = ?, decided_at = ?, decided_by = ?,
         decision_reason = NULL, commit_id = ?
       WHERE stash_name = ? AND id = ? AND status = 'open' AND expires_at > ?
         AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
         AND (
           expected_last_change_id IS NULL
           OR (? IS NULL AND expected_last_change_id = COALESCE(
             (SELECT MAX(id) FROM versions WHERE stash_name = change_sets.stash_name), 0
           ))
           OR (? IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM versions
             WHERE stash_name = change_sets.stash_name
               AND id > change_sets.expected_last_change_id AND path >= ? AND path < ?
           ))
         )
         AND NOT EXISTS (
           SELECT 1
           FROM change_set_entries AS e
           LEFT JOIN files AS f
             ON f.stash_name = e.stash_name AND f.path = e.path
           WHERE e.change_set_id = change_sets.id
             AND (e.stash_name <> change_sets.stash_name OR COALESCE(CASE e.op
               WHEN 'put' THEN
                 (e.base_version IS NULL AND f.path IS NOT NULL)
                 OR (e.base_version IS NOT NULL AND (
                   f.path IS NULL OR f.head_version IS NULL OR f.head_version <> e.base_version
                 ))
                 OR e.blob_hash IS NULL OR e.size_bytes IS NULL
                 OR e.content_storage IS NULL OR e.representation IS NULL OR e.content_type IS NULL
                 OR CASE e.content_storage
                   WHEN 'legacy' THEN NOT EXISTS (
                     SELECT 1 FROM blobs AS stored
                     WHERE stored.stash_name = e.stash_name AND stored.hash = e.blob_hash
                       AND stored.size_bytes = e.size_bytes
                       AND ((stored.body IS NOT NULL AND stored.r2_key IS NULL)
                         OR (stored.body IS NULL AND stored.r2_key IS NOT NULL))
                   )
                   WHEN 'bytes' THEN NOT EXISTS (
                     SELECT 1 FROM byte_blobs AS stored
                     WHERE stored.stash_name = e.stash_name AND stored.hash = e.blob_hash
                       AND stored.size_bytes = e.size_bytes
                       AND ((stored.body_bytes IS NOT NULL AND stored.r2_key IS NULL)
                         OR (stored.body_bytes IS NULL AND stored.r2_key IS NOT NULL))
                   )
                   ELSE 1
                 END
               WHEN 'copy' THEN
                 (e.base_version IS NULL AND f.path IS NOT NULL)
                 OR (e.base_version IS NOT NULL AND (
                   f.path IS NULL OR f.head_version IS NULL OR f.head_version <> e.base_version
                 ))
                 OR NOT EXISTS (
                   SELECT 1 FROM versions AS source
                   WHERE source.stash_name = e.stash_name
                     AND source.path = e.copied_from_path
                     AND source.version = e.copied_from_version
                     AND source.blob_hash IS NOT NULL
                     AND CASE source.content_storage
                       WHEN 'legacy' THEN EXISTS (
                         SELECT 1 FROM blobs AS stored
                         WHERE stored.stash_name = source.stash_name AND stored.hash = source.blob_hash
                           AND stored.size_bytes = source.size_bytes
                           AND ((stored.body IS NOT NULL AND stored.r2_key IS NULL)
                             OR (stored.body IS NULL AND stored.r2_key IS NOT NULL))
                       )
                       WHEN 'bytes' THEN EXISTS (
                         SELECT 1 FROM byte_blobs AS stored
                         WHERE stored.stash_name = source.stash_name AND stored.hash = source.blob_hash
                           AND stored.size_bytes = source.size_bytes
                           AND ((stored.body_bytes IS NOT NULL AND stored.r2_key IS NULL)
                             OR (stored.body_bytes IS NULL AND stored.r2_key IS NOT NULL))
                       )
                       ELSE 0
                     END
                 )
               WHEN 'delete' THEN
                 f.path IS NULL OR f.head_version IS NULL OR f.head_version <> e.base_version
                   OR COALESCE(f.deleted, 1) = 1
               WHEN 'rollback' THEN
                 f.path IS NULL OR f.head_version IS NULL OR f.head_version <> e.base_version
                 OR NOT EXISTS (
                   SELECT 1 FROM versions AS target
                   WHERE target.stash_name = e.stash_name AND target.path = e.path
                     AND target.version = e.rollback_to AND target.blob_hash IS NOT NULL
                     AND CASE target.content_storage
                       WHEN 'legacy' THEN EXISTS (
                         SELECT 1 FROM blobs AS stored
                         WHERE stored.stash_name = target.stash_name AND stored.hash = target.blob_hash
                           AND stored.size_bytes = target.size_bytes
                           AND ((stored.body IS NOT NULL AND stored.r2_key IS NULL)
                             OR (stored.body IS NULL AND stored.r2_key IS NOT NULL))
                       )
                       WHEN 'bytes' THEN EXISTS (
                         SELECT 1 FROM byte_blobs AS stored
                         WHERE stored.stash_name = target.stash_name AND stored.hash = target.blob_hash
                           AND stored.size_bytes = target.size_bytes
                           AND ((stored.body_bytes IS NOT NULL AND stored.r2_key IS NULL)
                             OR (stored.body_bytes IS NULL AND stored.r2_key IS NOT NULL))
                       )
                       ELSE 0
                     END
                 )
               ELSE 1
             END, 1) = 1)
         )`,
    )
    .bind(
      input.attempt,
      input.now,
      input.decidedBy,
      input.commitId,
      input.stash,
      input.id,
      input.now,
      input.stash,
      input.prefixLo,
      input.prefixLo,
      input.prefixLo,
      input.prefixHi,
    );
}

export function rejectChangeSetStatement(
  db: Preparer,
  input: { stash: string; id: string; now: number; decidedBy: string; reason: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE change_sets SET status = 'rejected', decision_attempt = NULL, decided_at = ?,
         decided_by = ?, decision_reason = ?, commit_id = NULL
       WHERE stash_name = ? AND id = ? AND status = 'open'
         AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)`,
    )
    .bind(input.now, input.decidedBy, input.reason, input.stash, input.id, input.stash);
}
