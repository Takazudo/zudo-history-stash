import {
  CreateCommitBody,
  COMMIT_DIFF_INLINE_ENTRIES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListCommitsQuery,
  MAX_COMMIT_INLINE_BYTES,
  MAX_META_BYTES,
  RevertCommitBody,
  StashError,
  canonicalJson,
  computeDiff,
  isWellFormedString,
  sha256Hex,
  utf8ByteLength,
  validateStashName,
  type ApiError,
  type CommitConflict,
  type CommitEntryInput,
  type CommitEntryRecord,
  type CommitDiffResult,
  type CommitListResponse,
  type CommitRecord,
  type CommitResult,
  type CreateCommitBody as CreateCommitBodyType,
  type Current,
  type ListCommitsQuery as ListCommitsQueryType,
  type RevertCommitBody as RevertCommitBodyType,
  type Result,
} from "@takazudo/zudo-history-stash-core";
import type { Principal } from "../context.js";
import type { Env } from "../env.js";
import { parseBinarySettings } from "../binary-config.js";
import { prepareBlob, type BlobGenerationFactory, type PreparedBlob } from "./blobs.js";
import { createReads } from "./reads.js";
import type { CommitRow } from "./schema.js";
import { commitBatch, mintCommitId, type PreparedCommitEntry } from "./sql/commits.js";
import type { StoreDependencies } from "./store.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

interface CommitSnapshotRow {
  entry_index: number;
  path: string;
  expected_version: number | null;
  head_version: number | null;
  head_hash: string | null;
  deleted: 0 | 1 | null;
  head_kind: "put" | "delete" | "rollback" | null;
  head_author: string | null;
  head_created_at: number | null;
  head_representation: "text" | "binary" | null;
  head_content_type: string | null;
  target_version: number | null;
  target_hash: string | null;
  target_size: number | null;
  target_content_type: string | null;
  target_representation: "text" | "binary" | null;
  newest_change_id: number;
}

interface CommittedVersionRow {
  id: number;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  size_bytes: number;
  content_type: string;
  representation: "text" | "binary";
  rollback_of: number | null;
  previous_hash: string | null;
  previous_content_type: string | null;
  previous_representation: "text" | "binary" | null;
}

interface CommitVersionRow extends CommittedVersionRow {
  previous_version: number | null;
  previous_size: number | null;
}

type CommitFailure = Extract<Result<CommitResult>, { ok: false }> & {
  conflicts?: CommitConflict[];
};
export type StoreCommitResult =
  | (Extract<Result<CommitResult>, { ok: true }> & { statusCode: 201; replayed?: true })
  | CommitFailure;

export interface CommitOptions {
  principal: string | Principal;
  idempotencyKey?: string;
  onCommitted?: (result: CommitResult) => void | Promise<void>;
  source?: "commit" | "revert";
  revertsCommitId?: string;
  requestHash?: string;
}

export interface StashCommits {
  createCommit(
    stash: string,
    input: CreateCommitBodyType,
    options: CommitOptions,
  ): Promise<StoreCommitResult>;
  getCommit(stash: string, id: string): Promise<CommitRecord | null>;
  listCommits(stash: string, query?: Partial<ListCommitsQueryType>): Promise<CommitListResponse>;
  getCommitDiff(
    stash: string,
    id: string,
    query?: { context?: number; path?: string },
  ): Promise<CommitDiffResult | null>;
  revertCommit(
    stash: string,
    id: string,
    input: RevertCommitBodyType,
    options: CommitOptions,
  ): Promise<StoreCommitResult>;
}

export interface CommitDependencies extends StoreDependencies {
  onBeforeCommit?: () => void | Promise<void>;
  createBlobGeneration?: BlobGenerationFactory;
  alterCommitStatementsForTest?: (statements: D1PreparedStatement[]) => D1PreparedStatement[];
}

function failure(
  code: ApiError["code"],
  status: number,
  message: string,
  conflicts?: CommitConflict[],
): CommitFailure {
  return {
    ok: false,
    error: { code, status, message },
    ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
  };
}

