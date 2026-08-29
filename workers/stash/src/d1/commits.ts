import {
  CreateCommitBody,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_COMMIT_INLINE_BYTES,
  MAX_META_BYTES,
  canonicalJson,
  isWellFormedString,
  sha256Hex,
  utf8ByteLength,
  validateStashName,
  type ApiError,
  type CommitConflict,
  type CommitEntryInput,
  type CommitEntryRecord,
  type CommitResult,
  type CreateCommitBody as CreateCommitBodyType,
  type Current,
  type Result,
} from "@takazudo/zudo-history-stash-core";
import type { Principal } from "../context.js";
import type { Env } from "../env.js";
import { prepareBlob, type BlobGenerationFactory, type PreparedBlob } from "./blobs.js";
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
}

export interface StashCommits {
  createCommit(
    stash: string,
    input: CreateCommitBodyType,
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

    const requestHash = await sha256Hex(
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
    );
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
      source: "commit" as const,
      source_id: null,
      author: value.author ?? "",
      message: value.message ?? "",
      meta_json: metaJson,
      entry_count: prepared.length,
      reverts_commit_id: null,
      idempotency_key: options.idempotencyKey ?? null,
      request_hash: requestHash,
      created_by: createdBy(options.principal),
      created_at: createdAt,
    };

    try {
      let statements = commitBatch(db, {
        row,
        entries: prepared,
        ...(value.expectedLastChangeId === undefined
          ? {}
          : { expectedLastChangeId: value.expectedLastChangeId }),
      });
      statements = deps.alterCommitStatementsForTest?.(statements) ?? statements;
      const results = await db.batch(statements);
      if (results.at(-1)?.meta.changes === 1) {
        const persisted = await db
          .prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ? AND sealed = 1")
          .bind(stash, commitId)
          .first<CommitRow>();
        const result = persisted ? await resultFromCommit(db, persisted, value.entries) : null;
        if (!result) return failure("internal", 500, "Missing committed changes");
        await options.onCommitted?.(result);
        return { ok: true, value: result, statusCode: 201 };
      }
    } catch {
      // UNIQUE idempotency races and CHECK rollbacks are classified by the same durable re-read.
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

  return { createCommit };
}
