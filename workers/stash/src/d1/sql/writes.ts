import type { PreparedBlob } from "../blobs.js";
import { commitInsertStatement, sealStatement } from "./commits.js";

/**
 * Every mutation has one operation predicate F, and that exact predicate is applied to every
 * statement in its batch. The commit insert is first, the files/head statement is immediately
 * before the seal, and the seal is the final verdict. Only `results.at(-1)?.meta.changes === 1`
 * decides success. If F refuses a mutation, every statement changes zero rows.
 */
export interface SqlFragment {
  sql: string;
  params: unknown[];
}

export interface LedgerInsert {
  key: string;
  requestHash: string;
  statusCode: number;
}

export type PutBatchInput = {
  commitId: string;
  createdBy: string;
  stash: string;
  path: string;
  expectedVersion: number | null;
  hash: string;
  size: number;
  contentType: string;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
  ledger?: LedgerInsert;
} & PreparedBlob;

export interface DeleteBatchInput {
  commitId: string;
  createdBy: string;
  stash: string;
  path: string;
  expectedVersion: number;
  author: string;
  message: string;
  createdAt: number;
  ledger?: LedgerInsert;
}

export interface RollbackBatchInput {
  commitId: string;
  createdBy: string;
  stash: string;
  path: string;
  expectedVersion: number;
  toVersion: number;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
  ledger?: LedgerInsert;
}

type Preparer = Pick<D1DatabaseSession, "prepare">;

export interface VersionInsertInput {
  commitId: string;
  stash: string;
  path: string;
  version: number;
  hash: string;
  size: number;
  contentType: string;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
}

export interface HeadWriteInput {
  stash: string;
  path: string;
  expectedVersion: number | null;
  version: number;
  hash: string;
  createdAt: number;
}

export function combineFences(...fragments: SqlFragment[]): SqlFragment {
  return {
    sql: fragments.map((fragment) => `(${fragment.sql})`).join(" AND "),
    params: fragments.flatMap((fragment) => fragment.params),
  };
}

export const fence = {
  create(stash: string, path: string): SqlFragment {
    return {
      sql: `EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM files WHERE stash_name = ? AND path = ?)`,
      params: [stash, stash, path],
    };
  },
  put(stash: string, path: string, expectedVersion: number): SqlFragment {
    return {
      sql: `EXISTS (SELECT 1 FROM files
        WHERE stash_name = ? AND path = ? AND head_version = ?)
        AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)`,
      params: [stash, path, expectedVersion, stash],
    };
  },
  delete(stash: string, path: string, expectedVersion: number): SqlFragment {
    return {
      sql: `EXISTS (SELECT 1 FROM files
        WHERE stash_name = ? AND path = ? AND head_version = ? AND deleted = 0)
        AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)`,
      params: [stash, path, expectedVersion, stash],
    };
  },
  rollback(stash: string, path: string, expectedVersion: number, toVersion: number): SqlFragment {
    return {
      sql: `EXISTS (SELECT 1 FROM files
        WHERE stash_name = ? AND path = ? AND head_version = ?)
        AND EXISTS (SELECT 1 FROM versions
          WHERE stash_name = ? AND path = ? AND version = ? AND blob_hash IS NOT NULL)
        AND EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)`,
      params: [stash, path, expectedVersion, stash, path, toVersion, stash],
    };
  },
};

export const selectHeadForWrite = `
  SELECT f.head_version, f.head_hash, f.deleted, v.kind, v.author, v.created_at,
    v.representation, v.content_type
  FROM files f
  JOIN versions v ON v.stash_name = f.stash_name AND v.path = f.path
    AND v.version = f.head_version
  WHERE f.stash_name = ? AND f.path = ?
`;

export const selectVersionMeta = `
  SELECT v.id, v.version, v.kind, v.blob_hash, v.size_bytes, v.content_type,
    v.rollback_of, v.author, v.message, v.meta_json, v.created_at,
    v.representation, v.application_etag, v.content_storage, v.commit_id,
    previous.blob_hash AS previous_blob_hash,
    previous.representation AS previous_representation,
    previous.content_type AS previous_content_type
  FROM versions v
  LEFT JOIN versions previous ON previous.stash_name = v.stash_name
    AND previous.path = v.path AND previous.version = v.version - 1
  WHERE v.stash_name = ? AND v.path = ? AND v.version = ?
`;

