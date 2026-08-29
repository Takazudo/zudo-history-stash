import {
  COMMIT_DIFF_INLINE_ENTRIES,
  CreateChangeSetBody,
  IDEMPOTENCY_KEY_MAX_CHARS,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_META_BYTES,
  StashError,
  canonicalJson,
  computeDiff,
  sha256Hex,
  utf8ByteLength,
  validatePath,
  type ChangeSetDiffResult,
  type ChangeSetEntryInput,
  type ChangeSetListResponse,
  type ChangeSetRecord,
  type ChangeSetStatus,
  type CreateChangeSetBody as CreateChangeSetInput,
  type Current,
  type JsonValue,
} from "@takazudo/zudo-history-stash-core";
import { parseBinarySettings } from "../binary-config.js";
import type { Env } from "../env.js";
import { prepareBlob, readBlob, type PreparedBlob } from "./blobs.js";
import { createByteStorageReader } from "./byte-reader.js";
import type { ChangeSetEntryRow, ChangeSetRow } from "./schema.js";
import {
  SELECT_CHANGE_SET,
  SELECT_CHANGE_SET_BY_KEY,
  SELECT_CHANGE_SET_ENTRIES,
  countChangeSets,
  insertChangeSetStatement,
  insertEntryStatement,
  selectChangeSets,
} from "./sql/change-sets.js";
import type { StoreDependencies } from "./store.js";

const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 14;
const CHANGE_SET_ID = /^chs_\d{13}[0-9a-f]{8}$/;
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

interface VersionMaterialRow {
  stash_name: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  size_bytes: number;
  content_type: string;
  representation: "text" | "binary";
  content_storage: "legacy" | "bytes";
  author: string;
  created_at: number;
  blob_body: string | null;
  blob_r2_key: string | null;
  blob_size: number | null;
}

interface HeadRow extends VersionMaterialRow {
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
}

interface StagedEntry extends ChangeSetEntryRow {
  textBody?: string;
  binaryBody?: ArrayBuffer;
}

export interface ChangeSetDependencies extends StoreDependencies {
  createBlobGeneration?: () => string;
  onBeforeCommit?: () => void | Promise<void>;
}

export interface ChangeSetCreateResult {
  value: ChangeSetRecord;
  replayed?: true;
}

export interface ListChangeSetOptions {
  status?: "open" | "applied" | "rejected" | "expired" | "all";
  path?: string;
  limit?: number;
  after?: string;
}

export interface ChangeSetDiffOptions {
  context?: number;
  path?: string;
}

function validation(message: string): never {
  throw new StashError("validation", message);
}

function internal(message = "Stored change-set data is unavailable or invalid."): never {
  throw new StashError("internal", message);
}

function toIso(value: number): string {
  if (!Number.isSafeInteger(value)) return internal();
  return new Date(value).toISOString();
}

function parseMeta(value: string): Record<string, JsonValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return internal();
    return parsed as Record<string, JsonValue>;
  } catch {
    return internal();
  }
}

function computedStatus(
  row: Pick<ChangeSetRow, "status" | "expires_at">,
  now: number,
): ChangeSetStatus {
  return row.status === "open" && row.expires_at <= now ? "expired" : row.status;
}

function current(row: HeadRow | VersionMaterialRow | null): Current | null {
  if (row === null) return null;
  return {
    version: "head_version" in row ? row.head_version : row.version,
    hash: row.blob_hash,
    deleted: row.kind === "delete" || ("deleted" in row && row.deleted === 1),
    kind: row.kind,
    author: row.author,
    createdAt: toIso(row.created_at),
  };
}

function ttlDays(env: Env): number {
  const source = env.CHANGE_SET_TTL_DAYS || String(DEFAULT_TTL_DAYS);
  if (!/^[1-9]\d*$/.test(source)) return internal("Invalid CHANGE_SET_TTL_DAYS configuration.");
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value * DAY_MS > Number.MAX_SAFE_INTEGER) return internal();
  return value;
}

