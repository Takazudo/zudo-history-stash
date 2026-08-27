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
`;

export const selectLedgerPage = `
  SELECT rowid, created_at
  FROM idempotency
  WHERE created_at < ?
    AND (created_at > ? OR (created_at = ? AND rowid > ?))
  ORDER BY created_at, rowid
  LIMIT ?
`;

export function deleteLedgerRows(
  db: Preparer,
  rows: readonly { rowid: number; created_at: number }[],
  cutoff: number,
): D1PreparedStatement {
  if (rows.length === 0) throw new Error("deleteLedgerRows requires at least one row");
  return db
    .prepare(
      `DELETE FROM idempotency
       WHERE created_at < ? AND rowid IN (${rows.map(() => "?").join(", ")})`,
    )
    .bind(cutoff, ...rows.map(({ rowid }) => rowid));
}