export const selectLedger = `
  SELECT stash_name, key, request_hash, path, version, status_code, created_at
  FROM idempotency WHERE stash_name = ? AND key = ?
`;

export function insertLedger(
  db: Preparer,
  input: {
    stash: string;
    path: string;
    version: number;
    createdAt: number;
    ledger: LedgerInsert;
    operationFence: SqlFragment;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO idempotency
        (stash_name, key, request_hash, path, version, status_code, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${input.operationFence.sql}`,
    )
    .bind(
      input.stash,
      input.ledger.key,
      input.ledger.requestHash,
      input.path,
      input.version,
      input.ledger.statusCode,
      input.createdAt,
      ...input.operationFence.params,
    );
}

export function versionInsert(
  db: Preparer,
  input: VersionInsertInput,
  operationFence: SqlFragment,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO versions
        (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
         rollback_of, author, message, meta_json, created_at, commit_id)
       SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${operationFence.sql}`,
    )
    .bind(
      input.stash,
      input.path,
      input.version,
      input.hash,
      input.size,
      input.contentType,
      input.author,
      input.message,
      input.metaJson,
      input.createdAt,
      input.commitId,
      ...operationFence.params,
    );
}

export function headWrite(
  db: Preparer,
  input: HeadWriteInput,
  operationFence: SqlFragment,
): D1PreparedStatement {
  if (input.expectedVersion === null) {
    return db
      .prepare(
        `INSERT INTO files
          (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
         SELECT ?, ?, ?, ?, 0, ?, ? WHERE ${operationFence.sql}
           AND EXISTS (SELECT 1 FROM versions
             WHERE stash_name = ? AND path = ? AND version = ?)`,
      )
      .bind(
        input.stash,
        input.path,
        input.version,
        input.hash,
        input.createdAt,
        input.createdAt,
        ...operationFence.params,
        input.stash,
        input.path,
        input.version,
      );
  }
  return db
    .prepare(
      `UPDATE files SET head_version = ?, head_hash = ?, deleted = 0, updated_at = ?
       WHERE stash_name = ? AND path = ? AND head_version = ? AND ${operationFence.sql}
         AND EXISTS (SELECT 1 FROM versions
           WHERE stash_name = ? AND path = ? AND version = ?)`,
    )
    .bind(
      input.version,
      input.hash,
      input.createdAt,
      input.stash,
      input.path,
      input.expectedVersion,
      ...operationFence.params,
      input.stash,
      input.path,
      input.version,
    );
}

function ledgerStatement(
  db: Preparer,
  input: PutBatchInput | DeleteBatchInput | RollbackBatchInput,
  version: number,
  operationFence: SqlFragment,
): D1PreparedStatement[] {
  return input.ledger
    ? [
        insertLedger(db, {
          stash: input.stash,
          path: input.path,
          version,
          createdAt: input.createdAt,
          ledger: input.ledger,
          operationFence,
        }),
      ]
    : [];
}

function putStatements(
  db: Preparer,
  input: PutBatchInput,
  operationFence: SqlFragment,
  version: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${operationFence.sql}
         ON CONFLICT(stash_name, hash) DO NOTHING`,
      )
      .bind(
        input.stash,
        input.hash,
        input.body,
        input.r2_key,
        input.size,
        input.createdAt,
        ...operationFence.params,
      ),
    versionInsert(db, { ...input, version }, operationFence),
    ...ledgerStatement(db, input, version, operationFence),
  ];
}

function commitStatement(
  db: Preparer,
  input: PutBatchInput | DeleteBatchInput | RollbackBatchInput,
  source: "put" | "delete" | "rollback",
  operationFence: SqlFragment,
): D1PreparedStatement {
  return commitInsertStatement(
    db,
    {
      id: input.commitId,
      stash_name: input.stash,
      source,
      source_id: null,
      author: input.author,
      message: input.message,
      meta_json: "metaJson" in input ? input.metaJson : "{}",
      entry_count: 1,
      reverts_commit_id: null,
      // Single-path mutations retain idempotency only in the expiring ledger. Persisting these
      // values on commits would make the key permanently unique after ledger GC.
      idempotency_key: null,
      request_hash: null,
      created_by: input.createdBy,
      created_at: input.createdAt,
    },
    operationFence,
  );
}

export function putUpdateBatch(db: Preparer, input: PutBatchInput): D1PreparedStatement[] {
  if (input.expectedVersion === null) throw new Error("putUpdateBatch requires expectedVersion");
  const operationFence = fence.put(input.stash, input.path, input.expectedVersion);
  const version = input.expectedVersion + 1;
  return [
    commitStatement(db, input, "put", operationFence),
    ...putStatements(db, input, operationFence, version),
    headWrite(db, { ...input, version }, operationFence),
    sealStatement(db, { stash: input.stash, id: input.commitId }),
  ];
}

export function putCreateBatch(db: Preparer, input: PutBatchInput): D1PreparedStatement[] {
  if (input.expectedVersion !== null)
    throw new Error("putCreateBatch requires null expectedVersion");
  const operationFence = fence.create(input.stash, input.path);
  return [
    commitStatement(db, input, "put", operationFence),
    ...putStatements(db, input, operationFence, 1),
    headWrite(db, { ...input, version: 1 }, operationFence),
    sealStatement(db, { stash: input.stash, id: input.commitId }),
  ];
}

export function deleteBatch(db: Preparer, input: DeleteBatchInput): D1PreparedStatement[] {
  const operationFence = fence.delete(input.stash, input.path, input.expectedVersion);
  const version = input.expectedVersion + 1;
  return [
    commitStatement(db, input, "delete", operationFence),
    db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at,
           representation, application_etag, content_storage, commit_id)
         SELECT ?, ?, ?, 'delete', NULL, 0, current.content_type,
           NULL, ?, ?, '{}', ?, current.representation, NULL, current.content_storage, ?
         FROM versions AS current
         WHERE current.stash_name = ? AND current.path = ? AND current.version = ?
           AND ${operationFence.sql}`,
      )
      .bind(
        input.stash,
        input.path,
        version,
        input.author,
        input.message,
        input.createdAt,
        input.commitId,
        input.stash,
        input.path,
        input.expectedVersion,
        ...operationFence.params,
      ),
    ...ledgerStatement(db, input, version, operationFence),
    db
      .prepare(
        `UPDATE files SET head_version = ?, head_hash = NULL, deleted = 1, updated_at = ?
         WHERE stash_name = ? AND path = ? AND head_version = ? AND deleted = 0
           AND ${operationFence.sql}
           AND EXISTS (SELECT 1 FROM versions
             WHERE stash_name = ? AND path = ? AND version = ?)`,
      )
      .bind(
        version,
        input.createdAt,
        input.stash,
        input.path,
        input.expectedVersion,
        ...operationFence.params,
        input.stash,
        input.path,
        version,
      ),
    sealStatement(db, { stash: input.stash, id: input.commitId }),
  ];
}

