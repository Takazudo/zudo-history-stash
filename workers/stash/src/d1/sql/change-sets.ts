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
  const expectedFence =
    row.expected_last_change_id === null
      ? "1 = 1"
      : "COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?";
  const expectedParams =
    row.expected_last_change_id === null ? [] : [row.stash_name, row.expected_last_change_id];
  return db
    .prepare(
      `INSERT INTO change_sets
       (id, stash_name, status, author, message, meta_json, expires_at, created_by, created_at,
        idempotency_key, request_hash, expected_last_change_id, decision_attempt, decided_at,
        decided_by, decision_reason, commit_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
