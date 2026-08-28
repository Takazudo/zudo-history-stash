import type { UploadSessionState } from "@takazudo/zudo-history-stash-core";
import type { UploadPartRow, UploadSessionRow } from "./schema.js";

export interface FinalizationLease {
  sessionId: string;
  generation: number;
  owner: string;
  expiresAt: number;
}

export interface CreateUploadSessionInput {
  id: string;
  stash: string;
  path: string;
  principalKind: "admin" | "stash";
  principalId: string | null;
  expectedVersion: number | null;
  declaredSize: number;
  declaredHash: string | null;
  representation: "text" | "binary";
  contentType: string;
  mode: "single" | "multipart";
  tier: "d1" | "r2";
  partSize: number | null;
  fingerprint: string;
  expiresAt: number;
  now: number;
  maxOpenSessions: number;
  maxReservedBytes: number;
  skipIfUnchanged: boolean;
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
    fingerprint?: string;
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

  async create(input: CreateUploadSessionInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO upload_sessions
          (id, stash_name, path, principal_kind, principal_id, expected_version, declared_size,
           declared_hash, representation, content_type, upload_mode, storage_tier, part_size,
           state, expires_at, create_fingerprint, created_at, updated_at, skip_if_unchanged)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
           AND (SELECT COUNT(*) FROM upload_sessions
                WHERE stash_name = ? AND reservation_released_at IS NULL
                  AND state IN ('open','uploaded','finalizing') AND expires_at > ?) < ?
           AND COALESCE((SELECT SUM(declared_size) FROM upload_sessions
                         WHERE stash_name = ? AND reservation_released_at IS NULL
                           AND state IN ('open','uploaded','finalizing') AND expires_at > ?), 0) + ? <= ?`,
      )
      .bind(
        input.id,
        input.stash,
        input.path,
        input.principalKind,
        input.principalId,
        input.expectedVersion,
        input.declaredSize,
        input.declaredHash,
        input.representation,
        input.contentType,
        input.mode,
        input.tier,
        input.partSize,
        input.expiresAt,
        input.fingerprint,
        input.now,
        input.now,
        input.skipIfUnchanged ? 1 : 0,
        input.stash,
        input.stash,
        input.now,
        input.maxOpenSessions,
        input.stash,
        input.now,
        input.declaredSize,
        input.maxReservedBytes,
      )
      .run();
    return result.meta.changes === 1;
  }

  async getByCreateFingerprint(
    stash: string,
    fingerprint: string,
  ): Promise<UploadSessionRow | null> {
    return this.db
      .prepare("SELECT * FROM upload_sessions WHERE stash_name = ? AND create_fingerprint = ?")
      .bind(stash, fingerprint)
      .first<UploadSessionRow>();
  }

  async listParts(sessionId: string, generation: number): Promise<UploadPartRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT session_id, generation, part_number, size_bytes, r2_etag, recorded_at
         FROM upload_parts WHERE session_id = ? AND generation = ? ORDER BY part_number`,
      )
      .bind(sessionId, generation)
      .all<UploadPartRow>();
    return rows.results;
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

  async recordStagedObject(input: {
    sessionId: string;
    generation: number;
    objectKey: string;
    size: number;
    hash: string;
    fingerprint: string;
    now: number;
  }): Promise<boolean> {
    const predicate = `EXISTS (SELECT 1 FROM upload_sessions
      WHERE id = ? AND state = 'open' AND attempt_generation = ?)`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO upload_objects
             (object_key, session_id, generation, purpose, created_at, completed_at)
           SELECT ?, ?, ?, 'staging', ?, ? WHERE ${predicate}`,
        )
        .bind(
          input.objectKey,
          input.sessionId,
          input.generation,
          input.now,
          input.now,
          input.sessionId,
          input.generation,
        ),
      this.db
        .prepare(
          `UPDATE upload_sessions SET state = 'uploaded', uploaded_size = ?, uploaded_hash = ?,
             upload_fingerprint = ?, staged_r2_key = ?, r2_completed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'open' AND attempt_generation = ?`,
        )
        .bind(
          input.size,
          input.hash,
          input.fingerprint,
          input.objectKey,
          input.now,
          input.now,
          input.sessionId,
          input.generation,
        ),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  }

  async expire(sessionId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = 'expired', reservation_released_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('open','uploaded') AND expires_at <= ?`,
      )
      .bind(now, now, sessionId, now)
      .run();
    return result.meta.changes === 1;
  }

  async failOpen(
    sessionId: string,
    generation: number,
    code: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = 'failed', error_code = ?,
           reservation_released_at = ?, updated_at = ?
         WHERE id = ? AND state = 'open' AND attempt_generation = ?`,
      )
      .bind(code, now, now, sessionId, generation)
      .run();
    return result.meta.changes === 1;
  }

  async abort(input: {
    sessionId: string;
    generation: number;
    fingerprint: string;
    now: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = 'aborted', complete_fingerprint = ?,
           result_status = 200, result_json = json_object('id', id, 'state', 'aborted'),
           reservation_released_at = ?, finalization_lease_owner = NULL,
           finalization_lease_until = NULL, updated_at = ?
         WHERE id = ? AND attempt_generation = ?
           AND (state IN ('open','uploaded') OR
                (state = 'finalizing' AND finalization_lease_until <= ?))
           AND (complete_fingerprint IS NULL OR complete_fingerprint = ?)`,
      )
      .bind(
        input.fingerprint,
        input.now,
        input.now,
        input.sessionId,
        input.generation,
        input.now,
        input.fingerprint,
      )
      .run();
    return result.meta.changes === 1;
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
    fingerprint?: string;
  }): Promise<FinalizationLease | null> {
    if (input.leaseUntil <= input.now) {
      throw new Error("Finalization lease expiry must be after acquisition time");
    }
    const result = await this.db
      .prepare(
        `UPDATE upload_sessions SET state = 'finalizing', finalization_lease_owner = ?,
         finalization_lease_until = ?, complete_fingerprint = COALESCE(complete_fingerprint, ?),
         updated_at = ?
       WHERE id = ? AND attempt_generation = ? AND
         (state = 'uploaded' OR (state = 'finalizing' AND
           (finalization_lease_owner = ? OR finalization_lease_until <= ?)))
         AND (? IS NULL OR complete_fingerprint IS NULL OR complete_fingerprint = ?)`,
      )
      .bind(
        input.owner,
        input.leaseUntil,
        input.fingerprint ?? null,
        input.now,
        input.sessionId,
        input.generation,
        input.owner,
        input.now,
        input.fingerprint ?? null,
        input.fingerprint ?? null,
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
