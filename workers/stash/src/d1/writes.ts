import {
  DeleteFileBody,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_BODY_BYTES,
  PutFileBody,
  RollbackBody,
  canonicalJson,
  isWellFormedString,
  requestHashInput,
  sha256Hex,
  utf8ByteLength,
  validatePath,
  validateStashName,
  type ApiError,
  type Current,
  type DeleteResult,
  type PutResult,
  type Result,
  type RollbackResult,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { prepareBlob, type BlobGenerationFactory } from "./blobs.js";
import type { IdempotencyRow, VersionRow } from "./schema.js";
import {
  selectHeadForWrite,
  selectLedger,
  selectVersionMeta,
  type LedgerInsert,
} from "./sql/write-primitives.js";
import type { StoreDependencies } from "./store.js";
import { commitBatch, mintCommitId, SELECT_COMMIT_VERSIONS } from "./sql/commits.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

interface HeadForWriteRow {
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
  kind: "put" | "delete" | "rollback";
  author: string;
  created_at: number;
  representation: "text" | "binary";
  content_type: string;
}

interface VersionMetaRow extends VersionRow {
  previous_blob_hash: string | null;
  previous_representation: "text" | "binary" | null;
  previous_content_type: string | null;
}

export interface WriteOptions {
  idempotencyKey?: string;
  createdBy?: string;
}

export type StoreWriteResult<T> =
  | (Extract<Result<T>, { ok: true }> & { statusCode: number; replayed?: true })
  | Extract<Result<T>, { ok: false }>;

export interface StashWrites {
  put(
    stash: string,
    path: string,
    input: PutFileBody,
    options?: WriteOptions,
  ): Promise<StoreWriteResult<PutResult>>;
  delete(
    stash: string,
    path: string,
    input: DeleteFileBody,
    options?: WriteOptions,
  ): Promise<StoreWriteResult<DeleteResult>>;
  rollback(
    stash: string,
    path: string,
    input: RollbackBody,
    options?: WriteOptions,
  ): Promise<StoreWriteResult<RollbackResult>>;
}

export interface WriteDependencies extends StoreDependencies {
  onBeforeCommit?: () => void | Promise<void>;
  createBlobGeneration?: BlobGenerationFactory;
  // Deliberate single-path counterpart to alterCommitStatementsForTest; keep both race seams.
  alterWriteStatementsForTest?: (statements: D1PreparedStatement[]) => D1PreparedStatement[];
}

function failure<T>(
  code: ApiError["code"],
  status: number,
  message: string,
  current?: Current,
): StoreWriteResult<T> {
  return { ok: false, error: { code, status, message }, ...(current ? { current } : {}) };
}

function currentFromHead(row: HeadForWriteRow): Current {
  return {
    version: row.head_version,
    hash: row.head_hash,
    deleted: row.deleted === 1,
    kind: row.kind,
    author: row.author,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function validateCommon<T>(
  stash: string,
  path: string,
  schema: { safeParse(value: unknown): { success: boolean } },
  input: T,
  options: WriteOptions,
): StoreWriteResult<never> | null {
  const stashValidation = validateStashName(stash);
  if (!stashValidation.ok) return failure("validation", 400, stashValidation.message);
  const pathValidation = validatePath(path);
  if (!pathValidation.ok) return failure(pathValidation.error, 400, pathValidation.message);
  if (!schema.safeParse(input).success) return failure("validation", 400, "Invalid write input");
  const key = options.idempotencyKey;
  if (key !== undefined && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS)) {
    return failure("validation", 400, "Invalid idempotency key");
  }
  return null;
}

async function readHead(
  db: D1DatabaseSession,
  stash: string,
  path: string,
): Promise<HeadForWriteRow | null> {
  return db.prepare(selectHeadForWrite).bind(stash, path).first<HeadForWriteRow>();
}

async function readVersion(
  db: D1DatabaseSession,
  stash: string,
  path: string,
  version: number,
): Promise<VersionMetaRow | null> {
  return db.prepare(selectVersionMeta).bind(stash, path, version).first<VersionMetaRow>();
}

async function readLedger(
  db: D1DatabaseSession,
  stash: string,
  key: string,
): Promise<IdempotencyRow | null> {
  return db.prepare(selectLedger).bind(stash, key).first<IdempotencyRow>();
}

async function stashIsLive(db: D1DatabaseSession, stash: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL")
      .bind(stash)
      .first()) !== null
  );
}