function mintId(now: number, entropy: string): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 9_999_999_999_999) return internal();
  let hash = 0x811c9dc5;
  for (const character of entropy) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `chs_${String(now).padStart(13, "0")}${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validateKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS) {
    validation("Invalid idempotency key.");
  }
  return key;
}

function decodeBinary(value: string, path: string): ArrayBuffer {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      return validation(`Invalid binary body for ${path}.`);
    }
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;
  } catch {
    return validation(`Invalid binary body for ${path}.`);
  }
}

async function selectHead(
  db: D1DatabaseSession,
  stash: string,
  path: string,
): Promise<HeadRow | null> {
  return db
    .prepare(
      `SELECT v.stash_name, f.head_version, f.head_hash, f.deleted, v.version, v.kind, v.blob_hash,
         v.size_bytes, v.content_type, v.representation, v.content_storage, v.author, v.created_at,
         b.body AS blob_body, b.r2_key AS blob_r2_key, b.size_bytes AS blob_size
       FROM files f JOIN versions v
         ON v.stash_name = f.stash_name AND v.path = f.path AND v.version = f.head_version
       LEFT JOIN blobs b ON b.stash_name = v.stash_name AND b.hash = v.blob_hash
       WHERE f.stash_name = ? AND f.path = ? LIMIT 1`,
    )
    .bind(stash, path)
    .first<HeadRow>();
}

async function selectVersion(
  db: D1DatabaseSession,
  stash: string,
  path: string,
  version: number,
): Promise<VersionMaterialRow | null> {
  return db
    .prepare(
      `SELECT v.stash_name, v.version, v.kind, v.blob_hash, v.size_bytes, v.content_type, v.representation,
         v.content_storage, v.author, v.created_at, b.body AS blob_body,
         b.r2_key AS blob_r2_key, b.size_bytes AS blob_size
       FROM versions v LEFT JOIN blobs b
         ON b.stash_name = v.stash_name AND b.hash = v.blob_hash
       WHERE v.stash_name = ? AND v.path = ? AND v.version = ? LIMIT 1`,
    )
    .bind(stash, path, version)
    .first<VersionMaterialRow>();
}

function sourceEntry(id: string, stash: string, input: ChangeSetEntryInput): ChangeSetEntryRow {
  return {
    change_set_id: id,
    stash_name: stash,
    path: input.path,
    op: input.op,
    base_version: input.baseVersion,
    blob_hash: null,
    content_storage: null,
    representation: null,
    content_type: null,
    size_bytes: null,
    rollback_to: input.op === "rollback" ? input.toVersion : null,
    copied_from_path: input.op === "copy" ? input.from.path : null,
    copied_from_version: input.op === "copy" ? input.from.version : null,
  };
}

function pathError(path: string, reason: string): never {
  return validation(`Invalid change-set entry ${path}: ${reason}`);
}

async function stageEntry(
  db: D1DatabaseSession,
  id: string,
  stash: string,
  input: ChangeSetEntryInput,
): Promise<StagedEntry> {
  const entry: StagedEntry = sourceEntry(id, stash, input);
  const head = await selectHead(db, stash, input.path);
  if (input.baseVersion === null) {
    if (head !== null) pathError(input.path, "the path already exists");
  } else if (head === null) {
    pathError(input.path, "the base path does not exist");
  } else if ((await selectVersion(db, stash, input.path, input.baseVersion)) === null) {
    pathError(input.path, `base version ${input.baseVersion} does not exist`);
  }
  if (input.op === "delete") {
    if (head === null) pathError(input.path, "the path does not exist");
    if (head.deleted === 1) pathError(input.path, "the current head is already deleted");
    return entry;
  }
  if (input.op === "put") {
    if ("bytesBase64" in input) {
      const bytes = decodeBinary(input.bytesBase64, input.path);
      entry.binaryBody = bytes;
      entry.blob_hash = await sha256Hex(bytes);
      entry.content_storage = "bytes";
      entry.representation = "binary";
      entry.content_type = input.contentType;
      entry.size_bytes = bytes.byteLength;
    } else {
      entry.textBody = input.body;
      entry.blob_hash = await sha256Hex(input.body);
      entry.content_storage = "legacy";
      entry.representation = "text";
      entry.content_type = input.contentType ?? DEFAULT_CONTENT_TYPE;
      entry.size_bytes = utf8ByteLength(input.body);
    }
    return entry;
  }
  const sourcePath = input.op === "copy" ? input.from.path : input.path;
  const sourceVersion = input.op === "copy" ? input.from.version : input.toVersion;
  const source = await selectVersion(db, stash, sourcePath, sourceVersion);
  if (source === null || source.kind === "delete" || source.blob_hash === null) {
    pathError(input.path, `${input.op} source has no content blob`);
  }
  const sourceBlobExists =
    source.content_storage === "legacy"
      ? source.blob_size !== null
      : (await db
          .prepare("SELECT 1 FROM byte_blobs WHERE stash_name = ? AND hash = ?")
          .bind(stash, source.blob_hash)
          .first()) !== null;
  if (!sourceBlobExists) pathError(input.path, `${input.op} source has no content blob`);
  entry.blob_hash = source.blob_hash;
  entry.content_storage = source.content_storage;
  entry.representation = source.representation;
  entry.content_type = source.content_type;
  entry.size_bytes = source.size_bytes;
  return entry;
}

async function entriesFor(db: D1DatabaseSession, id: string): Promise<ChangeSetEntryRow[]> {
  return (await db.prepare(SELECT_CHANGE_SET_ENTRIES).bind(id).all<ChangeSetEntryRow>()).results;
}

async function mapRecord(
  db: D1DatabaseSession,
  row: ChangeSetRow,
  now: number,
): Promise<ChangeSetRecord> {
  const entries = await entriesFor(db, row.id);
  return {
    id: row.id,
    stash: row.stash_name,
    status: computedStatus(row, now),
    author: row.author,
    message: row.message,
    meta: parseMeta(row.meta_json),
    expiresAt: toIso(row.expires_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    commitId: row.commit_id,
    entries: await Promise.all(
      entries.map(async (entry) => {
        const head = await selectHead(db, row.stash_name, entry.path);
        return {
          path: entry.path,
          op: entry.op,
          baseVersion: entry.base_version,
          current: current(head),
          stale: (head?.head_version ?? null) !== entry.base_version,
        };
      }),
    ),
  };
}

function encodeCursor(row: Pick<ChangeSetRow, "created_at" | "id">): string {
  return btoa(`${row.created_at}:${row.id}`);
}

function decodeCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (value === undefined) return null;
  try {
    const decoded = atob(value);
    if (btoa(decoded) !== value) return validation("Invalid change-set cursor.");
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (separator < 1 || !Number.isSafeInteger(createdAt) || !CHANGE_SET_ID.test(id)) {
      return validation("Invalid change-set cursor.");
    }
    return { createdAt, id };
  } catch {
    return validation("Invalid change-set cursor.");
  }
}

async function textFor(env: Env, row: VersionMaterialRow | ChangeSetEntryRow): Promise<string> {
  if (row.blob_hash === null) return "";
  if (
    row.representation !== "text" ||
    row.content_storage === null ||
    row.size_bytes === null ||
    row.content_type === null
  ) {
    return internal();
  }
  if (row.content_storage === "bytes") {
    const object = await createByteStorageReader(env).get({
      stash: row.stash_name,
      hash: row.blob_hash,
      storage: "bytes",
      size: row.size_bytes,
      etag: row.blob_hash,
      contentType: row.content_type,
    });
    if (object === null) return internal();
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await new Response(object.stream).arrayBuffer(),
      );
    } catch {
      return internal();
    }
  }
  const material =
    "blob_body" in row
      ? row
      : await env.DB.prepare(
          "SELECT body AS blob_body, r2_key AS blob_r2_key, size_bytes AS blob_size FROM blobs WHERE stash_name = ? AND hash = ?",
        )
          .bind(row.stash_name, row.blob_hash)
          .first<{ blob_body: string | null; blob_r2_key: string | null; blob_size: number }>();
  if (material === null || material.blob_size === null || material.blob_size !== row.size_bytes) {
    return internal();
  }
  return readBlob(env, {
    hash: row.blob_hash,
    body: material.blob_body,
    r2_key: material.blob_r2_key,
    size_bytes: material.blob_size,
  });
}

export function createChangeSets(env: Env, deps: ChangeSetDependencies) {
  return {
    async createChangeSet(
      stash: string,
      input: CreateChangeSetInput,
      options: { idempotencyKey?: string; createdBy?: string } = {},
    ): Promise<ChangeSetCreateResult> {
      const parsed = CreateChangeSetBody.safeParse(input);
      if (!parsed.success) validation("Invalid change-set input.");
      const key = validateKey(options.idempotencyKey);
      const now = deps.now();
      const requestHash = await sha256Hex(canonicalJson(input as JsonValue));
      const db = env.DB.withSession("first-primary");
      const live = await db
        .prepare("SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL")
        .bind(stash)
        .first();
      if (live === null) throw new StashError("not-found", "Stash not found.");
      if (key !== undefined) {
        const prior = await db
          .prepare(SELECT_CHANGE_SET_BY_KEY)
          .bind(stash, key)
          .first<ChangeSetRow>();
        if (prior !== null) {
          if (prior.request_hash !== requestHash) {
            throw new StashError(
              "idempotency-key-reused",
              "Idempotency key was already used for a different change set.",
            );
          }
          return { value: await mapRecord(db, prior, now), replayed: true };
        }
      }
      const explicitExpiry = input.expiresAt === undefined ? null : Date.parse(input.expiresAt);
      if (
        explicitExpiry !== null &&
        (!Number.isSafeInteger(explicitExpiry) || explicitExpiry <= now)
      ) {
        validation("expiresAt must be in the future.");
      }
      const expiresAt = explicitExpiry ?? now + ttlDays(env) * DAY_MS;
      const id = mintId(now, deps.createId());
      const metaJson = canonicalJson({ ...(input.meta ?? {}), changeSetId: id });
      if (utf8ByteLength(metaJson) > MAX_META_BYTES) {
        validation("Stamped change-set meta is too large.");
      }
      const staged = await Promise.all(
        input.entries.map((entry) => stageEntry(db, id, stash, entry)),
      );
      const prepared = new Map<string, PreparedBlob>();
      for (const entry of staged) {
        if (
          entry.textBody !== undefined &&
          entry.blob_hash !== null &&
          !prepared.has(entry.blob_hash)
        ) {
          prepared.set(
            entry.blob_hash,
            await prepareBlob(
              env,
              stash,
              entry.blob_hash,
              entry.textBody,
              deps.createBlobGeneration,
            ),
          );
        }
      }
      const row: ChangeSetRow = {
        id,
        stash_name: stash,
        status: "open",
        author: input.author ?? "",
        message: input.message ?? "",
        meta_json: metaJson,
        expires_at: expiresAt,
        created_by: options.createdBy ?? "system",
        created_at: now,
        idempotency_key: key ?? null,
        request_hash: key === undefined ? null : requestHash,
        expected_last_change_id: input.expectedLastChangeId ?? null,
        decision_attempt: null,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        commit_id: null,
      };
      const statements: D1PreparedStatement[] = [];
      const insertedHashes = new Set<string>();
      for (const entry of staged) {
        if (entry.blob_hash === null || insertedHashes.has(entry.blob_hash)) continue;
        insertedHashes.add(entry.blob_hash);
        const expectedFence =
          row.expected_last_change_id === null
            ? "1 = 1"
            : "COALESCE((SELECT MAX(id) FROM versions WHERE stash_name = ?), 0) = ?";
        const expectedParams =
          row.expected_last_change_id === null ? [] : [stash, row.expected_last_change_id];
        if (entry.textBody !== undefined && entry.blob_hash !== null) {
          const blob = prepared.get(entry.blob_hash);
          if (blob === undefined) return internal();
          statements.push(
            db
              .prepare(
                `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
                 SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
                   AND ${expectedFence}
                 ON CONFLICT(stash_name, hash) DO NOTHING`,
              )
              .bind(
                stash,
                entry.blob_hash,
                blob.body,
                blob.r2_key,
                entry.size_bytes,
                now,
                stash,
                ...expectedParams,
              ),
          );
        } else if (entry.binaryBody !== undefined && entry.blob_hash !== null) {
          statements.push(
            db
              .prepare(
                `INSERT INTO byte_blobs
                 (stash_name, hash, body_bytes, r2_key, storage_generation, size_bytes, created_at)
                 SELECT ?, ?, ?, NULL, 0, ?, ? WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)
                   AND ${expectedFence}
                 ON CONFLICT(stash_name, hash) DO NOTHING`,
              )
              .bind(
                stash,
                entry.blob_hash,
                entry.binaryBody,
                entry.size_bytes,
                now,
                stash,
                ...expectedParams,
              ),
          );
        }
      }
      statements.push(insertChangeSetStatement(db, row));
      statements.push(...staged.map((entry) => insertEntryStatement(db, entry)));
      await deps.onBeforeCommit?.();
      try {
        const result = await db.batch(statements);
        const setResult = result.at(statements.length - staged.length - 1);
        if (setResult?.meta.changes === 1) {
          const created = await db.prepare(SELECT_CHANGE_SET).bind(stash, id).first<ChangeSetRow>();
          if (created === null) return internal();
          return { value: await mapRecord(db, created, now) };
        }
      } catch {
        /* Resolve same-key races below. */
      }
      if (key !== undefined) {
        const winner = await db
          .prepare(SELECT_CHANGE_SET_BY_KEY)
          .bind(stash, key)
          .first<ChangeSetRow>();
        if (winner !== null) {
          if (winner.request_hash !== requestHash) {
            throw new StashError(
              "idempotency-key-reused",
              "Idempotency key was already used for a different change set.",
            );
          }
          return { value: await mapRecord(db, winner, now), replayed: true };
        }
      }
      return internal("Change-set create failed its persistence fence.");
    },

    async getChangeSet(stash: string, id: string): Promise<ChangeSetRecord | null> {
      if (!CHANGE_SET_ID.test(id)) validation("Invalid change-set id.");
      const db = env.DB.withSession("first-primary");
      const row = await db.prepare(SELECT_CHANGE_SET).bind(stash, id).first<ChangeSetRow>();
      return row === null ? null : mapRecord(db, row, deps.now());
    },

    async listChangeSets(
      stash: string,
      options: ListChangeSetOptions = {},
    ): Promise<ChangeSetListResponse> {
      const status = options.status ?? "open";
      if (!["open", "applied", "rejected", "expired", "all"].includes(status)) {
        validation("Invalid change-set status.");
      }
      const limit = options.limit ?? LIST_LIMIT_DEFAULT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
        validation("Invalid change-set limit.");
      }
      if (options.path !== undefined && !validatePath(options.path).ok) {
        validation("Invalid change-set path.");
      }
      const after = decodeCursor(options.after);
      const now = deps.now();
      const db = env.DB.withSession("first-primary");
      const query = { stash, status, path: options.path ?? null, now };
      const [page, count] = await Promise.all([
        selectChangeSets(db, { ...query, after, limit: limit + 1 }).all<ChangeSetRow>(),
        countChangeSets(db, query).first<{ total: number }>(),
      ]);
      const rows = page.results;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return {
        changeSets: await Promise.all(rows.map((item) => mapRecord(db, item, now))),
        nextAfter: hasMore && rows.at(-1) !== undefined ? encodeCursor(rows.at(-1)!) : null,
        total: count?.total ?? 0,
      };
    },

    async getChangeSetDiff(
      stash: string,
      id: string,
      options: ChangeSetDiffOptions = {},
    ): Promise<ChangeSetDiffResult | null> {
      if (!CHANGE_SET_ID.test(id)) validation("Invalid change-set id.");
      if (
        options.context !== undefined &&
        (!Number.isSafeInteger(options.context) || options.context < 0)
      ) {
        validation("Invalid diff context.");
      }
      const db = env.DB.withSession("first-primary");
      const row = await db.prepare(SELECT_CHANGE_SET).bind(stash, id).first<ChangeSetRow>();
      if (row === null) return null;
      let entries = await entriesFor(db, id);
      if (options.path !== undefined) {
        entries = entries.filter((entry) => entry.path === options.path);
        if (entries.length === 0) throw new StashError("not-found", "Change-set entry not found.");
      }
      const aggregateHeads = await Promise.all(
        entries.map((entry) => selectHead(db, stash, entry.path)),
      );
      const aggregateStale = entries.some(
        (entry, index) => (aggregateHeads[index]?.head_version ?? null) !== entry.base_version,
      );
      const truncated = options.path === undefined && entries.length > COMMIT_DIFF_INLINE_ENTRIES;
      if (truncated) entries = entries.slice(0, COMMIT_DIFF_INLINE_ENTRIES);
      const diffMaxBytes = parseBinarySettings(env).diffMaxBytes;
      const mapped = await Promise.all(
        entries.map(async (entry) => {
          const [baseRow, head] = await Promise.all([
            entry.base_version === null
              ? Promise.resolve(null)
              : selectVersion(db, stash, entry.path, entry.base_version),
            selectHead(db, stash, entry.path),
          ]);
          if (entry.base_version !== null && baseRow === null) {
            return internal("Change-set base version is missing.");
          }
          const stale = (head?.head_version ?? null) !== entry.base_version;
          const candidate =
            entry.op === "delete"
              ? null
              : {
                  version: (entry.base_version ?? 0) + 1,
                  hash: entry.blob_hash,
                  deleted: false,
                  kind: entry.op === "rollback" ? ("rollback" as const) : ("put" as const),
                  author: row.author,
                  createdAt: toIso(row.created_at),
                };
          let diff: ChangeSetDiffResult["entries"][number]["diff"];
          if (
            entry.op === "copy" ||
            entry.representation === "binary" ||
            (baseRow !== null && baseRow.representation === "binary")
          ) {
            diff = { state: "binary" };
          } else if (
            (baseRow?.size_bytes ?? 0) > diffMaxBytes ||
            (entry.size_bytes ?? 0) > diffMaxBytes
          ) {
            diff = { state: "oversized" };
          } else {
            const [fromText, toText] = await Promise.all([
              baseRow === null || baseRow.kind === "delete"
                ? Promise.resolve("")
                : textFor(env, baseRow),
              entry.op === "delete" ? Promise.resolve("") : textFor(env, entry),
            ]);
            diff = computeDiff({
              fromText,
              toText,
              fromLabel:
                entry.base_version === null
                  ? `a/${entry.path}@empty`
                  : `a/${entry.path}@v${entry.base_version}`,
              toLabel: `b/${entry.path}@${id}`,
              context: options.context,
            });
          }
          return {
            path: entry.path,
            op: entry.op,
            base: current(baseRow),
            candidate,
            current: current(head),
            stale,
            diff,
          };
        }),
      );
      return {
        entries: mapped,
        stale: aggregateStale,
        status: computedStatus(row, deps.now()),
        truncated,
      };
    },
  };
}
