import {
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  ListStashesQuery,
  RotateTokenBody,
  StashError,
  canonicalJson,
  validateStashName,
  type ChangeItem,
  type ChangesPage,
  type CreatedToken,
  type DeleteStashResult,
  type JsonValue,
  type ParsedListStashesQuery,
  type RotateTokenResult,
  type RestoreStashResult,
  type StashListResponse,
  type StashRecord,
  type StashSummary,
  type TokenListResponse,
  type TokenRecord,
} from "@takazudo/zudo-history-stash-core";
import { mintToken, sha256Hex } from "../auth.js";
import type { Env } from "../env.js";
import type { StashRow, TokenRow } from "./schema.js";

const STASH_AGGREGATES = `
  FROM stashes AS s
  LEFT JOIN (
    SELECT
      stash_name,
      SUM(deleted = 0) AS live,
      SUM(deleted = 1) AS dead
    FROM files
    GROUP BY stash_name
  ) AS file_counts ON file_counts.stash_name = s.name
  LEFT JOIN (
    SELECT
      stash_name,
      MAX(id) AS last_change_id,
      MAX(created_at) AS last_change_at
    FROM versions
    GROUP BY stash_name
  ) AS version_activity ON version_activity.stash_name = s.name
`;

const STASH_COLUMNS = `
  SELECT
    s.name,
    s.description,
    s.meta_json,
    COALESCE(file_counts.live, 0) AS file_count,
    COALESCE(file_counts.dead, 0) AS deleted_file_count,
    version_activity.last_change_id,
    version_activity.last_change_at,
    s.created_at,
    s.deleted_at
`;

const LIST_STASHES = `${STASH_COLUMNS}${STASH_AGGREGATES}
  WHERE (? = 1 OR s.deleted_at IS NULL)
    AND (? IS NULL OR s.name > ?)
  ORDER BY s.name ASC
  LIMIT ?
`;

const GET_STASH = `${STASH_COLUMNS}${STASH_AGGREGATES}
  WHERE s.name = ?
`;

const GET_STASH_FOR_LIFECYCLE = `${STASH_COLUMNS}${STASH_AGGREGATES}
  WHERE s.name = ?
`;

const GET_RESOLVED_STASH_ACTIVITY = `
  SELECT
    (SELECT COUNT(*) FROM files WHERE stash_name = ? AND deleted = 0) AS file_count,
    (SELECT COUNT(*) FROM files WHERE stash_name = ? AND deleted = 1) AS deleted_file_count,
    (SELECT MAX(id) FROM versions WHERE stash_name = ?) AS last_change_id,
    (SELECT MAX(created_at) FROM versions WHERE stash_name = ?) AS last_change_at
`;

const LIST_TOKENS = `
  SELECT
    stash_name,
    id,
    label,
    scope,
    created_at,
    revoked_at,
    last_used_at,
    expires_at,
    rotated_from,
    rotated_to
  FROM tokens
  WHERE stash_name = ?
  ORDER BY created_at DESC, id DESC
`;

const GET_TOKEN_FOR_ROTATION = `
  SELECT
    id,
    stash_name,
    token_hash,
    label,
    scope,
    created_at,
    revoked_at,
    last_used_at,
    expires_at,
    rotated_from,
    rotated_to
  FROM tokens
  WHERE id = ? AND stash_name = ?
`;

const INSERT_ROTATION_SUCCESSOR = `
  INSERT INTO tokens
    (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
     expires_at, rotated_from, rotated_to)
  SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL
  WHERE EXISTS (
    SELECT 1
    FROM tokens AS predecessor
    WHERE predecessor.id = ?
      AND predecessor.stash_name = ?
      AND predecessor.revoked_at IS NULL
      AND predecessor.rotated_to IS NULL
      AND (predecessor.expires_at IS NULL OR predecessor.expires_at > ?)
      AND EXISTS (
        SELECT 1 FROM stashes
        WHERE name = predecessor.stash_name AND deleted_at IS NULL
      )
  )
`;

