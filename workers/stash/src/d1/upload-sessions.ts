import type { UploadSessionState } from "@takazudo/zudo-history-stash-core";
import type { UploadPartRow, UploadSessionRow } from "./schema.js";

export interface FinalizationLease {
  sessionId: string;
  generation: number;
  owner: string;
  expiresAt: number;
}

/** Durable mutation seam shared by the single-stream and multipart implementations. */
export interface UploadSessionMutationStore {
  get(sessionId: string): Promise<UploadSessionRow | null>;
  recordStagedBytes(input: {
    sessionId: string;
    generation: number;
    bytes: ArrayBuffer;
    size: number;
    hash: string;
    fingerprint: string;
    now: number;
  }): Promise<boolean>;
  recordPart(input: Omit<UploadPartRow, "recorded_at"> & { now: number }): Promise<boolean>;
  acquireFinalizationLease(input: {
    sessionId: string;
    generation: number;
    owner: string;
    now: number;
    leaseUntil: number;
  }): Promise<FinalizationLease | null>;
  finish(input: {
    lease: FinalizationLease;
    state: Extract<UploadSessionState, "committed" | "stale" | "failed" | "aborted">;
    resultStatus?: number;
    resultJson?: string;
    errorCode?: string;
    now: number;
  }): Promise<boolean>;
}

/**
 * Small transition store, deliberately not the version/head commit implementation. Every write is
 * state- and generation-fenced so late work cannot revive terminal sessions.
 */
export class D1UploadSessionStore implements UploadSessionMutationStore {
  constructor(private readonly db: D1Database) {}

  get(sessionId: string): Promise<UploadSessionRow | null> {
    return this.db
      .prepare("SELECT * FROM upload_sessions WHERE id = ?")
      .bind(sessionId)
      .first<UploadSessionRow>();
  }

  async recordStagedBytes(input: {
    sessionId: string;
    generation: number;
    bytes: ArrayBuffer;
    size: number;
    hash: string;
    fingerprint: string;
    now: number;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO upload_staged_bytes
           (session_id, generation, body_bytes, size_bytes, hash, created_at)
         SELECT id, attempt_generation, ?, ?, ?, ? FROM upload_sessions
         WHERE id = ? AND state = 'open' AND attempt_generation = ?
         ON CONFLICT(session_id, generation) DO UPDATE SET
           body_bytes = excluded.body_bytes, size_bytes = excluded.size_bytes,
           hash = excluded.hash, created_at = excluded.created_at`,
        )
        .bind(input.bytes, input.size, input.hash, input.now, input.sessionId, input.generation),
      this.db
        .prepare(
          `UPDATE upload_sessions SET state = 'uploaded', uploaded_size = ?, uploaded_hash = ?,
           upload_fingerprint = ?, updated_at = ?
         WHERE id = ? AND state = 'open' AND attempt_generation = ?`,
        )
        .bind(
          input.size,
          input.hash,
          input.fingerprint,
          input.now,
          input.sessionId,
          input.generation,
        ),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1;
  }

  async recordPart(input: Omit<UploadPartRow, "recorded_at"> & { now: number }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO upload_parts (session_id, generation, part_number, size_bytes, r2_etag, recorded_at)
       SELECT id, attempt_generation, ?, ?, ?, ? FROM upload_sessions
       WHERE id = ? AND state = 'open' AND attempt_generation = ?
       ON CONFLICT(session_id, generation, part_number) DO UPDATE SET
         size_bytes = excluded.size_bytes, r2_etag = excluded.r2_etag,
         recorded_at = excluded.recorded_at`,
      )
      .bind(
        input.part_number,
        input.size_bytes,
        input.r2_etag,
        input.now,
        input.session_id,
        input.generation,
      )
      .run();
    return result.meta.changes === 1;
  }

  async acquireFinalizationLease(input: {
    sessionId: string;
    generation: number;
    owner: string;
    now: number;
    leaseUntil: number;
  }): Promise<FinalizationLease | null> {
    if (input.leaseUntil <= input.now) {
      throw new Error("Finalization lease expiry must be after acquisition time");
    }
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = 'finalizing', finalization_lease_owner = ?,
         finalization_lease_until = ?, updated_at = ?
       WHERE id = ? AND attempt_generation = ? AND
         (state = 'uploaded' OR (state = 'finalizing' AND
           (finalization_lease_owner = ? OR finalization_lease_until <= ?)))`,
      )
      .bind(
        input.owner,
        input.leaseUntil,
        input.now,
        input.sessionId,
        input.generation,
        input.owner,
        input.now,
      )
      .run();
    return result.meta.changes === 1
      ? {
          sessionId: input.sessionId,
          generation: input.generation,
          owner: input.owner,
          expiresAt: input.leaseUntil,
        }
      : null;
  }

  async finish(input: {
    lease: FinalizationLease;
    state: "committed" | "stale" | "failed" | "aborted";
    resultStatus?: number;
    resultJson?: string;
    errorCode?: string;
    now: number;
  }): Promise<boolean> {
    if ((input.resultStatus === undefined) !== (input.resultJson === undefined)) {
      throw new Error("Replay result status and JSON must be supplied together");
    }
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = ?, result_status = ?, result_json = ?, error_code = ?,
         reservation_released_at = ?, finalization_lease_owner = NULL,
         finalization_lease_until = NULL, updated_at = ?
       WHERE id = ? AND state = 'finalizing' AND attempt_generation = ?
         AND finalization_lease_owner = ? AND finalization_lease_until = ?
         AND finalization_lease_until > ?`,
      )
      .bind(
        input.state,
        input.resultStatus ?? null,
        input.resultJson ?? null,
        input.errorCode ?? null,
        input.now,
        input.now,
        input.lease.sessionId,
        input.lease.generation,
        input.lease.owner,
        input.lease.expiresAt,
        input.now,
      )
      .run();
    return result.meta.changes === 1;
  }
}
