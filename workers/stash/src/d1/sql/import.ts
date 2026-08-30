import type { PreparedBlob } from "../blobs.js";
import { fence, type SqlFragment } from "./write-primitives.js";
import { commitInsertStatement, sealStatement } from "./commits.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

type Preparer = Pick<D1DatabaseSession, "prepare">;

interface PreparedImportBase {
  version: number;
  size: number;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
}

type PreparedImportPut = PreparedImportBase &
  PreparedBlob & {
    kind: "put";
    hash: string;
    rollbackOf: null;
  };

export type PreparedImportVersion =
  | PreparedImportPut
  | (PreparedImportBase & {
      kind: "delete";
      body: null;
      hash: null;
      rollbackOf: null;
    })
  | (PreparedImportBase & {
      kind: "rollback";
      body: null;
      hash: string;
      rollbackOf: number;
    });

export interface ImportBatchInput {
  commitId: string;
  createdBy: string;
  createdAt: number;
  stash: string;
  path: string;
  expectedVersion: number | null;
  versions: PreparedImportVersion[];
}

export interface ImportBatch {
  statements: D1PreparedStatement[];
}

function operationFence(input: ImportBatchInput): SqlFragment {
  return input.expectedVersion === null
    ? fence.create(input.stash, input.path)
    : fence.put(input.stash, input.path, input.expectedVersion);
}

function putStatements(
  db: Preparer,
  input: ImportBatchInput,
  entry: PreparedImportPut,
  importFence: SqlFragment,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${importFence.sql}
         ON CONFLICT(stash_name, hash) DO NOTHING`,
      )
      .bind(
        input.stash,
        entry.hash,
        entry.body,
        entry.r2_key,
        entry.size,
        entry.createdAt,
        ...importFence.params,
      ),
    db
      .prepare(
        `INSERT INTO versions
          (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
           rollback_of, author, message, meta_json, created_at, commit_id)
         SELECT ?, ?, ?, 'put', ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${importFence.sql}`,
      )
      .bind(
        input.stash,
        input.path,
        entry.version,
        entry.hash,
        entry.size,
        DEFAULT_CONTENT_TYPE,
        entry.author,
        entry.message,
        entry.metaJson,
        entry.createdAt,
        input.commitId,
        ...importFence.params,
      ),
  ];
}

function deleteStatement(
  db: Preparer,
  input: ImportBatchInput,
  entry: PreparedImportVersion,
  importFence: SqlFragment,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO versions
        (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
         rollback_of, author, message, meta_json, created_at, commit_id)
       SELECT ?, ?, ?, 'delete', NULL, 0, ?, NULL, ?, ?, ?, ?, ? WHERE ${importFence.sql}`,
    )
    .bind(
      input.stash,
      input.path,
      entry.version,
      DEFAULT_CONTENT_TYPE,
      entry.author,
      entry.message,
      entry.metaJson,
      entry.createdAt,
      input.commitId,
      ...importFence.params,
    );
}

function rollbackStatement(
  db: Preparer,
  input: ImportBatchInput,
  entry: PreparedImportVersion,
  importFence: SqlFragment,
): D1PreparedStatement {
  if (entry.rollbackOf === null) throw new Error("Invalid prepared import rollback");
  return db
    .prepare(
      `INSERT INTO versions
        (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
         rollback_of, author, message, meta_json, created_at, commit_id)
       SELECT ?, ?, ?, 'rollback', target.blob_hash, target.size_bytes, target.content_type,
         target.version, ?, ?, ?, ?, ?
       FROM versions target
       WHERE target.stash_name = ? AND target.path = ? AND target.version = ?
         AND target.blob_hash IS NOT NULL AND ${importFence.sql}`,
    )
    .bind(
      input.stash,
      input.path,
      entry.version,
      entry.author,
      entry.message,
      entry.metaJson,
      entry.createdAt,
      input.commitId,
      input.stash,
      input.path,
      entry.rollbackOf,
      ...importFence.params,
    );
}

// See #384: commitBatch cannot model N sequential versions on one path.
export function importBatch(db: Preparer, input: ImportBatchInput): ImportBatch {
  if (input.versions.length === 0) throw new Error("Import batch requires versions");
  const importFence = operationFence(input);
  const statements: D1PreparedStatement[] = [
    commitInsertStatement(
      db,
      {
        id: input.commitId,
        stash_name: input.stash,
        source: "import",
        source_id: null,
        author: "",
        message: "",
        meta_json: "{}",
        entry_count: input.versions.length,
        reverts_commit_id: null,
        idempotency_key: null,
        request_hash: null,
        created_by: input.createdBy,
        created_at: input.createdAt,
      },
      importFence,
    ),
  ];

  for (const entry of input.versions) {
    if (entry.kind === "put") {
      statements.push(...putStatements(db, input, entry, importFence));
    } else if (entry.kind === "delete") {
      statements.push(deleteStatement(db, input, entry, importFence));
    } else {
      statements.push(rollbackStatement(db, input, entry, importFence));
    }
  }

  const first = input.versions[0];
  const last = input.versions.at(-1);
  if (!first || !last) throw new Error("Import batch requires versions");
  const finalVersion = last.version;
  const finalHash = last.kind === "delete" ? null : last.hash;
  const deleted = last.kind === "delete" ? 1 : 0;

  if (input.expectedVersion === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO files
            (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${importFence.sql}
             AND EXISTS (SELECT 1 FROM versions
               WHERE stash_name = ? AND path = ? AND version = ?)`,
        )
        .bind(
          input.stash,
          input.path,
          finalVersion,
          finalHash,
          deleted,
          first.createdAt,
          last.createdAt,
          ...importFence.params,
          input.stash,
          input.path,
          finalVersion,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE files SET head_version = ?, head_hash = ?, deleted = ?, updated_at = ?
           WHERE stash_name = ? AND path = ? AND head_version = ? AND ${importFence.sql}
             AND EXISTS (SELECT 1 FROM versions
               WHERE stash_name = ? AND path = ? AND version = ?)`,
        )
        .bind(
          finalVersion,
          finalHash,
          deleted,
          last.createdAt,
          input.stash,
          input.path,
          input.expectedVersion,
          ...importFence.params,
          input.stash,
          input.path,
          finalVersion,
        ),
    );
  }

  statements.push(sealStatement(db, { stash: input.stash, id: input.commitId }));
  return { statements };
}