const UPDATE_ROTATION_PREDECESSOR = `
  UPDATE tokens AS predecessor
  SET
    rotated_to = ?,
    expires_at = MIN(COALESCE(expires_at, ?), ?)
  WHERE predecessor.id = ?
    AND predecessor.stash_name = ?
    AND predecessor.revoked_at IS NULL
    AND predecessor.rotated_to IS NULL
    AND (predecessor.expires_at IS NULL OR predecessor.expires_at > ?)
    AND EXISTS (
      SELECT 1 FROM stashes
      WHERE name = predecessor.stash_name AND deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM tokens AS successor
      WHERE successor.id = ?
        AND successor.stash_name = ?
        AND successor.rotated_from = ?
    )
`;

const CHANGES_ASC = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path,
    v.version,
    v.kind,
    v.author,
    v.message,
    v.size_bytes AS size,
    v.created_at
  FROM versions AS v
  INNER JOIN stashes AS s ON s.name = v.stash_name AND s.deleted_at IS NULL
  WHERE v.id > ?
  ORDER BY v.id ASC
  LIMIT ?
`;

const CHANGES_BEFORE = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path,
    v.version,
    v.kind,
    v.author,
    v.message,
    v.size_bytes AS size,
    v.created_at
  FROM versions AS v
  INNER JOIN stashes AS s ON s.name = v.stash_name AND s.deleted_at IS NULL
  WHERE v.id < ?
  ORDER BY v.id DESC
  LIMIT ?
`;

const CHANGES_NEWEST = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path,
    v.version,
    v.kind,
    v.author,
    v.message,
    v.size_bytes AS size,
    v.created_at
  FROM versions AS v
  INNER JOIN stashes AS s ON s.name = v.stash_name AND s.deleted_at IS NULL
  ORDER BY v.id DESC
  LIMIT ?