function createdBy(principal: CommitOptions["principal"]): string {
  if (typeof principal === "string") return principal;
  return principal.kind === "admin" ? "admin" : principal.tokenId;
}

function currentFromSnapshot(row: CommitSnapshotRow): Current | null {
  if (
    row.head_version === null ||
    row.deleted === null ||
    row.head_kind === null ||
    row.head_author === null ||
    row.head_created_at === null
  ) {
    return null;
  }
  return {
    version: row.head_version,
    hash: row.head_hash,
    deleted: row.deleted === 1,
    kind: row.head_kind,
    author: row.head_author,
    createdAt: new Date(row.head_created_at).toISOString(),
  };
}

function snapshotPayload(entries: CommitEntryInput[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      op: entry.op,
      path: entry.path,
      expectedVersion: entry.expectedVersion,
      ...(entry.op === "rollback"
        ? { targetPath: entry.path, targetVersion: entry.toVersion }
        : {}),
      ...(entry.op === "copy"
        ? { targetPath: entry.from.path, targetVersion: entry.from.version }
        : {}),
    })),
  );
}

async function readSnapshot(
  db: D1DatabaseSession,
  stash: string,
  entries: CommitEntryInput[],
): Promise<CommitSnapshotRow[]> {
  const rows = await db
    .prepare(
      `SELECT CAST(e.key AS INTEGER) AS entry_index,
         json_extract(e.value, '$.path') AS path,
         json_extract(e.value, '$.expectedVersion') AS expected_version,
         f.head_version, f.head_hash, f.deleted,
         head.kind AS head_kind, head.author AS head_author,
         head.created_at AS head_created_at, head.representation AS head_representation,
         head.content_type AS head_content_type,
         target.version AS target_version, target.blob_hash AS target_hash,
         target.size_bytes AS target_size, target.content_type AS target_content_type,
         target.representation AS target_representation,
         COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) AS newest_change_id
       FROM json_each(?) AS e
       LEFT JOIN files AS f
         ON f.stash_name = ? AND f.path = json_extract(e.value, '$.path')
       LEFT JOIN versions AS head
         ON head.stash_name = f.stash_name AND head.path = f.path
           AND head.version = f.head_version
       LEFT JOIN versions AS target
         ON target.stash_name = ?
           AND target.path = json_extract(e.value, '$.targetPath')
           AND target.version = json_extract(e.value, '$.targetVersion')
       ORDER BY CAST(e.key AS INTEGER)`,
    )
    .bind(stash, snapshotPayload(entries), stash, stash)
    .all<CommitSnapshotRow>();
  return rows.results;
}

function entryConflicts(
  entries: CommitEntryInput[],
  snapshot: CommitSnapshotRow[],
): CommitConflict[] {
  const conflicts: CommitConflict[] = [];
  entries.forEach((entry, index) => {
    const row = snapshot[index];
    if (!row) {
      conflicts.push({ path: entry.path, expectedVersion: entry.expectedVersion, current: null });
      return;
    }
    const current = currentFromSnapshot(row);
    let refused =
      entry.expectedVersion === null
        ? current !== null
        : current === null || current.version !== entry.expectedVersion;
    if (entry.op === "delete" && current?.deleted === true) refused = true;
    if (
      (entry.op === "rollback" || entry.op === "copy") &&
      (row.target_version === null || row.target_hash === null)
    ) {
      refused = true;
    }
    if (refused) {
      conflicts.push({ path: entry.path, expectedVersion: entry.expectedVersion, current });
    }
  });
  return conflicts;
}

function conflictFailure(conflicts: CommitConflict[]): CommitFailure {
  if (conflicts.length === 1 && conflicts[0]?.current === null) {
    return failure("not-found", 404, `File not found: ${conflicts[0].path}`, conflicts);
  }
  return failure("commit-conflict", 409, "One or more commit entries conflict", conflicts);
}