export function rollbackBatch(db: Preparer, input: RollbackBatchInput): D1PreparedStatement[] {
  const operationFence = fence.rollback(
    input.stash,
    input.path,
    input.expectedVersion,
    input.toVersion,
  );
  const version = input.expectedVersion + 1;
  return [
    commitStatement(db, input, "rollback", operationFence),
    db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at,
           representation, application_etag, content_storage, commit_id)
         SELECT ?, ?, ?, 'rollback', target.blob_hash, target.size_bytes, target.content_type,
           target.version, ?, COALESCE(NULLIF(?, ''), 'Rollback to v' || target.version), ?, ?,
           target.representation, target.application_etag, target.content_storage, ?
         FROM versions target
         WHERE target.stash_name = ? AND target.path = ? AND target.version = ?
           AND ${operationFence.sql}`,
      )
      .bind(
        input.stash,
        input.path,
        version,
        input.author,
        input.message,
        input.metaJson,
        input.createdAt,
        input.commitId,
        input.stash,
        input.path,
        input.toVersion,
        ...operationFence.params,
      ),
    ...ledgerStatement(db, input, version, operationFence),
    db
      .prepare(
        `UPDATE files SET head_version = ?, head_hash = (SELECT blob_hash FROM versions
           WHERE stash_name = ? AND path = ? AND version = ?), deleted = 0, updated_at = ?
         WHERE stash_name = ? AND path = ? AND head_version = ? AND ${operationFence.sql}
           AND EXISTS (SELECT 1 FROM versions
             WHERE stash_name = ? AND path = ? AND version = ?)`,
      )
      .bind(
        version,
        input.stash,
        input.path,
        input.toVersion,
        input.createdAt,
        input.stash,
        input.path,
        input.expectedVersion,
        ...operationFence.params,
        input.stash,
        input.path,
        version,
      ),
    sealStatement(db, { stash: input.stash, id: input.commitId }),
  ];
}
