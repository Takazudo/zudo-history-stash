import type { GcJobKind } from "../schema.js";

type Preparer = Pick<D1Database | D1DatabaseSession, "prepare">;

export const acquireLease = `
  UPDATE gc_jobs
  SET lease_owner = ?,
      lease_generation = lease_generation + 1,
      lease_until = ?,
      updated_at = ?
  WHERE kind = ? AND (lease_until IS NULL OR lease_until <= ?)
  RETURNING kind, next_cursor, lease_owner, lease_generation, lease_until, updated_at
`;

export const insertRun = `
  INSERT INTO gc_runs
    (id, job_kind, lease_generation, dry_run, input_cursor, started_at)
  SELECT ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM gc_jobs
    WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
  )
`;

export const heartbeatLease = `
  UPDATE gc_jobs
  SET lease_until = ?, updated_at = ?
  WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
`;

export const releaseLease = `
  UPDATE gc_jobs
  SET lease_owner = NULL, lease_until = NULL, updated_at = ?
  WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
`;

export interface FinishRunInput {
  kind: GcJobKind;
  owner: string;
  generation: number;
  runId: string;
  persistCursor: boolean;
  nextCursor: string | null;
  scanned: number;
  eligible: number;
  deleted: number;
  error: string | null;
  finishedAt: number;
}

export function finishRunBatch(db: Preparer, input: FinishRunInput): D1PreparedStatement[] {
  const fence = `EXISTS (
    SELECT 1 FROM gc_jobs
    WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
  )`;
  const fenceParams = [input.kind, input.owner, input.generation];
  const finalizedRun = `EXISTS (
    SELECT 1 FROM gc_runs
    WHERE id = ? AND job_kind = ? AND lease_generation = ? AND finished_at = ?
  )`;
  const finalizedRunParams = [input.runId, input.kind, input.generation, input.finishedAt];
  return [
    db
      .prepare(
        `UPDATE gc_runs
         SET next_cursor = ?, scanned = ?, eligible = ?, deleted = ?, error = ?, finished_at = ?
         WHERE id = ? AND job_kind = ? AND lease_generation = ? AND ${fence}`,
      )
      .bind(
        input.nextCursor,
        input.scanned,
        input.eligible,
        input.deleted,
        input.error,
        input.finishedAt,
        input.runId,
        input.kind,
        input.generation,
        ...fenceParams,
      ),
    ...(input.persistCursor
      ? [
          db
            .prepare(
              `UPDATE gc_jobs SET next_cursor = ?, updated_at = ?
               WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
                 AND ${finalizedRun}`,
            )
            .bind(
              input.nextCursor,
              input.finishedAt,
              input.kind,
              input.owner,
              input.generation,
              ...finalizedRunParams,
            ),
        ]
      : []),
    db
      .prepare(
        `DELETE FROM gc_runs
         WHERE job_kind = ? AND id NOT IN (
           SELECT id FROM gc_runs WHERE job_kind = ?
           ORDER BY started_at DESC, id DESC LIMIT 500
         ) AND ${fence} AND ${finalizedRun}`,
      )
      .bind(input.kind, input.kind, ...fenceParams, ...finalizedRunParams),
    db
      .prepare(
        `UPDATE gc_jobs
         SET lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
           AND ${finalizedRun}`,
      )
      .bind(input.finishedAt, input.kind, input.owner, input.generation, ...finalizedRunParams),
  ];
}

export const selectReferencedR2Keys = `
  SELECT r2_key FROM blobs WHERE r2_key IN (__PLACEHOLDERS__)
  UNION SELECT r2_key FROM byte_blobs WHERE r2_key IN (__PLACEHOLDERS__)
  UNION SELECT objects.object_key AS r2_key
    FROM upload_objects objects
    JOIN upload_sessions sessions ON sessions.id = objects.session_id
      AND sessions.attempt_generation = objects.generation
    WHERE objects.object_key IN (__PLACEHOLDERS__)
      AND sessions.state IN ('open','uploaded','finalizing')
`;

export const selectLedgerPage = `
  SELECT rowid, created_at
  FROM idempotency
  WHERE created_at < ?
    AND (created_at > ? OR (created_at = ? AND rowid > ?))
  ORDER BY created_at, rowid
  LIMIT ?
`;

export const D1_MAX_BOUND_PARAMS = 100;
export const LEDGER_DELETE_ROW_CHUNK_SIZE = D1_MAX_BOUND_PARAMS - 1;