async function stashIsLive(db: D1DatabaseSession, stash: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL")
      .bind(stash)
      .first()) !== null
  );
}

async function existingCommit(
  db: D1DatabaseSession,
  stash: string,
  key: string | undefined,
): Promise<CommitRow | null> {
  if (key === undefined) return null;
  return db
    .prepare("SELECT * FROM commits WHERE stash_name = ? AND idempotency_key = ? AND sealed = 1")
    .bind(stash, key)
    .first<CommitRow>();
}

async function resultFromCommit(
  db: D1DatabaseSession,
  commit: CommitRow,
  requestedEntries: CommitEntryInput[],
): Promise<CommitResult | null> {
  const rows = await db
    .prepare(
      `SELECT id, path, version, kind, blob_hash, size_bytes, content_type,
         representation, rollback_of,
         (SELECT previous.blob_hash FROM versions AS previous
          WHERE previous.stash_name = versions.stash_name
            AND previous.path = versions.path AND previous.version = versions.version - 1
         ) AS previous_hash,
         (SELECT previous.content_type FROM versions AS previous
          WHERE previous.stash_name = versions.stash_name
            AND previous.path = versions.path AND previous.version = versions.version - 1
         ) AS previous_content_type,
         (SELECT previous.representation FROM versions AS previous
          WHERE previous.stash_name = versions.stash_name
            AND previous.path = versions.path AND previous.version = versions.version - 1
         ) AS previous_representation
       FROM versions WHERE stash_name = ? AND commit_id = ? ORDER BY id`,
    )
    .bind(commit.stash_name, commit.id)
    .all<CommittedVersionRow>();
  if (
    rows.results.length !== commit.entry_count ||
    commit.first_change_id === null ||
    commit.last_change_id === null
  ) {
    return null;
  }
  const entries: CommitEntryRecord[] = [];
  for (const [index, row] of rows.results.entries()) {
    const requested = requestedEntries[index];
    if (!requested || requested.path !== row.path) return null;
    entries.push({
      path: row.path,
      op: requested.op,
      version: row.version,
      kind: row.kind,
      changeId: row.id,
      hash: row.blob_hash,
      size: row.size_bytes,
      contentType: row.content_type,
      representation: row.representation,
      rollbackOf: row.rollback_of,
      ...(requested.op === "copy" ? { copiedFrom: requested.from } : {}),
      ...(requested.op === "rollback"
        ? {
            identicalToHead:
              row.blob_hash === row.previous_hash &&
              row.content_type === row.previous_content_type &&
              row.representation === row.previous_representation,
          }
        : {}),
    });
  }
  return {
    id: commit.id,
    stash: commit.stash_name,
    source: commit.source,
    sourceId: commit.source_id,
    author: commit.author,
    message: commit.message,
    meta: JSON.parse(commit.meta_json) as CommitResult["meta"],
    entryCount: commit.entry_count,
    firstChangeId: commit.first_change_id,
    lastChangeId: commit.last_change_id,
    revertsCommitId: commit.reverts_commit_id,
    createdBy: commit.created_by,
    createdAt: new Date(commit.created_at).toISOString(),
    entries,
  };
}

function operationFromVersion(row: Pick<CommittedVersionRow, "kind">): CommitEntryRecord["op"] {
  return row.kind === "rollback" ? "rollback" : row.kind === "delete" ? "delete" : "put";
}

async function commitVersions(
  db: D1DatabaseSession,
  stash: string,
  id: string,
): Promise<CommitVersionRow[]> {
  const rows = await db
    .prepare(
      `SELECT current.id, current.path, current.version, current.kind, current.blob_hash,
         current.size_bytes, current.content_type, current.representation, current.rollback_of,
         previous.version AS previous_version, previous.blob_hash AS previous_hash,
         previous.size_bytes AS previous_size,
         previous.content_type AS previous_content_type,
         previous.representation AS previous_representation
       FROM versions AS current
       LEFT JOIN versions AS previous
         ON previous.stash_name = current.stash_name AND previous.path = current.path
           AND previous.version = current.version - 1
       WHERE current.stash_name = ? AND current.commit_id = ?
       ORDER BY current.id`,
    )
    .bind(stash, id)
    .all<CommitVersionRow>();
  return rows.results;
}

