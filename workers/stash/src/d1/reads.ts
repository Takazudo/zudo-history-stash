import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  StashError,
  sha256Hex,
  type ByteObject,
  type ByteRange,
  type ContentAccess,
  type ContentStorage,
  type JsonValue,
  type Representation,
  type VersionKind,
  pathPrefixRange,
  type PathPrefixRange,
} from "@takazudo/zudo-history-stash-core";
import { parseBinarySettings } from "../binary-config.js";
import type { Env } from "../env.js";
import { createByteStorageReader } from "./byte-reader.js";
import type { StoreDependencies } from "./store.js";
import {
  SELECT_CHANGES_ASC,
  SELECT_CHANGES_BEFORE,
  SELECT_CHANGES_NEWEST,
  SELECT_FILE_COMMON_PREFIXES,
  SELECT_FILE_HEAD,
  SELECT_FILE_VERSION,
  SELECT_FILES,
  SELECT_HISTORY_HEAD,
  SELECT_HISTORY_VERSIONS,
  SELECT_SNAPSHOT_COMMIT_AT_CHANGE,
  SELECT_SNAPSHOT_COMMON_PREFIXES,
  SELECT_SNAPSHOT_COMMIT,
  SELECT_SNAPSHOT_FILES,
  type ChangeRow,
  type FileReadRow,
  type FileSummaryRow,
  type HistoryHeadRow,
  type HistoryVersionRow,
} from "./sql/reads.js";

export interface ReadFileRecord {
  path: string;
  version: number;
  hash: string | null;
  size: number;
  kind: VersionKind;
  rollbackOf: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: string;
  deleted: boolean;
  body: string | null;
  representation: Representation;
  contentAccess: ContentAccess;
  contentType: string;
  byteSize: number;
  etag: string | null;
}

export type ReadFileMetadata = Omit<ReadFileRecord, "body"> & {
  contentStorage: ContentStorage;
  contentRemote: boolean;
};

export interface ReadFileSource {
  stash: string;
  metadata: ReadFileMetadata;
}

export interface ReadVersionRecord {
  commitId: string;
  version: number;
  kind: VersionKind;
  hash: string | null;
  size: number;
  rollbackOf: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: string;
  representation: Representation;
  contentAccess: ContentAccess;
  contentType: string;
  byteSize: number;
  etag: string | null;
}

export interface ReadFileSummary {
  path: string;
  headVersion: number;
  hash: string | null;
  size: number;
  deleted: boolean;
  updatedAt: string;
  representation: Representation;
  contentAccess: ContentAccess;
  contentType: string;
  byteSize: number;
  etag: string | null;
}

export interface ReadFileList {
  files: ReadFileSummary[];
  commonPrefixes?: string[];
  nextAfter: string | null;
}

export interface ReadSnapshot {
  at: { commitId: string; changeId: number };
  files: ReadFileSummary[];
  commonPrefixes?: string[];
  nextAfter: string | null;
}

export interface ReadHistoryPage {
  path: string;
  headVersion: number;
  deleted: boolean;
  total: number;
  versions: ReadVersionRecord[];
  nextBefore: number | null;
}

export interface ReadChangeItem {
  changeId: number;
  commitId: string;
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  author: string;
  message: string;
  size: number;
  createdAt: string;
  representation: Representation;
  contentAccess: ContentAccess;
  contentType: string;
  byteSize: number;
  etag: string | null;
}

export type ReadChangesPage =
  | { changes: ReadChangeItem[]; nextSince: number | null; hasMore: boolean }
  | { changes: ReadChangeItem[]; nextBefore: number | null; hasMore: boolean };

export interface GetFileOptions {
  version?: number;
}

export interface ListFilesOptions {
  includeDeleted?: boolean;
  limit?: number;
  after?: string;
  prefix?: string;
  delimiter?: string;
}

export interface ListHistoryOptions {
  limit?: number;
  before?: number;
}

export interface ListChangesOptions {
  since?: number;
  before?: number;
  limit?: number;
}