function created<T>(value: T, statusCode: number): StoreWriteResult<T> {
  return { ok: true, value, statusCode };
}

async function replay<T>(
  db: D1DatabaseSession,
  ledger: IdempotencyRow,
  requestHash: string,
): Promise<StoreWriteResult<T>> {
  if (ledger.request_hash !== requestHash) {
    return failure("idempotency-key-reused", 422, "Idempotency key was used for another request");
  }
  const row = await readVersion(db, ledger.stash_name, ledger.path, ledger.version);
  if (!row) return failure("internal", 500, "Idempotency result is missing");
  const base = {
    commitId: row.commit_id,
    version: row.version,
    changeId: row.id,
    createdAt: new Date(row.created_at).toISOString(),
  };
  let value: PutResult | DeleteResult | RollbackResult;
  if (row.kind === "delete") {
    value = base;
  } else if (row.kind === "rollback") {
    if (row.blob_hash === null || row.rollback_of === null) {
      return failure("internal", 500, "Invalid rollback ledger result");
    }
    value = {
      ...base,
      hash: row.blob_hash,
      rollbackOf: row.rollback_of,
      identicalToHead:
        row.blob_hash === row.previous_blob_hash &&
        row.representation === row.previous_representation &&
        row.content_type === row.previous_content_type,
      representation: row.representation,
      contentType: row.content_type,
      byteSize: row.size_bytes,
      etag: row.application_etag ?? row.blob_hash,
    };
  } else {
    if (row.blob_hash === null) return failure("internal", 500, "Invalid put ledger result");
    value = { ...base, hash: row.blob_hash, size: row.size_bytes };
  }
  return {
    ok: true,
    value: value as T,
    statusCode: ledger.status_code,
    replayed: true,
  };
}

async function existingReplay<T>(
  db: D1DatabaseSession,
  stash: string,
  key: string | undefined,
  requestHash: string,
): Promise<StoreWriteResult<T> | null> {
  if (key === undefined) return null;
  const ledger = await readLedger(db, stash, key);
  return ledger ? replay<T>(db, ledger, requestHash) : null;
}

export async function postBatchRefusal<T, Head>(input: {
  stashIsLive: () => Promise<boolean>;
  replay: () => Promise<T | null>;
  stashNotFound: () => T;
  readHead: () => Promise<Head | null>;
  classify: (head: Head | null) => T | Promise<T>;
}): Promise<T> {
  if (!(await input.stashIsLive())) return input.stashNotFound();
  const replayed = await input.replay();
  if (replayed !== null) return replayed;
  return input.classify(await input.readHead());
}

function batchWon(results: D1Result[]): boolean {
  return results.at(-1)?.meta.changes === 1;
}

async function committedChangeId(
  db: D1DatabaseSession,
  stash: string,
  commitId: string,
): Promise<number | null> {
  const rows = await db.prepare(SELECT_COMMIT_VERSIONS).bind(stash, commitId).all<{ id: number }>();
  const id = rows.results.length === 1 ? rows.results[0]?.id : undefined;
  return typeof id === "number" && id > 0 ? id : null;
}