function commitRecord(commit: CommitRow, rows: CommittedVersionRow[]): CommitRecord | null {
  if (
    commit.sealed !== 1 ||
    rows.length !== commit.entry_count ||
    commit.first_change_id === null ||
    commit.last_change_id === null
  ) {
    return null;
  }
  return {
    id: commit.id,
    stash: commit.stash_name,
    source: commit.source,
    sourceId: commit.source_id,
    author: commit.author,
    message: commit.message,
    meta: JSON.parse(commit.meta_json) as CommitRecord["meta"],
    entryCount: commit.entry_count,
    firstChangeId: commit.first_change_id,
    lastChangeId: commit.last_change_id,
    revertsCommitId: commit.reverts_commit_id,
    createdBy: commit.created_by,
    createdAt: new Date(commit.created_at).toISOString(),
    entries: rows.map((row) => ({
      path: row.path,
      op: operationFromVersion(row),
      version: row.version,
      kind: row.kind,
      changeId: row.id,
      hash: row.blob_hash,
      size: row.size_bytes,
      contentType: row.content_type,
      representation: row.representation,
      rollbackOf: row.rollback_of,
      ...(row.kind === "rollback"
        ? {
            identicalToHead:
              row.blob_hash === row.previous_hash &&
              row.content_type === row.previous_content_type &&
              row.representation === row.previous_representation,
          }
        : {}),
    })),
  };
}

function commitSummary(commit: CommitRow): CommitListResponse["commits"][number] | null {
  if (commit.sealed !== 1 || commit.first_change_id === null || commit.last_change_id === null) {
    return null;
  }
  return {
    id: commit.id,
    stash: commit.stash_name,
    source: commit.source,
    sourceId: commit.source_id,
    author: commit.author,
    message: commit.message,
    meta: JSON.parse(commit.meta_json) as CommitRecord["meta"],
    entryCount: commit.entry_count,
    firstChangeId: commit.first_change_id,
    lastChangeId: commit.last_change_id,
    revertsCommitId: commit.reverts_commit_id,
    createdBy: commit.created_by,
    createdAt: new Date(commit.created_at).toISOString(),
  };
}

function encodeCommitCursor(createdAt: number, id: string): string {
  return btoa(`${String(createdAt)}:${id}`);
}

function decodeCommitCursor(value: string): { createdAt: number; id: string } {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new StashError("validation", "Invalid commit cursor.");
  }
  const separator = decoded.indexOf(":");
  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0 || id.length === 0) {
    throw new StashError("validation", "Invalid commit cursor.");
  }
  return { createdAt, id };
}

async function replay(
  db: D1DatabaseSession,
  commit: CommitRow,
  requestHash: string,
  entries: CommitEntryInput[],
): Promise<StoreCommitResult> {
  if (commit.request_hash !== requestHash) {
    return failure("idempotency-key-reused", 422, "Idempotency key was used for another request");
  }
  const value = await resultFromCommit(db, commit, entries);
  if (!value) return failure("internal", 500, "Idempotency result is missing");
  return { ok: true, value, statusCode: 201, replayed: true };
}

function latestChange(snapshot: CommitSnapshotRow[]): number {
  return snapshot[0]?.newest_change_id ?? 0;
}