export interface StashReads {
  getFileSource(
    stash: string,
    path: string,
    options?: GetFileOptions,
  ): Promise<ReadFileSource | null>;
  materializeFile(source: ReadFileSource): Promise<ReadFileRecord>;
  materializeText(source: ReadFileSource): Promise<string>;
  getByteObject(source: ReadFileSource, range?: ByteRange): Promise<ByteObject>;
  getFile(stash: string, path: string, options?: GetFileOptions): Promise<ReadFileRecord | null>;
  listFiles(stash: string, options?: ListFilesOptions): Promise<ReadFileList>;
  getSnapshot(
    stash: string,
    commitId: string,
    options?: ListFilesOptions,
  ): Promise<ReadSnapshot | null>;
  resolveCommitAtChange(stash: string, changeId: number): Promise<string | null>;
  listHistory(
    stash: string,
    path: string,
    options?: ListHistoryOptions,
  ): Promise<ReadHistoryPage | null>;
  listChanges(stash: string, options?: ListChangesOptions): Promise<ReadChangesPage>;
}

function validation(message: string): never {
  throw new StashError("validation", message);
}

function internalReadError(): never {
  throw new StashError("internal", "Stored file content is unavailable or invalid.");
}

function validateLimit(value: number | undefined): number {
  if (value === undefined) return LIST_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIST_LIMIT_MAX) {
    return validation(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}.`);
  }
  return value;
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1)
    return validation(`${name} must be a positive integer.`);
  return value;
}

function validateSince(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0)
    return validation("since must be a non-negative integer.");
  return value;
}

function validateString(value: string, name: string): string {
  if (typeof value !== "string") return validation(`${name} must be a string.`);
  return value;
}

type PathRange = PathPrefixRange | { lo: null; hi: null };

interface NormalizedListOptions {
  includeDeleted: boolean;
  limit: number;
  after: string | undefined;
  delimiter: "/" | undefined;
  range: PathRange;
}

function normalizePrefix(value: string | undefined): PathRange {
  const prefix = value === undefined ? undefined : validateString(value, "prefix");
  const result = pathPrefixRange(prefix);
  if (!result.ok) throw new StashError(result.error, result.message);
  return result.range ?? { lo: null, hi: null };
}

function normalizeListOptions(options: ListFilesOptions): NormalizedListOptions {
  const includeDeleted = options.includeDeleted ?? false;
  if (typeof includeDeleted !== "boolean") {
    return validation("includeDeleted must be a boolean.");
  }
  const delimiter = options.delimiter;
  if (delimiter !== undefined && delimiter !== "/") {
    return validation("delimiter must be '/'.");
  }
  const limit = validateLimit(options.limit);
  const after = options.after;
  if (after !== undefined) validateString(after, "after");
  return {
    includeDeleted,
    limit,
    after,
    delimiter,
    range: normalizePrefix(options.prefix),
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function parseMeta(value: string): Record<string, JsonValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function applicationEtag(
  hash: string | null,
  stored: string | null,
  deleted: boolean,
): string | null {
  if (deleted) {
    if (hash !== null || stored !== null) return internalReadError();
    return null;
  }
  if (hash === null || (stored !== null && stored !== hash)) return internalReadError();
  return stored ?? hash;
}

function contentAccess(
  representation: Representation,
  deleted: boolean,
  size: number,
  jsonInlineMaxBytes: number,
): ContentAccess {
  if (deleted) return "deleted";
  return representation === "text" && size <= jsonInlineMaxBytes ? "inline" : "raw";
}

function contentFields(
  row: {
    hash: string | null;
    size: number;
    kind: VersionKind;
    representation: Representation;
    content_type: string;
    application_etag: string | null;
  },
  jsonInlineMaxBytes: number,
) {
  if (!Number.isSafeInteger(row.size) || row.size < 0) return internalReadError();
  const deleted = row.kind === "delete";
  return {
    representation: row.representation,
    contentAccess: contentAccess(row.representation, deleted, row.size, jsonInlineMaxBytes),
    contentType: row.content_type,
    byteSize: row.size,
    etag: applicationEtag(row.hash, row.application_etag, deleted),
  };
}

function mapFileMetadata(row: FileReadRow, jsonInlineMaxBytes: number): ReadFileMetadata {
  const deleted = row.deleted === 1;
  return {
    path: row.path,
    version: row.version,
    hash: row.hash,
    size: row.size,
    kind: row.kind,
    rollbackOf: row.rollback_of,
    author: row.author,
    message: row.message,
    meta: parseMeta(row.meta_json),
    createdAt: toIso(row.created_at),
    deleted,
    ...contentFields(row, jsonInlineMaxBytes),
    contentStorage: row.content_storage,
    contentRemote: row.stored_r2_key !== null,
  };
}

function assertReadFileSource(source: ReadFileSource): void {
  const { metadata } = source;
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) return internalReadError();

  if (metadata.deleted) {
    if (
      metadata.hash !== null ||
      metadata.size !== 0 ||
      metadata.contentAccess !== "deleted" ||
      metadata.etag !== null
    ) {
      return internalReadError();
    }
    return;
  }

  if (metadata.hash === null || metadata.etag === null || metadata.contentAccess === "deleted") {
    return internalReadError();
  }
}

function mapFileSource(
  stash: string,
  row: FileReadRow,
  jsonInlineMaxBytes: number,
): ReadFileSource {
  const metadata = mapFileMetadata(row, jsonInlineMaxBytes);
  if (metadata.deleted) {
    if (row.stored_hash !== null || row.stored_size !== null || row.stored_r2_key !== null) {
      return internalReadError();
    }
  } else if (row.stored_hash !== metadata.hash || row.stored_size !== metadata.size) {
    return internalReadError();
  }
  const source = { stash, metadata } satisfies ReadFileSource;
  assertReadFileSource(source);
  return source;
}

function mapVersion(row: HistoryVersionRow, jsonInlineMaxBytes: number): ReadVersionRecord {
  return {
    commitId: row.commit_id,
    version: row.version,
    kind: row.kind,
    hash: row.hash,
    size: row.size,
    rollbackOf: row.rollback_of,
    author: row.author,
    message: row.message,
    meta: parseMeta(row.meta_json),
    createdAt: toIso(row.created_at),
    ...contentFields(row, jsonInlineMaxBytes),
  };
}

function mapFileSummary(row: FileSummaryRow, jsonInlineMaxBytes: number): ReadFileSummary {
  return {
    path: row.path,
    headVersion: row.head_version,
    hash: row.hash,
    size: row.size,
    deleted: row.deleted === 1,
    updatedAt: toIso(row.updated_at),
    ...contentFields({ ...row, kind: row.deleted === 1 ? "delete" : "put" }, jsonInlineMaxBytes),
  };
}

interface CommonPrefixRow {
  common_prefix: string;
}

interface ListedRows {
  files: FileSummaryRow[];
  commonPrefixes: string[];
  nextAfter: string | null;
}

function pageListedRows(
  fileRows: FileSummaryRow[],
  prefixRows: CommonPrefixRow[],
  limit: number,
): ListedRows {
  const entries = [
    ...fileRows.map((row) => ({ path: row.path, row, commonPrefix: undefined })),
    ...prefixRows.map((row) => ({
      path: row.common_prefix,
      row: undefined,
      commonPrefix: row.common_prefix,
    })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  return {
    files: page.flatMap((entry) => (entry.row === undefined ? [] : [entry.row])),
    commonPrefixes: page.flatMap((entry) =>
      entry.commonPrefix === undefined ? [] : [entry.commonPrefix],
    ),
    nextAfter: hasMore ? (page.at(-1)?.path ?? null) : null,
  };
}

function mapChange(row: ChangeRow, jsonInlineMaxBytes: number): ReadChangeItem {
  return {
    changeId: row.change_id,
    commitId: row.commit_id,
    stash: row.stash,
    path: row.path,
    version: row.version,
    kind: row.kind,
    author: row.author,
    message: row.message,
    size: row.size,
    createdAt: toIso(row.created_at),
    ...contentFields(row, jsonInlineMaxBytes),
  };
}

export function createReads(env: Env, _deps?: StoreDependencies): StashReads {
  const { jsonInlineMaxBytes } = parseBinarySettings(env);
  const byteReader = createByteStorageReader(env);
  const getFileSource: StashReads["getFileSource"] = async (stash, path, options = {}) => {
    const stashName = validateString(stash, "stash");
    const filePath = validateString(path, "path");
    const version = validateOptionalPositiveInteger(options.version, "version");
    const session = env.DB.withSession("first-primary");
    const statement = session.prepare(
      version === undefined ? SELECT_FILE_HEAD : SELECT_FILE_VERSION,
    );
    const row =
      version === undefined
        ? await statement.bind(stashName, filePath).first<FileReadRow>()
        : await statement.bind(stashName, filePath, version).first<FileReadRow>();
    return row === null ? null : mapFileSource(stashName, row, jsonInlineMaxBytes);
  };

  const getByteObject: StashReads["getByteObject"] = async (source, range) => {
    assertReadFileSource(source);
    const { metadata } = source;
    if (metadata.deleted || metadata.hash === null || metadata.etag === null) {
      return internalReadError();
    }
    const object = await byteReader.get({
      stash: source.stash,
      hash: metadata.hash,
      storage: metadata.contentStorage,
      size: metadata.size,
      etag: metadata.etag,
      contentType: metadata.contentType,
      ...(range === undefined ? {} : { range }),
    });
    return object ?? internalReadError();
  };

  const materializeText: StashReads["materializeText"] = async (source) => {
    assertReadFileSource(source);
    if (source.metadata.deleted || source.metadata.representation !== "text") {
      return internalReadError();
    }
    const object = await getByteObject(source);
    const bytes = await new Response(object.stream).arrayBuffer();
    if (bytes.byteLength !== source.metadata.size) return internalReadError();
    if (source.metadata.contentRemote && (await sha256Hex(bytes)) !== source.metadata.hash) {
      return internalReadError();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return internalReadError();
    }
  };

  const materializeFile: StashReads["materializeFile"] = async (source) => {
    assertReadFileSource(source);
    const {
      contentStorage: _contentStorage,
      contentRemote: _contentRemote,
      ...metadata
    } = source.metadata;
    if (source.metadata.deleted) return { ...metadata, body: null };
    if (source.metadata.contentAccess === "raw") return { ...metadata, body: null };
    return { ...metadata, body: await materializeText(source) };
  };

  const getFile: StashReads["getFile"] = async (stash, path, options = {}) => {
    const source = await getFileSource(stash, path, options);
    return source === null ? null : materializeFile(source);
  };

  return {
    getFileSource,
    materializeFile,
    materializeText,
    getByteObject,
    getFile,

    async listFiles(stash, options = {}) {
      const stashName = validateString(stash, "stash");
      const normalized = normalizeListOptions(options);

      const session = env.DB.withSession("first-primary");
      const fileResult = await session
        .prepare(SELECT_FILES)
        .bind(
          stashName,
          normalized.includeDeleted ? 1 : 0,
          normalized.range.lo,
          normalized.range.lo,
          normalized.range.hi,
          normalized.after ?? null,
          normalized.after ?? null,
          normalized.delimiter ?? null,
          normalized.range.lo,
          normalized.limit + 1,
        )
        .all<FileSummaryRow>();
      const rows = fileResult.results;
      if (normalized.delimiter === undefined) {
        const hasMore = rows.length > normalized.limit;
        if (hasMore) rows.pop();
        return {
          files: rows.map((row) => mapFileSummary(row, jsonInlineMaxBytes)),
          nextAfter: hasMore ? (rows.at(-1)?.path ?? null) : null,
        };
      }

      const prefixResult = await session
        .prepare(SELECT_FILE_COMMON_PREFIXES)
        .bind(
          normalized.range.lo,
          normalized.range.lo,
          stashName,
          normalized.includeDeleted ? 1 : 0,
          normalized.range.lo,
          normalized.range.lo,
          normalized.range.hi,
          normalized.after ?? null,
          normalized.range.lo,
          normalized.range.lo,
          normalized.after ?? null,
          normalized.delimiter,
          normalized.range.lo,
          normalized.limit + 1,
        )
        .all<CommonPrefixRow>();
      const page = pageListedRows(rows, prefixResult.results, normalized.limit);
      return {
        files: page.files.map((row) => mapFileSummary(row, jsonInlineMaxBytes)),
        commonPrefixes: page.commonPrefixes,
        nextAfter: page.nextAfter,
      };
    },

    async resolveCommitAtChange(stash, changeId) {
      const stashName = validateString(stash, "stash");
      const session = env.DB.withSession("first-primary");
      const commit = await session
        .prepare(SELECT_SNAPSHOT_COMMIT_AT_CHANGE)
        .bind(stashName, changeId)
        .first<{ commit_id: string }>();
      return commit?.commit_id ?? null;
    },

    async getSnapshot(stash, commitId, options = {}) {
      const stashName = validateString(stash, "stash");
      const id = validateString(commitId, "commitId");
      const normalized = normalizeListOptions(options);
      const session = env.DB.withSession("first-primary");
      const commit = await session
        .prepare(SELECT_SNAPSHOT_COMMIT)
        .bind(stashName, id)
        .first<{ commit_id: string; last_change_id: number }>();
      if (commit === null) return null;

      const fileResult = await session
        .prepare(SELECT_SNAPSHOT_FILES)
        .bind(
          commit.last_change_id,
          stashName,
          normalized.includeDeleted ? 1 : 0,
          normalized.range.lo,
          normalized.range.lo,
          normalized.range.hi,
          normalized.after ?? null,
          normalized.after ?? null,
          normalized.delimiter ?? null,
          normalized.range.lo,
          normalized.limit + 1,
        )
        .all<FileSummaryRow>();
      const rows = fileResult.results;
      if (normalized.delimiter === undefined) {
        const hasMore = rows.length > normalized.limit;
        if (hasMore) rows.pop();
        return {
          at: { commitId: commit.commit_id, changeId: commit.last_change_id },
          files: rows.map((row) => mapFileSummary(row, jsonInlineMaxBytes)),
          nextAfter: hasMore ? (rows.at(-1)?.path ?? null) : null,
        };
      }

      const prefixResult = await session
        .prepare(SELECT_SNAPSHOT_COMMON_PREFIXES)
        .bind(
          normalized.range.lo,
          normalized.range.lo,
          commit.last_change_id,
          stashName,
          normalized.includeDeleted ? 1 : 0,
          normalized.range.lo,
          normalized.range.lo,
          normalized.range.hi,
          normalized.after ?? null,
          normalized.range.lo,
          normalized.range.lo,
          normalized.after ?? null,
          normalized.delimiter,
          normalized.range.lo,
          normalized.limit + 1,
        )
        .all<CommonPrefixRow>();
      const page = pageListedRows(rows, prefixResult.results, normalized.limit);
      return {
        at: { commitId: commit.commit_id, changeId: commit.last_change_id },
        files: page.files.map((row) => mapFileSummary(row, jsonInlineMaxBytes)),
        commonPrefixes: page.commonPrefixes,
        nextAfter: page.nextAfter,
      };
    },

    async listHistory(stash, path, options = {}) {
      const stashName = validateString(stash, "stash");
      const filePath = validateString(path, "path");
      const limit = validateLimit(options.limit);
      const before = validateOptionalPositiveInteger(options.before, "before");
      const session = env.DB.withSession("first-primary");
      const head = await session
        .prepare(SELECT_HISTORY_HEAD)
        .bind(stashName, filePath)
        .first<HistoryHeadRow>();
      if (head === null) return null;

      const result = await session
        .prepare(SELECT_HISTORY_VERSIONS)
        .bind(stashName, filePath, before ?? null, before ?? null, limit + 1)
        .all<HistoryVersionRow>();
      const rows = result.results;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return {
        path: filePath,
        headVersion: head.head_version,
        deleted: head.deleted === 1,
        total: head.total,
        versions: rows.map((row) => mapVersion(row, jsonInlineMaxBytes)),
        nextBefore: hasMore ? (rows.at(-1)?.version ?? null) : null,
      };
    },

    async listChanges(stash, options = {}) {
      const stashName = validateString(stash, "stash");
      const limit = validateLimit(options.limit);
      const since = validateSince(options.since);
      const before = validateOptionalPositiveInteger(options.before, "before");
      if (since !== undefined && before !== undefined) {
        return validation("since and before are mutually exclusive.");
      }

      const session = env.DB.withSession("first-primary");
      const statement =
        since !== undefined
          ? session.prepare(SELECT_CHANGES_ASC).bind(stashName, since, limit + 1)
          : before !== undefined
            ? session.prepare(SELECT_CHANGES_BEFORE).bind(stashName, before, limit + 1)
            : session.prepare(SELECT_CHANGES_NEWEST).bind(stashName, limit + 1);
      const result = await statement.all<ChangeRow>();
      const rows = result.results;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const changes = rows.map((row) => mapChange(row, jsonInlineMaxBytes));
      if (since !== undefined) {
        return {
          changes,
          nextSince: hasMore ? (rows.at(-1)?.change_id ?? null) : null,
          hasMore,
        };
      }
      return {
        changes,
        nextBefore: hasMore ? (rows.at(-1)?.change_id ?? null) : null,
        hasMore,
      };
    },
  };
}
