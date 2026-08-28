import type { UploadCommitResult, UploadUnchangedResult } from "@takazudo/zudo-history-stash-core";
import type { FinalizationLease } from "./upload-sessions.js";
import type { UploadSessionRow } from "./schema.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

export interface UploadFinalizeInput {
  session: UploadSessionRow;
  lease: FinalizationLease;
  createdAt: number;
  eventOrigin: string | null;
}

function leaseFence(input: UploadFinalizeInput): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM upload_sessions
      WHERE id = ? AND stash_name = ? AND path = ? AND state = 'finalizing'
        AND attempt_generation = ? AND finalization_lease_owner = ?
        AND finalization_lease_until = ? AND finalization_lease_until > ?)`,
    params: [
      input.session.id,
      input.session.stash_name,
      input.session.path,
      input.lease.generation,
      input.lease.owner,
      input.lease.expiresAt,
      input.createdAt,
    ],
  };
}

function casFence(input: UploadFinalizeInput): { sql: string; params: unknown[] } {
  const lease = leaseFence(input);
  if (input.session.expected_version === null) {
    return {
      sql: `${lease.sql}
        AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)`,
      params: [
        ...lease.params,
        input.session.stash_name,
        input.session.stash_name,
        input.session.path,
      ],
    };
  }
  return {
    sql: `${lease.sql}
      AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM files
        WHERE stash_name = ? AND path = ? AND head_version = ?)`,
    params: [
      ...lease.params,
      input.session.stash_name,
      input.session.stash_name,
      input.session.path,
      input.session.expected_version,
    ],
  };
}

export function uploadFinalizeBatch(
  db: Preparer,
  input: UploadFinalizeInput,
): D1PreparedStatement[] {
  const fence = casFence(input);
  const version = (input.session.expected_version ?? 0) + 1;
  const stagedSource =
    input.session.storage_tier === "d1"
      ? `SELECT ?, ?, staged.body_bytes, NULL, ?, staged.size_bytes, ?
         FROM upload_staged_bytes staged
         WHERE staged.session_id = ? AND staged.generation = ? AND staged.hash = ?
           AND staged.size_bytes = ? AND ${fence.sql}`
      : `SELECT ?, ?, NULL, sessions.staged_r2_key, ?, sessions.uploaded_size, ?
         FROM upload_sessions sessions
         WHERE sessions.id = ? AND sessions.attempt_generation = ?
           AND sessions.uploaded_hash = ? AND sessions.uploaded_size = ?
           AND sessions.staged_r2_key IS NOT NULL AND ${fence.sql}`;
  const versionFence = `EXISTS (SELECT 1 FROM byte_blobs
    WHERE stash_name = ? AND hash = ? AND size_bytes = ?) AND ${fence.sql}`;
  const versionFenceParams = [
    input.session.stash_name,
    input.session.uploaded_hash,
    input.session.uploaded_size,
    ...fence.params,
  ];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO byte_blobs
           (stash_name, hash, body_bytes, r2_key, storage_generation, size_bytes, created_at)
         ${stagedSource}
         ON CONFLICT(stash_name, hash) DO NOTHING`,
      )
      .bind(
        input.session.stash_name,
        input.session.uploaded_hash,
        input.lease.generation,
        input.createdAt,
        input.session.id,
        input.lease.generation,
        input.session.uploaded_hash,
        input.session.uploaded_size,
        ...fence.params,
      ),
    db
      .prepare(
        `INSERT INTO versions
           (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
            rollback_of, author, message, meta_json, created_at, representation,
            application_etag, content_storage)
         SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, '', '{}', ?, ?, ?, 'bytes'
         WHERE ${versionFence}`,
      )
      .bind(
        input.session.stash_name,
        input.session.path,
        version,
        input.session.uploaded_hash,
        input.session.uploaded_size,
        input.session.content_type,
        input.session.principal_id ?? "",
        input.createdAt,
        input.session.representation,
        input.session.uploaded_hash,
        ...versionFenceParams,
      ),
  ];
  const insertedVersion = `EXISTS (SELECT 1 FROM versions
    WHERE stash_name = ? AND path = ? AND version = ? AND blob_hash = ?
      AND content_storage = 'bytes')`;
  const insertedParams = [
    input.session.stash_name,
    input.session.path,
    version,
    input.session.uploaded_hash,
  ];
  if (input.session.expected_version === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO files
             (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
           SELECT ?, ?, ?, ?, 0, ?, ? WHERE ${fence.sql} AND ${insertedVersion}`,
        )
        .bind(
          input.session.stash_name,
          input.session.path,
          version,
          input.session.uploaded_hash,
          input.createdAt,
          input.createdAt,
          ...fence.params,
          ...insertedParams,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE files SET head_version = ?, head_hash = ?, deleted = 0, updated_at = ?
           WHERE stash_name = ? AND path = ? AND head_version = ?
             AND ${fence.sql} AND ${insertedVersion}`,
        )
        .bind(
          version,
          input.session.uploaded_hash,
          input.createdAt,
          input.session.stash_name,
          input.session.path,
          input.session.expected_version,
          ...fence.params,
          ...insertedParams,
        ),
    );
  }
  if (input.session.storage_tier === "r2") {
    statements.push(
      db
        .prepare(
          `UPDATE upload_objects SET purpose = 'committed', completed_at = ?
           WHERE object_key = ? AND session_id = ? AND generation = ?
             AND EXISTS (SELECT 1 FROM byte_blobs
               WHERE stash_name = ? AND hash = ? AND r2_key = ?)
             AND ${insertedVersion}`,
        )
        .bind(
          input.createdAt,
          input.session.staged_r2_key,
          input.session.id,
          input.lease.generation,
          input.session.stash_name,
          input.session.uploaded_hash,
          input.session.staged_r2_key,
          ...insertedParams,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `DELETE FROM upload_staged_bytes WHERE session_id = ? AND generation = ?
           AND ${insertedVersion}`,
        )
        .bind(input.session.id, input.lease.generation, ...insertedParams),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE upload_sessions SET state = 'committed', result_status = 201,
           result_json = json_object(
             'version', ?, 'hash', uploaded_hash, 'size', uploaded_size,
             'representation', representation, 'contentType', content_type,
             'changeId', (SELECT id FROM versions
               WHERE stash_name = ? AND path = ? AND version = ?),
             'createdAt', ?),
           event_origin = ?, reservation_released_at = ?, finalization_lease_owner = NULL,
           finalization_lease_until = NULL, updated_at = ?
         WHERE id = ? AND state = 'finalizing' AND attempt_generation = ?
           AND finalization_lease_owner = ? AND finalization_lease_until = ?
           AND finalization_lease_until > ? AND ${insertedVersion}`,
      )
      .bind(
        version,
        input.session.stash_name,
        input.session.path,
        version,
        new Date(input.createdAt).toISOString(),
        input.eventOrigin,
        input.createdAt,
        input.createdAt,
        input.session.id,
        input.lease.generation,
        input.lease.owner,
        input.lease.expiresAt,
        input.createdAt,
        ...insertedParams,
      ),
  );
  return statements;
}

export async function finalizeUnchanged(
  db: D1Database,
  input: UploadFinalizeInput,
): Promise<UploadUnchangedResult | null> {
  if (input.session.skip_if_unchanged !== 1 || input.session.expected_version === null) return null;
  const fence = leaseFence(input);
  const session = db.withSession("first-primary");
  const statements = [
    session
      .prepare(
        `UPDATE upload_sessions SET state = 'committed', result_status = 200,
           result_json = json_object(
             'unchanged', json('true'), 'version', ?, 'hash', uploaded_hash,
             'size', uploaded_size, 'representation', representation,
             'contentType', content_type),
           reservation_released_at = ?, finalization_lease_owner = NULL,
           finalization_lease_until = NULL, updated_at = ?
         WHERE id = ? AND ${fence.sql}
           AND EXISTS (
             SELECT 1 FROM files heads JOIN versions current
               ON current.stash_name = heads.stash_name AND current.path = heads.path
                 AND current.version = heads.head_version
             WHERE heads.stash_name = upload_sessions.stash_name
               AND heads.path = upload_sessions.path AND heads.deleted = 0
               AND heads.head_version = upload_sessions.expected_version
               AND heads.head_hash = upload_sessions.uploaded_hash
               AND current.representation = upload_sessions.representation
               AND current.content_type = upload_sessions.content_type
           )`,
      )
      .bind(
        input.session.expected_version,
        input.createdAt,
        input.createdAt,
        input.session.id,
        ...fence.params,
      ),
    ...(input.session.storage_tier === "d1"
      ? [
          session
            .prepare(
              `DELETE FROM upload_staged_bytes WHERE session_id = ? AND generation = ?
               AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND state = 'committed'
                 AND result_status = 200)`,
            )
            .bind(input.session.id, input.lease.generation, input.session.id),
        ]
      : []),
  ];
  const results = await session.batch(statements);
  if (results[0]?.meta.changes !== 1) return null;
  const row = await session
    .prepare("SELECT result_json FROM upload_sessions WHERE id = ?")
    .bind(input.session.id)
    .first<{ result_json: string }>();
  return row === null ? null : (JSON.parse(row.result_json) as UploadUnchangedResult);
}

export async function finalizeUpload(
  db: D1Database,
  input: UploadFinalizeInput,
): Promise<UploadCommitResult | null> {
  const session = db.withSession("first-primary");
  const results = await session.batch(uploadFinalizeBatch(session, input));
  if (results.at(-1)?.meta.changes !== 1) return null;
  const row = await session
    .prepare("SELECT result_json FROM upload_sessions WHERE id = ?")
    .bind(input.session.id)
    .first<{ result_json: string | null }>();
  if (row?.result_json === null || row?.result_json === undefined)
    throw new Error("Missing upload result");
  return JSON.parse(row.result_json) as UploadCommitResult;
}