export function createCommits(env: Env, deps: CommitDependencies): StashCommits {
  async function createCommit(
    stash: string,
    input: CreateCommitBodyType,
    options: CommitOptions,
  ): Promise<StoreCommitResult> {
    const stashValidation = validateStashName(stash);
    if (!stashValidation.ok) return failure("validation", 400, stashValidation.message);
    if (input && typeof input === "object" && Array.isArray(input.entries)) {
      let rawBodyBytes = 0;
      for (const entry of input.entries) {
        if (entry.op !== "put" || !("body" in entry) || typeof entry.body !== "string") continue;
        if (!isWellFormedString(entry.body)) {
          return failure("body-not-well-formed", 400, "Body is not well-formed Unicode");
        }
        rawBodyBytes += utf8ByteLength(entry.body);
      }
      if (rawBodyBytes > MAX_COMMIT_INLINE_BYTES) {
        return failure("payload-too-large", 413, "Commit bodies are too large");
      }
    }
    const parsed = CreateCommitBody.safeParse(input);
    if (!parsed.success) return failure("validation", 400, "Invalid commit input");
    const value = parsed.data;
    if (
      options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length < 1 ||
        options.idempotencyKey.length > IDEMPOTENCY_KEY_MAX_CHARS)
    ) {
      return failure("validation", 400, "Invalid idempotency key");
    }

    let totalBytes = 0;
    const putFacts = new Map<
      number,
      { body: string; hash: string; size: number; contentType: string }
    >();
    const distinctPuts = new Map<string, { body: string; size: number }>();
    for (const [index, entry] of value.entries.entries()) {
      if (entry.op === "put" && !("body" in entry)) {
        return failure(
          "unsupported-representation",
          422,
          "Binary commit entries are not supported by this store",
        );
      }
      if (entry.op !== "put") continue;
      const size = utf8ByteLength(entry.body);
      totalBytes += size;
      const hash = await sha256Hex(entry.body);
      const fact = {
        body: entry.body,
        hash,
        size,
        contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE,
      };
      putFacts.set(index, fact);
      if (!distinctPuts.has(hash)) distinctPuts.set(hash, { body: entry.body, size });
    }
    if (totalBytes > MAX_COMMIT_INLINE_BYTES)
      return failure("payload-too-large", 413, "Commit bodies are too large");

    const requestHash =
      options.requestHash ??
      (await sha256Hex(
        canonicalJson({
          entries: value.entries.map((entry, index) => {
            const fact = putFacts.get(index);
            if (!fact || !("body" in entry)) return entry;
            const { body: _body, ...rest } = entry;
            return { ...rest, bodyHash: fact.hash };
          }),
          author: value.author ?? "",
          message: value.message ?? "",
          meta: value.meta ?? {},
          expectedLastChangeId: value.expectedLastChangeId ?? null,
        }),
      ));
    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const prior = await existingCommit(db, stash, options.idempotencyKey);
    if (prior) return replay(db, prior, requestHash, value.entries);

    const initialSnapshot = await readSnapshot(db, stash, value.entries);
    if (
      value.expectedLastChangeId !== undefined &&
      latestChange(initialSnapshot) !== value.expectedLastChangeId
    ) {
      return failure(
        "stale",
        409,
        `Expected last change ${value.expectedLastChangeId}, newest change is ${latestChange(initialSnapshot)}`,
      );
    }
    const initialConflicts = entryConflicts(value.entries, initialSnapshot);
    if (initialConflicts.length > 0) return conflictFailure(initialConflicts);

    const createdAt = deps.now();
    const commitId = mintCommitId(createdAt, deps.createId);
    const stampedMeta = { ...(value.meta ?? {}), commitId };
    const metaJson = canonicalJson(stampedMeta);
    if (utf8ByteLength(metaJson) > MAX_META_BYTES) {
      return failure("validation", 400, "Stamped commit meta is too large");
    }

    const storageByHash = new Map<string, PreparedBlob>();
    for (const [hash, fact] of distinctPuts) {
      storageByHash.set(
        hash,
        await prepareBlob(env, stash, hash, fact.body, deps.createBlobGeneration),
      );
    }

    await deps.onBeforeCommit?.();
    const prepared: PreparedCommitEntry[] = value.entries.map((entry, index) => {
      const row = initialSnapshot[index];
      if (!row) throw new Error("Missing commit snapshot row");
      const base = {
        path: entry.path,
        expectedVersion: entry.expectedVersion,
        version: (entry.expectedVersion ?? 0) + 1,
        author: value.author ?? "",
        message: value.message ?? "",
        metaJson,
        createdAt,
      };
      if (entry.op === "put" && "body" in entry) {
        const fact = putFacts.get(index);
        if (!fact) throw new Error("Missing commit PUT fact");
        const storage = storageByHash.get(fact.hash);
        if (!storage) throw new Error("Missing prepared commit blob");
        return {
          ...base,
          op: "put",
          hash: fact.hash,
          size: fact.size,
          contentType: fact.contentType,
          ...storage,
        };
      }
      if (entry.op === "copy") return { ...base, op: "copy", from: entry.from };
      if (entry.op === "rollback") return { ...base, op: "rollback", toVersion: entry.toVersion };
      return { ...base, op: "delete" };
    });
    const row = {
      id: commitId,
      stash_name: stash,
      source: options.source ?? ("commit" as const),
      source_id: null,
      author: value.author ?? "",
      message: value.message ?? "",
      meta_json: metaJson,
      entry_count: prepared.length,
      reverts_commit_id: options.revertsCommitId ?? null,
      idempotency_key: options.idempotencyKey ?? null,
      request_hash: requestHash,
      created_by: createdBy(options.principal),
      created_at: createdAt,
    };

    let results: D1Result<unknown>[] | null = null;
    try {
      let statements = commitBatch(db, {
        row,
        entries: prepared,
        ...(value.expectedLastChangeId === undefined
          ? {}
          : { expectedLastChangeId: value.expectedLastChangeId }),
      });
      statements = deps.alterCommitStatementsForTest?.(statements) ?? statements;
      results = await db.batch(statements);
    } catch {
      // UNIQUE idempotency races and CHECK rollbacks are classified by the same durable re-read.
    }
    if (results?.at(-1)?.meta.changes === 1) {
      const persisted = await db
        .prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ? AND sealed = 1")
        .bind(stash, commitId)
        .first<CommitRow>();
      const result = persisted ? await resultFromCommit(db, persisted, value.entries) : null;
      if (!result) return failure("internal", 500, "Missing committed changes");
      await options.onCommitted?.(result);
      return { ok: true, value: result, statusCode: 201 };
    }

    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const racedReplay = await existingCommit(db, stash, options.idempotencyKey);
    if (racedReplay) return replay(db, racedReplay, requestHash, value.entries);
    const finalSnapshot = await readSnapshot(db, stash, value.entries);
    if (
      value.expectedLastChangeId !== undefined &&
      latestChange(finalSnapshot) !== value.expectedLastChangeId
    ) {
      return failure(
        "stale",
        409,
        `Expected last change ${value.expectedLastChangeId}, newest change is ${latestChange(finalSnapshot)}`,
      );
    }
    const conflicts = entryConflicts(value.entries, finalSnapshot);
    return conflicts.length > 0
      ? conflictFailure(conflicts)
      : failure("internal", 500, "Commit batch refused without a competing write");
  }

  async function getCommit(stash: string, id: string): Promise<CommitRecord | null> {
    const db = env.DB.withSession("first-primary");
    const row = await db
      .prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ? AND sealed = 1")
      .bind(stash, id)
      .first<CommitRow>();
    if (row === null) return null;
    return commitRecord(row, await commitVersions(db, stash, id));
  }

  async function listCommits(
    stash: string,
    query: Partial<ListCommitsQueryType> = {},
  ): Promise<CommitListResponse> {
    const parsed = ListCommitsQuery.safeParse(query);
    if (!parsed.success) throw new StashError("validation", "Invalid commit list query.");
    const value = parsed.data;
    const cursor = value.after === undefined ? undefined : decodeCommitCursor(value.after);
    const pathFilter =
      value.path === undefined
        ? ""
        : ` AND EXISTS (
          SELECT 1 FROM versions INDEXED BY versions_stash_commit
          WHERE versions.stash_name = commits.stash_name
            AND versions.commit_id = commits.id AND versions.path = ?
        )`;
    const cursorFilter =
      cursor === undefined ? "" : " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const db = env.DB.withSession("first-primary");
    const totalStatement = db.prepare(
      `SELECT COUNT(*) AS total FROM commits
       WHERE stash_name = ? AND sealed = 1${pathFilter}`,
    );
    const total = await (
      value.path === undefined ? totalStatement.bind(stash) : totalStatement.bind(stash, value.path)
    ).first<{ total: number }>();
    const statement = db.prepare(
      `SELECT * FROM commits
       WHERE stash_name = ? AND sealed = 1${pathFilter}${cursorFilter}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    const bindings: unknown[] = [stash];
    if (value.path !== undefined) bindings.push(value.path);
    if (cursor !== undefined) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    bindings.push(value.limit + 1);
    const rows = await statement.bind(...bindings).all<CommitRow>();
    const hasMore = rows.results.length > value.limit;
    const pageRows = rows.results.slice(0, value.limit);
    const commits = pageRows.map(commitSummary);
    if (commits.some((entry) => entry === null)) {
      throw new StashError("internal", "Stored commit is incomplete.");
    }
    const last = pageRows.at(-1);
    return {
      commits: commits as CommitListResponse["commits"],
      nextAfter: hasMore && last ? encodeCommitCursor(last.created_at, last.id) : null,
      total: total?.total ?? 0,
    };
  }

  async function getCommitDiff(
    stash: string,
    id: string,
    query: { context?: number; path?: string } = {},
  ): Promise<CommitDiffResult | null> {
    if (
      query.context !== undefined &&
      (!Number.isSafeInteger(query.context) || query.context < 0)
    ) {
      throw new StashError("validation", "Invalid commit diff query.");
    }
    const db = env.DB.withSession("first-primary");
    const commit = await db
      .prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ? AND sealed = 1")
      .bind(stash, id)
      .first<CommitRow>();
    if (commit === null) return null;
    const allRows = await commitVersions(db, stash, id);
    const filtered =
      query.path === undefined ? allRows : allRows.filter((row) => row.path === query.path);
    const truncated = filtered.length > COMMIT_DIFF_INLINE_ENTRIES;
    const rows = filtered.slice(0, COMMIT_DIFF_INLINE_ENTRIES);
    const reads = createReads(env, deps);
    const diffMaxBytes = parseBinarySettings(env).diffMaxBytes;
    const entries: CommitDiffResult["entries"] = [];
    for (const row of rows) {
      const from =
        row.previous_version === null
          ? null
          : { version: row.previous_version, hash: row.previous_hash };
      const to = { version: row.version, hash: row.blob_hash };
      let diff: CommitDiffResult["entries"][number]["diff"];
      if (
        (row.previous_hash !== null && row.previous_representation === "binary") ||
        (row.blob_hash !== null && row.representation === "binary")
      ) {
        diff = { state: "binary" };
      } else if ((row.previous_size ?? 0) > diffMaxBytes || row.size_bytes > diffMaxBytes) {
        diff = { state: "oversized" };
      } else {
        const fromSource =
          row.previous_version === null || row.previous_hash === null
            ? null
            : await reads.getFileSource(stash, row.path, { version: row.previous_version });
        const toSource =
          row.blob_hash === null
            ? null
            : await reads.getFileSource(stash, row.path, { version: row.version });
        if (
          (row.previous_hash !== null && fromSource === null) ||
          (row.blob_hash !== null && toSource === null)
        ) {
          throw new StashError("internal", "Stored commit content is unavailable.");
        }
        const [fromText, toText] = await Promise.all([
          fromSource === null ? "" : reads.materializeText(fromSource),
          toSource === null ? "" : reads.materializeText(toSource),
        ]);
        diff = computeDiff({
          fromText,
          toText,
          fromLabel: `a/${row.path}@v${String(row.previous_version ?? 0)}`,
          toLabel: `b/${row.path}@v${String(row.version)}`,
          context: query.context,
          maxBytes: diffMaxBytes,
        });
      }
      entries.push({
        path: row.path,
        op: operationFromVersion(row),
        from,
        to,
        diff,
      });
    }
    return { entries, truncated };
  }

  async function revertCommit(
    stash: string,
    id: string,
    input: RevertCommitBodyType,
    options: CommitOptions,
  ): Promise<StoreCommitResult> {
    const parsed = RevertCommitBody.safeParse(input);
    if (!parsed.success) return failure("validation", 400, "Invalid revert input");
    if (
      options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length < 1 ||
        options.idempotencyKey.length > IDEMPOTENCY_KEY_MAX_CHARS)
    ) {
      return failure("validation", 400, "Invalid idempotency key");
    }
    const value = parsed.data;
    const requestHash = await sha256Hex(
      canonicalJson({
        commitId: id,
        author: value.author ?? "",
        message: value.message ?? `Revert ${id}`,
        meta: value.meta ?? {},
      }),
    );
    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const target = await db
      .prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ? AND sealed = 1")
      .bind(stash, id)
      .first<CommitRow>();
    if (target === null) return failure("not-found", 404, "Commit not found");
    const targetRows = await commitVersions(db, stash, id);

    const prior = await existingCommit(db, stash, options.idempotencyKey);
    if (prior !== null) {
      if (prior.request_hash !== requestHash) {
        return failure(
          "idempotency-key-reused",
          422,
          "Idempotency key was used for another request",
        );
      }
      const record = commitRecord(prior, await commitVersions(db, stash, prior.id));
      if (record === null) return failure("internal", 500, "Idempotency result is missing");
      const revertedPaths = new Set(record.entries.map((entry) => entry.path));
      const skipped = targetRows
        .filter((row) => !revertedPaths.has(row.path))
        .map((row) => ({ path: row.path, reason: "already-deleted" }));
      return {
        ok: true,
        value: { ...record, ...(skipped.length > 0 ? { skipped } : {}) },
        statusCode: 201,
        replayed: true,
      };
    }

    const paths = [...new Set(targetRows.map((row) => row.path))];
    const heads =
      paths.length === 0
        ? []
        : (
            await db
              .prepare(
                `SELECT f.path, f.head_version, f.deleted
               FROM files AS f JOIN json_each(?) AS requested ON requested.value = f.path
               WHERE f.stash_name = ?`,
              )
              .bind(JSON.stringify(paths), stash)
              .all<{ path: string; head_version: number; deleted: 0 | 1 }>()
          ).results;
    const headByPath = new Map(heads.map((head) => [head.path, head]));
    const entries: CommitEntryInput[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const row of targetRows) {
      const head = headByPath.get(row.path);
      const shouldDelete = row.version === 1 || row.previous_hash === null;
      if (shouldDelete && head?.head_version === row.version && head.deleted === 1) {
        skipped.push({ path: row.path, reason: "already-deleted" });
      } else if (shouldDelete) {
        entries.push({ op: "delete", path: row.path, expectedVersion: row.version });
      } else {
        entries.push({
          op: "rollback",
          path: row.path,
          expectedVersion: row.version,
          toVersion: row.version - 1,
        });
      }
    }
    if (entries.length === 0) return failure("validation", 400, "nothing to revert");
    const result = await createCommit(
      stash,
      {
        entries,
        author: value.author,
        message: value.message ?? `Revert ${id}`,
        meta: value.meta,
      },
      {
        ...options,
        source: "revert",
        revertsCommitId: id,
        requestHash,
      },
    );
    if (!result.ok || skipped.length === 0) return result;
    return { ...result, value: { ...result.value, skipped } };
  }

  return { createCommit, getCommit, listCommits, getCommitDiff, revertCommit };
}