export function deleteLedgerRows(
  db: Preparer,
  rows: readonly { rowid: number; created_at: number }[],
  cutoff: number,
): D1PreparedStatement[] {
  if (rows.length === 0) throw new Error("deleteLedgerRows requires at least one row");
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += LEDGER_DELETE_ROW_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + LEDGER_DELETE_ROW_CHUNK_SIZE);
    statements.push(
      db
        .prepare(
          `DELETE FROM idempotency
           WHERE created_at < ? AND rowid IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(cutoff, ...chunk.map(({ rowid }) => rowid)),
    );
  }
  return statements;
}

export type ContentTable = "blobs" | "byte_blobs";

export interface ContentRow {
  rowid: number;
  stash_name: string;
  hash: string;
}

function unreferencedPredicate(table: ContentTable): string {
  const contentStorage = table === "blobs" ? "legacy" : "bytes";
  // This predicate owns exactly two placeholders, in order: content age cutoff,
  // then change-set liveness cutoff.
  return `${table}.created_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM versions v
      WHERE v.stash_name = ${table}.stash_name
        AND v.blob_hash = ${table}.hash
        AND v.content_storage = '${contentStorage}'
    )
    AND NOT EXISTS (
      SELECT 1 FROM change_set_entries e
      JOIN change_sets cs ON cs.id = e.change_set_id
      WHERE e.stash_name = ${table}.stash_name
        AND e.blob_hash = ${table}.hash
        AND cs.status = 'open'
        AND cs.expires_at > ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM upload_sessions s
      WHERE s.stash_name = ${table}.stash_name
        AND s.state IN ('open','uploaded','finalizing')
        AND (s.uploaded_hash = ${table}.hash OR s.declared_hash = ${table}.hash)
    )`;
}

export function selectContentPage(table: ContentTable): string {
  return `SELECT rowid, stash_name, hash
    FROM ${table}
    WHERE ${unreferencedPredicate(table)}
      AND (stash_name > ? OR (stash_name = ? AND hash > ?))
    ORDER BY stash_name, hash
    LIMIT ?`;
}

export const CONTENT_DELETE_ROW_CHUNK_SIZE = D1_MAX_BOUND_PARAMS - 5;

export function buildContentDeletes(
  db: Preparer,
  input: {
    table: ContentTable;
    rows: readonly ContentRow[];
    contentCutoff: number;
    changeSetCutoff: number;
    kind: GcJobKind;
    owner: string;
    generation: number;
  },
): D1PreparedStatement[] {
  if (input.rows.length === 0) throw new Error("buildContentDeletes requires at least one row");
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < input.rows.length; offset += CONTENT_DELETE_ROW_CHUNK_SIZE) {
    const chunk = input.rows.slice(offset, offset + CONTENT_DELETE_ROW_CHUNK_SIZE);
    statements.push(
      db
        .prepare(
          `DELETE FROM ${input.table}
           WHERE rowid IN (${chunk.map(() => "?").join(", ")})
             AND ${unreferencedPredicate(input.table)}
             AND EXISTS (
               SELECT 1 FROM gc_jobs
               WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
             )`,
        )
        .bind(
          ...chunk.map(({ rowid }) => rowid),
          input.contentCutoff,
          input.changeSetCutoff,
          input.kind,
          input.owner,
          input.generation,
        ),
    );
  }
  return statements;
}

export type ChangeSetPhase = "expired" | "rejected";

export interface ChangeSetRetentionRow {
  id: string;
}

function retentionPredicate(phase: ChangeSetPhase): string {
  // This predicate owns exactly one placeholder: the retention cutoff.
  return phase === "expired"
    ? "status = 'open' AND expires_at <= ?"
    : "status = 'rejected' AND COALESCE(decided_at, expires_at) <= ?";
}

export function selectChangeSetPage(phase: ChangeSetPhase): string {
  return `SELECT id FROM change_sets
    WHERE ${retentionPredicate(phase)}
      AND id > ?
    ORDER BY id
    LIMIT ?`;
}

export const CHANGE_SET_DELETE_ROW_CHUNK_SIZE = D1_MAX_BOUND_PARAMS - 5;

export function buildChangeSetDeletes(
  db: Preparer,
  input: {
    phase: ChangeSetPhase;
    rows: readonly ChangeSetRetentionRow[];
    cutoff: number;
    kind: GcJobKind;
    owner: string;
    generation: number;
  },
): { statements: D1PreparedStatement[]; parentIndexes: number[] } {
  if (input.rows.length === 0) {
    throw new Error("buildChangeSetDeletes requires at least one row");
  }
  const statements: D1PreparedStatement[] = [];
  const parentIndexes: number[] = [];
  for (let offset = 0; offset < input.rows.length; offset += CHANGE_SET_DELETE_ROW_CHUNK_SIZE) {
    const chunk = input.rows.slice(offset, offset + CHANGE_SET_DELETE_ROW_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const ids = chunk.map(({ id }) => id);
    statements.push(
      db
        .prepare(
          `DELETE FROM change_set_entries
           WHERE change_set_id IN (${placeholders})
             AND EXISTS (
               SELECT 1 FROM change_sets
               WHERE change_sets.id = change_set_entries.change_set_id
                 AND ${retentionPredicate(input.phase)}
             )
             AND EXISTS (
               SELECT 1 FROM gc_jobs
               WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
             )`,
        )
        .bind(...ids, input.cutoff, input.kind, input.owner, input.generation),
    );
    parentIndexes.push(statements.length);
    statements.push(
      db
        .prepare(
          `DELETE FROM change_sets
           WHERE id IN (${placeholders})
             AND ${retentionPredicate(input.phase)}
             AND NOT EXISTS (
               SELECT 1 FROM change_set_entries e WHERE e.change_set_id = change_sets.id
             )
             AND EXISTS (
               SELECT 1 FROM gc_jobs
               WHERE kind = ? AND lease_owner = ? AND lease_generation = ?
             )`,
        )
        .bind(...ids, input.cutoff, input.kind, input.owner, input.generation),
    );
  }
  return { statements, parentIndexes };
}
