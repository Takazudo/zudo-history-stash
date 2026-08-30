export interface SqlFragment {
  sql: string;
  params: unknown[];
}

export interface LedgerInsert {
  key: string;
  requestHash: string;
  statusCode: number;
}

type Preparer = Pick<D1DatabaseSession, "prepare">;

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