export function createWrites(env: Env, deps: WriteDependencies): StashWrites {
  async function put(
    stash: string,
    path: string,
    input: PutFileBody,
    options: WriteOptions = {},
  ): Promise<StoreWriteResult<PutResult>> {
    if (typeof input?.body !== "string") {
      return (
        validateCommon(stash, path, PutFileBody, input, options) ??
        failure("validation", 400, "Invalid write input")
      );
    }
    if (!isWellFormedString(input.body)) {
      return failure("body-not-well-formed", 400, "Body is not well-formed Unicode");
    }
    const size = utf8ByteLength(input.body);
    if (size > MAX_BODY_BYTES) return failure("payload-too-large", 413, "Body is too large");
    const invalid = validateCommon(stash, path, PutFileBody, input, options);
    if (invalid) return invalid;

    const hash = await sha256Hex(input.body);
    const contentType = input.contentType ?? DEFAULT_CONTENT_TYPE;
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("put", {
          path,
          expectedVersion: input.expectedVersion,
          bodyHash: hash,
          contentType,
          author: input.author,
          message: input.message,
          meta: input.meta,
          skipIfUnchanged: input.skipIfUnchanged,
        }),
      ),
    );
    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const priorReplay = await existingReplay<PutResult>(
      db,
      stash,
      options.idempotencyKey,
      requestHash,
    );
    if (priorReplay) return priorReplay;

    const head = await readHead(db, stash, path);
    if (input.expectedVersion === null) {
      if (head) return failure("exists", 409, "File already exists", currentFromHead(head));
    } else if (!head) {
      return failure("not-found", 404, "File not found");
    } else if (head.head_version !== input.expectedVersion) {
      return failure("stale", 409, "Expected version is stale", currentFromHead(head));
    }
    if (
      input.skipIfUnchanged &&
      head &&
      head.deleted === 0 &&
      head.head_hash === hash &&
      head.representation === "text" &&
      head.content_type === contentType
    ) {
      return created({ unchanged: true, version: head.head_version }, 200);
    }

    const prepared = await prepareBlob(env, stash, hash, input.body, deps.createBlobGeneration);
    await deps.onBeforeCommit?.();
    const createdAt = deps.now();
    const commitId = mintCommitId(createdAt, deps.createId);
    const ledger: LedgerInsert | undefined = options.idempotencyKey
      ? { key: options.idempotencyKey, requestHash, statusCode: 201 }
      : undefined;
    const author = input.author ?? "";
    const message = input.message ?? "";
    const metaJson = canonicalJson(input.meta ?? {});
    try {
      let statements = commitBatch(db, {
        row: {
          id: commitId,
          stash_name: stash,
          source: "put",
          source_id: null,
          author,
          message,
          meta_json: metaJson,
          entry_count: 1,
          reverts_commit_id: null,
          idempotency_key: null,
          request_hash: null,
          created_by: options.createdBy ?? "system",
          created_at: createdAt,
        },
        entries: [
          {
            op: "put",
            representation: "text",
            path,
            expectedVersion: input.expectedVersion,
            version: (input.expectedVersion ?? 0) + 1,
            hash,
            size,
            contentType,
            author,
            message,
            metaJson,
            createdAt,
            ...prepared,
          },
        ],
        // The ledger can follow entries because commitBatch fences it on the position-independent commit row.
        ...(ledger ? { ledger } : {}),
      });
      statements = deps.alterWriteStatementsForTest?.(statements) ?? statements;
      const results = await db.batch(statements);
      if (batchWon(results)) {
        const id = await committedChangeId(db, stash, commitId);
        if (id === null) return failure("internal", 500, "Missing put change id");
        return created(
          {
            commitId,
            version: (input.expectedVersion ?? 0) + 1,
            hash,
            size,
            changeId: id,
            createdAt: new Date(createdAt).toISOString(),
          },
          201,
        );
      }
    } catch {
      // A concurrent, independently fenced batch may win the unique ledger key.
    }
    return postBatchRefusal({
      stashIsLive: () => stashIsLive(db, stash),
      replay: () => existingReplay<PutResult>(db, stash, options.idempotencyKey, requestHash),
      stashNotFound: () => failure("not-found", 404, "Stash not found"),
      readHead: () => readHead(db, stash, path),
      classify: (currentHead) => {
        if (input.expectedVersion === null) {
          return currentHead
            ? failure("exists", 409, "File already exists", currentFromHead(currentHead))
            : failure("internal", 500, "Put batch failed without a competing write");
        }
        if (!currentHead) return failure("not-found", 404, "File not found");
        if (currentHead.head_version === input.expectedVersion) {
          return failure("internal", 500, "Put batch failed without a competing write");
        }
        return failure("stale", 409, "Expected version is stale", currentFromHead(currentHead));
      },
    });
  }

  async function deleteFile(
    stash: string,
    path: string,
    input: DeleteFileBody,
    options: WriteOptions = {},
  ): Promise<StoreWriteResult<DeleteResult>> {
    const invalid = validateCommon(stash, path, DeleteFileBody, input, options);
    if (invalid) return invalid;
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("delete", {
          path,
          expectedVersion: input.expectedVersion,
          author: input.author,
          message: input.message,
        }),
      ),
    );
    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const priorReplay = await existingReplay<DeleteResult>(
      db,
      stash,
      options.idempotencyKey,
      requestHash,
    );
    if (priorReplay) return priorReplay;
    const head = await readHead(db, stash, path);
    if (!head) return failure("not-found", 404, "File not found");
    if (head.head_version !== input.expectedVersion) {
      return failure("stale", 409, "Expected version is stale", currentFromHead(head));
    }
    if (head.deleted === 1) {
      return failure("already-deleted", 409, "File is already deleted", currentFromHead(head));
    }

    await deps.onBeforeCommit?.();
    const createdAt = deps.now();
    const commitId = mintCommitId(createdAt, deps.createId);
    const ledger: LedgerInsert | undefined = options.idempotencyKey
      ? { key: options.idempotencyKey, requestHash, statusCode: 200 }
      : undefined;
    const author = input.author ?? "";
    const message = input.message ?? "";
    try {
      let statements = commitBatch(db, {
        row: {
          id: commitId,
          stash_name: stash,
          source: "delete",
          source_id: null,
          author,
          message,
          meta_json: "{}",
          entry_count: 1,
          reverts_commit_id: null,
          idempotency_key: null,
          request_hash: null,
          created_by: options.createdBy ?? "system",
          created_at: createdAt,
        },
        entries: [
          {
            op: "delete",
            path,
            expectedVersion: input.expectedVersion,
            version: input.expectedVersion + 1,
            author,
            message,
            metaJson: "{}",
            createdAt,
          },
        ],
        // The ledger can follow entries because commitBatch fences it on the position-independent commit row.
        ...(ledger ? { ledger } : {}),
      });
      statements = deps.alterWriteStatementsForTest?.(statements) ?? statements;
      const results = await db.batch(statements);
      if (batchWon(results)) {
        const id = await committedChangeId(db, stash, commitId);
        if (id === null) return failure("internal", 500, "Missing delete change id");
        return created(
          {
            commitId,
            version: input.expectedVersion + 1,
            changeId: id,
            createdAt: new Date(createdAt).toISOString(),
          },
          200,
        );
      }
    } catch {
      // See put: only a concurrent ledger claim is recoverable as a replay.
    }
    return postBatchRefusal({
      stashIsLive: () => stashIsLive(db, stash),
      replay: () => existingReplay<DeleteResult>(db, stash, options.idempotencyKey, requestHash),
      stashNotFound: () => failure("not-found", 404, "Stash not found"),
      readHead: () => readHead(db, stash, path),
      classify: (currentHead) => {
        if (!currentHead) return failure("not-found", 404, "File not found");
        if (currentHead.head_version !== input.expectedVersion) {
          return failure("stale", 409, "Expected version is stale", currentFromHead(currentHead));
        }
        if (currentHead.deleted === 1) {
          return failure(
            "already-deleted",
            409,
            "File is already deleted",
            currentFromHead(currentHead),
          );
        }
        return failure("internal", 500, "Delete batch failed without a competing write");
      },
    });
  }

  async function rollback(
    stash: string,
    path: string,
    input: RollbackBody,
    options: WriteOptions = {},
  ): Promise<StoreWriteResult<RollbackResult>> {
    const invalid = validateCommon(stash, path, RollbackBody, input, options);
    if (invalid) return invalid;
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("rollback", {
          path,
          expectedVersion: input.expectedVersion,
          toVersion: input.toVersion,
          author: input.author,
          message: input.message,
          meta: input.meta,
        }),
      ),
    );
    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const priorReplay = await existingReplay<RollbackResult>(
      db,
      stash,
      options.idempotencyKey,
      requestHash,
    );
    if (priorReplay) return priorReplay;
    const head = await readHead(db, stash, path);
    if (!head) return failure("not-found", 404, "File not found");
    if (head.head_version !== input.expectedVersion) {
      return failure("stale", 409, "Expected version is stale", currentFromHead(head));
    }
    const target = await readVersion(db, stash, path, input.toVersion);
    if (!target)
      return failure("version-not-found", 404, "Version not found", currentFromHead(head));
    if (target.blob_hash === null) {
      return failure(
        "rollback-target-tombstone",
        422,
        "Cannot rollback to a tombstone",
        currentFromHead(head),
      );
    }

    await deps.onBeforeCommit?.();
    const createdAt = deps.now();
    const commitId = mintCommitId(createdAt, deps.createId);
    const ledger: LedgerInsert | undefined = options.idempotencyKey
      ? { key: options.idempotencyKey, requestHash, statusCode: 201 }
      : undefined;
    const author = input.author ?? "";
    const message = input.message ?? "";
    const versionMessage = message === "" ? `Rollback to v${input.toVersion}` : message;
    const metaJson = canonicalJson(input.meta ?? {});
    try {
      let statements = commitBatch(db, {
        row: {
          id: commitId,
          stash_name: stash,
          source: "rollback",
          source_id: null,
          author,
          message,
          meta_json: metaJson,
          entry_count: 1,
          reverts_commit_id: null,
          idempotency_key: null,
          request_hash: null,
          created_by: options.createdBy ?? "system",
          created_at: createdAt,
        },
        entries: [
          {
            op: "rollback",
            path,
            expectedVersion: input.expectedVersion,
            version: input.expectedVersion + 1,
            toVersion: input.toVersion,
            author,
            message: versionMessage,
            metaJson,
            createdAt,
          },
        ],
        // The ledger can follow entries because commitBatch fences it on the position-independent commit row.
        ...(ledger ? { ledger } : {}),
      });
      statements = deps.alterWriteStatementsForTest?.(statements) ?? statements;
      const results = await db.batch(statements);
      if (batchWon(results)) {
        const id = await committedChangeId(db, stash, commitId);
        if (id === null) return failure("internal", 500, "Missing rollback change id");
        return created(
          {
            commitId,
            version: input.expectedVersion + 1,
            hash: target.blob_hash,
            rollbackOf: input.toVersion,
            identicalToHead:
              target.blob_hash === head.head_hash &&
              target.representation === head.representation &&
              target.content_type === head.content_type,
            changeId: id,
            createdAt: new Date(createdAt).toISOString(),
            representation: target.representation,
            contentType: target.content_type,
            byteSize: target.size_bytes,
            etag: target.application_etag ?? target.blob_hash,
          },
          201,
        );
      }
    } catch {
      // See put: only a concurrent ledger claim is recoverable as a replay.
    }
    return postBatchRefusal({
      stashIsLive: () => stashIsLive(db, stash),
      replay: () => existingReplay<RollbackResult>(db, stash, options.idempotencyKey, requestHash),
      stashNotFound: () => failure("not-found", 404, "Stash not found"),
      readHead: () => readHead(db, stash, path),
      classify: async (currentHead) => {
        if (!currentHead) return failure("not-found", 404, "File not found");
        const currentTarget = await readVersion(db, stash, path, input.toVersion);
        if (!currentTarget) {
          return failure(
            "version-not-found",
            404,
            "Version not found",
            currentFromHead(currentHead),
          );
        }
        if (currentTarget.blob_hash === null) {
          return failure(
            "rollback-target-tombstone",
            422,
            "Cannot rollback to a tombstone",
            currentFromHead(currentHead),
          );
        }
        if (currentHead.head_version === input.expectedVersion) {
          return failure("internal", 500, "Rollback batch failed without a competing write");
        }
        return failure("stale", 409, "Expected version is stale", currentFromHead(currentHead));
      },
    });
  }

  return {
    put,
    delete: deleteFile,
    rollback,
  };
}