`;

interface StashAggregateRow {
  name: string;
  description: string;
  meta_json: string;
  file_count: number;
  deleted_file_count: number;
  last_change_id: number | null;
  last_change_at: number | null;
  created_at: number;
  deleted_at: number | null;
}

type StashActivityRow = Pick<
  StashAggregateRow,
  "file_count" | "deleted_file_count" | "last_change_id" | "last_change_at"
>;

type LifecycleStashAggregateRow = StashAggregateRow;

interface TokenListRow {
  stash_name: string;
  id: string | null;
  label: string | null;
  scope: "read" | "write" | null;
  created_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  expires_at: number | null;
  rotated_from: string | null;
  rotated_to: string | null;
}

interface ChangeRow {
  change_id: number;
  stash: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  author: string;
  message: string;
  size: number;
  created_at: number;
}

export interface AdminStoreDependencies {
  now: () => number;
  mintToken: () => { id: string; token: string };
  onBeforeCreateTokenCommit?: () => void | Promise<void>;
  onBeforeRotateCommit?: () => void | Promise<void>;
}

export interface AdminStore {
  listStashes(query: ParsedListStashesQuery): Promise<StashListResponse>;
  createStash(input: CreateStashBody): Promise<StashRecord>;
  getStash(stash: string): Promise<StashRecord | null>;
  getResolvedStash(stash: StashRow): Promise<StashRecord>;
  deleteStash(stash: string): Promise<DeleteStashResult>;
  restoreStash(stash: string): Promise<RestoreStashResult>;
  createToken(stash: string, input: CreateTokenBody): Promise<CreatedToken>;
  listTokens(stash: string): Promise<TokenListResponse>;
  rotateToken(stash: string, id: string, input: RotateTokenBody): Promise<RotateTokenResult>;
  revokeToken(stash: string, id: string): Promise<void>;
  listChanges(query: ChangesQuery): Promise<ChangesPage>;
}

const defaultDependencies: AdminStoreDependencies = {
  now: () => Date.now(),
  mintToken: () => mintToken(),
};

const MAX_TOKEN_TTL_MS = 315_360_000 * 1_000;

function validation(message: string): never {
  throw new StashError("validation", message);
}

function notFound(): never {
  throw new StashError("not-found", "The requested resource was not found.");
}

function validateStash(stash: string): string {
  const result = validateStashName(stash);
  if (!result.ok) validation(result.message);
  return stash;
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
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // Corrupt metadata is contained to an empty object at the serialization boundary.
  }
  return {};
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function resolveTokenExpiry(
  input: { expiresAt?: string; ttlSeconds?: number },
  now: number,
): number | null {
  const expiresAt =
    input.expiresAt !== undefined
      ? Date.parse(input.expiresAt)
      : input.ttlSeconds !== undefined
        ? now + input.ttlSeconds * 1_000
        : null;
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_TOKEN_TTL_MS)
  ) {
    validation("Token expiry must be in the future and no more than ten years away.");
  }
  return expiresAt;
}

function knownRotationRefusal(row: TokenRow | null, now: number): StashError | null {
  if (row === null || row.revoked_at !== null) {
    return new StashError("not-found", "The requested resource was not found.");
  }
  if (row.rotated_to !== null) {
    return new StashError(
      "already-rotated",
      "Token was already rotated.",
      undefined,
      row.rotated_to,
    );
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    return new StashError("token-expired", "Token is expired.");
  }
  return null;
}

function assertRotationEligible(row: TokenRow | null, now: number): asserts row is TokenRow {
  const refusal = knownRotationRefusal(row, now);
  if (refusal !== null) throw refusal;
}

function mapStashSummary(
  row: StashAggregateRow,
  now: number,
  deletionGraceMs: number,
): StashSummary {
  const restoreUntil = row.deleted_at === null ? null : row.deleted_at + deletionGraceMs;
  return {
    name: row.name,
    description: row.description,
    fileCount: row.file_count,
    deletedFileCount: row.deleted_file_count,
    lastChangeId: row.last_change_id,
    lastChangeAt: row.last_change_at === null ? null : toIso(row.last_change_at),
    createdAt: toIso(row.created_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
    restoreUntil: restoreUntil === null ? null : toIso(restoreUntil),
    restorable: restoreUntil !== null && now < restoreUntil,
  };
}

function mapStash(row: StashAggregateRow, now: number, deletionGraceMs: number): StashRecord {
  return { ...mapStashSummary(row, now, deletionGraceMs), meta: parseMeta(row.meta_json) };
}

function graceMs(env: Env): number {
  const days = Number(env.STASH_DELETE_GRACE_DAYS);
  const value = days * 86_400_000;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new StashError("internal", "Stash deletion grace period is invalid.");
  }
  return value;
}

function mapToken(row: TokenListRow): TokenRecord | null {
  if (row.id === null) return null;
  if (
    row.label === null ||
    row.scope === null ||
    row.created_at === null ||
    (row.scope !== "read" && row.scope !== "write")
  ) {
    throw new StashError("internal", "Stored token metadata is invalid.");
  }
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    createdAt: toIso(row.created_at),
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    rotatedFrom: row.rotated_from,
    rotatedTo: row.rotated_to,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : toIso(row.last_used_at),
  };
}

function mapChange(row: ChangeRow): ChangeItem {
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

export function createAdminStore(
  env: Env,
  dependencies: Partial<AdminStoreDependencies> = {},
): AdminStore {
  const deps = { ...defaultDependencies, ...dependencies };

  return {
    async listStashes(query) {
      const parsed = ListStashesQuery.safeParse(query);
      if (!parsed.success) validation("Invalid stash list query.");
      const { after, includeDeleted, limit } = parsed.data;
      const now = deps.now();
      const deletionGraceMs = graceMs(env);
      const db = env.DB.withSession("first-primary");
      const result = await db
        .prepare(LIST_STASHES)
        .bind(includeDeleted ? 1 : 0, after ?? null, after ?? null, limit + 1)
        .all<StashAggregateRow>();
      const hasMore = result.results.length > limit;
      const rows = result.results.slice(0, limit);
      return {
        stashes: rows.map((row) => mapStashSummary(row, now, deletionGraceMs)),
        nextAfter: hasMore ? (rows.at(-1)?.name ?? null) : null,
      };
    },

    async createStash(input) {
      const parsed = CreateStashBody.safeParse(input);
      if (!parsed.success) validation("Invalid stash input.");
      const createdAt = deps.now();
      const result = await env.DB.withSession("first-primary")
        .prepare(
          `INSERT INTO stashes (name, description, meta_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO NOTHING`,
        )
        .bind(
          parsed.data.name,
          parsed.data.description ?? "",
          canonicalJson(parsed.data.meta ?? {}),
          createdAt,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new StashError("exists", "A stash with that name already exists.");
      }
      return {
        name: parsed.data.name,
        description: parsed.data.description ?? "",
        meta: parsed.data.meta ?? {},
        fileCount: 0,
        deletedFileCount: 0,
        lastChangeId: null,
        lastChangeAt: null,
        createdAt: toIso(createdAt),
        deletedAt: null,
        restoreUntil: null,
        restorable: false,
      };
    },

    async getStash(stash) {
      const name = validateStash(stash);
      const row = await env.DB.withSession("first-primary")
        .prepare(GET_STASH)
        .bind(name)
        .first<StashAggregateRow>();
      return row === null ? null : mapStash(row, deps.now(), graceMs(env));
    },

    async getResolvedStash(stash) {
      const activity = await env.DB.withSession("first-primary")
        .prepare(GET_RESOLVED_STASH_ACTIVITY)
        .bind(stash.name, stash.name, stash.name, stash.name)
        .first<StashActivityRow>();
      if (activity === null) {
        throw new StashError("internal", "Stash activity could not be read.");
      }
      return mapStash({ ...stash, ...activity }, deps.now(), graceMs(env));
    },

    async deleteStash(stash) {
      const name = validateStash(stash);
      const deletedAt = deps.now();
      const restoreUntil = deletedAt + graceMs(env);
      const db = env.DB.withSession("first-primary");
      const results = await db.batch([
        db
          .prepare(
            `UPDATE tokens SET revoked_at = ?
             WHERE stash_name = ? AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL
               )`,
          )
          .bind(deletedAt, name, name),
        db
          .prepare("UPDATE stashes SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL")
          .bind(deletedAt, name),
      ]);
      if (results.at(-1)?.meta.changes !== 1) {
        const row = await db
          .prepare("SELECT deleted_at FROM stashes WHERE name = ?")
          .bind(name)
          .first<{ deleted_at: number | null }>();
        if (row === null) notFound();
        throw new StashError("already-deleted", "Stash is already deleted.");
      }
      return {
        name,
        deletedAt: toIso(deletedAt),
        revokedTokens: results[0]?.meta.changes ?? 0,
        restoreUntil: toIso(restoreUntil),
      };
    },

    async restoreStash(stash) {
      const name = validateStash(stash);
      const now = deps.now();
      const db = env.DB.withSession("first-primary");
      const results = await db.batch([
        db
          .prepare(
            `UPDATE stashes SET deleted_at = NULL
             WHERE name = ? AND deleted_at IS NOT NULL AND deleted_at > ?`,
          )
          .bind(name, now - graceMs(env)),
      ]);
      if (results.at(-1)?.meta.changes !== 1) notFound();
      const row = await db
        .prepare(GET_STASH_FOR_LIFECYCLE)
        .bind(name)
        .first<LifecycleStashAggregateRow>();
      if (row === null) notFound();
      return mapStash(row, now, graceMs(env));
    },

    async createToken(stash, input) {
      const name = validateStash(stash);
      const parsed = CreateTokenBody.safeParse(input);
      if (!parsed.success) validation("Invalid token input.");
      const createdAt = deps.now();
      const expiresAt = resolveTokenExpiry(parsed.data, createdAt);
      const created = deps.mintToken();
      const tokenHash = await sha256Hex(created.token);
      await deps.onBeforeCreateTokenCommit?.();
      const result = await env.DB.withSession("first-primary")
        .prepare(
          `INSERT INTO tokens
             (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
              expires_at, rotated_from, rotated_to)
           SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL
           WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)`,
        )
        .bind(
          created.id,
          name,
          tokenHash,
          parsed.data.label ?? "",
          parsed.data.scope,
          createdAt,
          expiresAt,
          name,
        )
        .run();
      if (result.meta.changes !== 1) notFound();
      return {
        id: created.id,
        token: created.token,
        label: parsed.data.label ?? "",
        scope: parsed.data.scope,
        createdAt: toIso(createdAt),
        expiresAt: expiresAt === null ? null : toIso(expiresAt),
        rotatedFrom: null,
      };
    },

    async listTokens(stash) {
      const name = validateStash(stash);
      const result = await env.DB.withSession("first-primary")
        .prepare(LIST_TOKENS)
        .bind(name)
        .all<TokenListRow>();
      return { tokens: result.results.map(mapToken).filter((token) => token !== null) };
    },

    async rotateToken(stash, id, input) {
      const name = validateStash(stash);
      const parsed = RotateTokenBody.safeParse(input);
      if (!parsed.success) validation("Invalid token rotation input.");

      const now = deps.now();
      const db = env.DB.withSession("first-primary");
      const predecessor = await db.prepare(GET_TOKEN_FOR_ROTATION).bind(id, name).first<TokenRow>();
      assertRotationEligible(predecessor, now);

      const hasExpiryOverride =
        parsed.data.expiresAt !== undefined || parsed.data.ttlSeconds !== undefined;
      const successorExpiresAt = hasExpiryOverride
        ? resolveTokenExpiry(parsed.data, now)
        : predecessor.expires_at;
      const graceEnd = now + parsed.data.graceSeconds * 1_000;
      const predecessorExpiresAt = Math.min(predecessor.expires_at ?? graceEnd, graceEnd);
      const created = deps.mintToken();
      const tokenHash = await sha256Hex(created.token);

      await deps.onBeforeRotateCommit?.();
      let batchFailure: { error: unknown } | undefined;
      try {
        const results = await db.batch([
          db
            .prepare(INSERT_ROTATION_SUCCESSOR)
            .bind(
              created.id,
              name,
              tokenHash,
              predecessor.label,
              predecessor.scope,
              now,
              successorExpiresAt,
              predecessor.id,
              predecessor.id,
              name,
              now,
            ),
          db
            .prepare(UPDATE_ROTATION_PREDECESSOR)
            .bind(
              created.id,
              graceEnd,
              graceEnd,
              predecessor.id,
              name,
              now,
              created.id,
              name,
              predecessor.id,
            ),
        ]);
        if (results.at(-1)?.meta.changes === 1) {
          return {
            id: created.id,
            token: created.token,
            label: predecessor.label,
            scope: predecessor.scope,
            createdAt: toIso(now),
            expiresAt: successorExpiresAt === null ? null : toIso(successorExpiresAt),
            rotatedFrom: predecessor.id,
            predecessor: {
              id: predecessor.id,
              expiresAt: toIso(predecessorExpiresAt),
            },
          };
        }
      } catch (error) {
        // The outcome can be ambiguous if D1 commits but the batch response is lost.
        batchFailure = { error };
      }

      const current = await db
        .prepare(GET_TOKEN_FOR_ROTATION)
        .bind(predecessor.id, name)
        .first<TokenRow>();
      const refusal = knownRotationRefusal(current, now);
      if (refusal !== null) throw refusal;
      if (batchFailure !== undefined) throw batchFailure.error;
      throw new StashError("internal", "Token rotation could not be completed.");
    },

    async revokeToken(stash, id) {
      const name = validateStash(stash);
      const result = await env.DB.withSession("first-primary")
        .prepare("UPDATE tokens SET revoked_at = ? WHERE stash_name = ? AND id = ?")
        .bind(deps.now(), name, id)
        .run();
      if (result.meta.changes !== 1) notFound();
    },

    async listChanges(query) {
      const parsed = ChangesQuery.safeParse(query);
      if (!parsed.success) validation("Invalid changes query.");
      const { before, limit, since } = parsed.data;
      const db = env.DB.withSession("first-primary");
      const statement =
        since !== undefined
          ? db.prepare(CHANGES_ASC).bind(since, limit + 1)
          : before !== undefined
            ? db.prepare(CHANGES_BEFORE).bind(before, limit + 1)
            : db.prepare(CHANGES_NEWEST).bind(limit + 1);
      const result = await statement.all<ChangeRow>();
      const hasMore = result.results.length > limit;
      const rows = result.results.slice(0, limit);
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
