import type { UploadCommitResult, UploadUnchangedResult } from "@takazudo/zudo-history-stash-core";
import type { FinalizationLease } from "./upload-sessions.js";
import type { UploadSessionRow } from "./schema.js";
import { commitBatch, commitFence } from "./sql/commits.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

export interface UploadFinalizeInput {
  commitId?: string;
  createdBy?: string;
  session: UploadSessionRow;
  lease: FinalizationLease;
  createdAt: number;
  eventOrigin: string | null;
  alterUploadFinalizeStatementsForTest?: (
    statements: D1PreparedStatement[],
  ) => D1PreparedStatement[];
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

export function uploadFinalizeBatch(
  db: Preparer,
  input: UploadFinalizeInput,
): D1PreparedStatement[] {
  if (input.commitId === undefined || input.createdBy === undefined) {
    throw new Error("Committed upload finalization requires commit attribution");
  }
  if (input.session.uploaded_hash === null || input.session.uploaded_size === null) {
    throw new Error("Committed upload finalization requires staged content metadata");
  }
  const uploadedHash = input.session.uploaded_hash;
  const uploadedSize = input.session.uploaded_size;
  const version = (input.session.expected_version ?? 0) + 1;
  const author = input.session.commit_author ?? input.session.principal_id ?? "";
  const message = input.session.commit_message ?? "";
  const metaJson = input.session.commit_meta_json ?? "{}";
  const commit = commitFence(input.session.stash_name, input.commitId);
  const insertedVersion = `EXISTS (SELECT 1 FROM versions
    WHERE stash_name = ? AND path = ? AND version = ? AND blob_hash = ?
      AND content_storage = 'bytes' AND commit_id = ?)`;
  const insertedParams = [
    input.session.stash_name,
    input.session.path,
    version,
    uploadedHash,
    input.commitId,
  ];
  const postEntryStatements: D1PreparedStatement[] = [];
  if (input.session.storage_tier === "r2") {
    postEntryStatements.push(
      db
        .prepare(
          `UPDATE upload_objects SET purpose = 'committed', completed_at = ?
           WHERE object_key = ? AND session_id = ? AND generation = ?
             AND EXISTS (SELECT 1 FROM byte_blobs
               WHERE stash_name = ? AND hash = ? AND r2_key = ?)
             AND ${commit.sql} AND ${insertedVersion}`,
        )
        .bind(
          input.createdAt,
          input.session.staged_r2_key,
          input.session.id,
          input.lease.generation,
          input.session.stash_name,
          uploadedHash,
          input.session.staged_r2_key,
          ...commit.params,
          ...insertedParams,
        ),
    );
  } else {
    postEntryStatements.push(
      db
        .prepare(
          `DELETE FROM upload_staged_bytes WHERE session_id = ? AND generation = ?
           AND ${commit.sql} AND ${insertedVersion}`,
        )
        .bind(input.session.id, input.lease.generation, ...commit.params, ...insertedParams),
    );
  }
  postEntryStatements.push(
    db
      .prepare(
        `UPDATE upload_sessions SET state = 'committed', result_status = 201,
           result_json = json_object(
             'commitId', ?,
             'version', ?, 'hash', uploaded_hash, 'size', uploaded_size,
             'representation', representation, 'contentType', content_type,
             'changeId', (SELECT id FROM versions
               WHERE stash_name = ? AND path = ? AND version = ?),
             'createdAt', ?),
           event_origin = ?, reservation_released_at = ?, finalization_lease_owner = NULL,
           finalization_lease_until = NULL, updated_at = ?
         WHERE id = ? AND state = 'finalizing' AND attempt_generation = ?
           AND finalization_lease_owner = ? AND finalization_lease_until = ?
           AND finalization_lease_until > ? AND ${commit.sql} AND ${insertedVersion}`,
      )
      .bind(
        input.commitId,
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
        ...commit.params,
        ...insertedParams,
      ),
  );
  return commitBatch(db, {
    row: {
      id: input.commitId,
      stash_name: input.session.stash_name,
      source: "upload",
      source_id: input.session.id,
      author,
      message,
      meta_json: metaJson,
      entry_count: 1,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: null,
      created_by: input.createdBy,
      created_at: input.createdAt,
    },
    entries: [
      {
        op: "put",
        content: "staged",
        path: input.session.path,
        expectedVersion: input.session.expected_version,
        version,
        representation: input.session.representation,
        hash: uploadedHash,
        size: uploadedSize,
        contentType: input.session.content_type,
        staged: {
          tier: input.session.storage_tier,
          sessionId: input.session.id,
          generation: input.lease.generation,
        },
        author,
        message,
        metaJson,
        createdAt: input.createdAt,
      },
    ],
    extraGatePredicate: leaseFence(input),
    postEntryStatements,
    extraSealPredicate: {
      sql: `EXISTS (SELECT 1 FROM upload_sessions
        WHERE id = ? AND state = 'committed' AND result_status = 201
          AND json_extract(result_json, '$.commitId') = ?)`,
      params: [input.session.id, input.commitId],
    },
  });
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
    input.session.storage_tier === "d1"
      ? session
          .prepare(
            `DELETE FROM upload_staged_bytes WHERE session_id = ? AND generation = ?
             AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND state = 'committed'
               AND result_status = 200)`,
          )
          .bind(input.session.id, input.lease.generation, input.session.id)
      : session
          .prepare(
            `DELETE FROM upload_objects WHERE session_id = ? AND generation = ?
             AND purpose = 'staging'
             AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND state = 'committed'
               AND result_status = 200)`,
          )
          .bind(input.session.id, input.lease.generation, input.session.id),
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
  let results: D1Result<unknown>[];
  try {
    let statements = uploadFinalizeBatch(session, input);
    statements = input.alterUploadFinalizeStatementsForTest?.(statements) ?? statements;
    results = await session.batch(statements);
  } catch {
    return null;
  }
  if (results.at(-1)?.meta.changes !== 1) return null;
  const row = await session
    .prepare("SELECT result_json FROM upload_sessions WHERE id = ?")
    .bind(input.session.id)
    .first<{ result_json: string | null }>();
  if (row?.result_json === null || row?.result_json === undefined)
    throw new Error("Missing upload result");
  return JSON.parse(row.result_json) as UploadCommitResult;
}
