import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  StashError,
  type JsonValue,
  type VersionKind,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { assertBlobRowShape, readBlob, type BlobCodecRow } from "./blobs.js";
import type { StoreDependencies } from "./store.js";
import {
  SELECT_CHANGES_ASC,
  SELECT_CHANGES_BEFORE,
  SELECT_CHANGES_NEWEST,
  SELECT_FILE_HEAD,
  SELECT_FILE_VERSION,
  SELECT_FILES,
  SELECT_HISTORY_HEAD,
  SELECT_HISTORY_VERSIONS,
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
  contentType: string;
}

export type ReadFileMetadata = Omit<ReadFileRecord, "body">;

export interface ReadFileSource {
  metadata: ReadFileMetadata;
  blob: BlobCodecRow | null;
}

export interface ReadVersionRecord {
  version: number;
  kind: VersionKind;
  hash: string | null;
  size: number;
  rollbackOf: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: string;
}

export interface ReadFileSummary {
  path: string;
  headVersion: number;
  hash: string | null;
  size: number;
  deleted: boolean;
  updatedAt: string;
}

export interface ReadFileList {
  files: ReadFileSummary[];
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
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  author: string;
  message: string;
  size: number;
  createdAt: string;
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
  getFile(stash: string, path: string, options?: GetFileOptions): Promise<ReadFileRecord | null>;
  listFiles(stash: string, options?: ListFilesOptions): Promise<ReadFileList>;
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

function mapFileMetadata(row: FileReadRow): ReadFileMetadata {
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
    deleted: row.deleted === 1,
    contentType: row.content_type,
  };
}

function assertReadFileSource(source: ReadFileSource): void {
  const { metadata, blob } = source;
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) return internalReadError();

  if (metadata.deleted) {
    if (metadata.hash !== null || metadata.size !== 0 || blob !== null) return internalReadError();
    return;
  }

  if (
    metadata.hash === null ||
    blob === null ||
    blob.hash !== metadata.hash ||
    blob.size_bytes !== metadata.size
  ) {
    return internalReadError();
  }
  assertBlobRowShape(blob);
}

function mapFileSource(row: FileReadRow): ReadFileSource {
  const metadata = mapFileMetadata(row);
  const hasBlobColumns =
    row.blob_hash !== null ||
    row.blob_body !== null ||
    row.blob_r2_key !== null ||
    row.blob_size !== null;
  let blob: BlobCodecRow | null = null;
  if (hasBlobColumns) {
    if (row.blob_hash === null || row.blob_size === null) return internalReadError();
    blob = {
      hash: row.blob_hash,
      body: row.blob_body,
      r2_key: row.blob_r2_key,
      size_bytes: row.blob_size,
    };
  }

  const source = { metadata, blob } satisfies ReadFileSource;
  assertReadFileSource(source);
  return source;
}

function mapVersion(row: HistoryVersionRow): ReadVersionRecord {
  return {
    version: row.version,
    kind: row.kind,
    hash: row.hash,
    size: row.size,
    rollbackOf: row.rollback_of,
    author: row.author,
    message: row.message,
    meta: parseMeta(row.meta_json),
    createdAt: toIso(row.created_at),
  };
}

function mapFileSummary(row: FileSummaryRow): ReadFileSummary {
  return {
    path: row.path,
    headVersion: row.head_version,
    hash: row.hash,
    size: row.size,
    deleted: row.deleted === 1,
    updatedAt: toIso(row.updated_at),
  };
}

function mapChange(row: ChangeRow): ReadChangeItem {
  return {
    changeId: row.change_id,
    stash: row.stash,
    path: row.path,
    version: row.version,
    kind: row.kind,
    author: row.author,
    message: row.message,
    size: row.size,
    createdAt: toIso(row.created_at),
  };
}

export function createReads(env: Env, _deps?: StoreDependencies): StashReads {
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
    return row === null ? null : mapFileSource(row);
  };

  const materializeFile: StashReads["materializeFile"] = async (source) => {
    assertReadFileSource(source);
    if (source.metadata.deleted) return { ...source.metadata, body: null };
    if (source.blob === null) return internalReadError();
    const body = await readBlob(env, source.blob);
    return { ...source.metadata, body };
  };

  const getFile: StashReads["getFile"] = async (stash, path, options = {}) => {
    const source = await getFileSource(stash, path, options);
    return source === null ? null : materializeFile(source);
  };

  return {
    getFileSource,
    materializeFile,
    getFile,

    async listFiles(stash, options = {}) {
      const stashName = validateString(stash, "stash");
      const includeDeleted = options.includeDeleted ?? false;
      if (typeof includeDeleted !== "boolean")
        return validation("includeDeleted must be a boolean.");
      const limit = validateLimit(options.limit);
      const after = options.after;
      if (after !== undefined) validateString(after, "after");

      const session = env.DB.withSession("first-primary");
      const result = await session
        .prepare(SELECT_FILES)
        .bind(stashName, includeDeleted ? 1 : 0, after ?? null, after ?? null, limit + 1)
        .all<FileSummaryRow>();
      const rows = result.results;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return {
        files: rows.map(mapFileSummary),
        nextAfter: hasMore ? (rows.at(-1)?.path ?? null) : null,
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
        versions: rows.map(mapVersion),
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
      const changes = rows.map(mapChange);
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
