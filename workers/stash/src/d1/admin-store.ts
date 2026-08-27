import {
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  ListQuery,
  StashError,
  canonicalJson,
  validateStashName,
  type ChangeItem,
  type ChangesPage,
  type CreatedToken,
  type JsonValue,
  type StashListResponse,
  type StashRecord,
  type StashSummary,
  type TokenListResponse,
  type TokenRecord,
} from "@takazudo/zudo-history-stash-core";
import { mintToken, sha256Hex } from "../auth.js";
import type { Env } from "../env.js";

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
    s.created_at
`;

const LIST_STASHES = `${STASH_COLUMNS}${STASH_AGGREGATES}
  WHERE (? IS NULL OR s.name > ?)
  ORDER BY s.name ASC
  LIMIT ?
`;

const GET_STASH = `${STASH_COLUMNS}${STASH_AGGREGATES}
  WHERE s.name = ?
`;

const LIST_TOKENS = `
  SELECT
    s.name AS stash_name,
    t.id,
    t.label,
    t.scope,
    t.created_at,
    t.revoked_at,
    t.last_used_at,
    t.expires_at,
    t.rotated_from,
    t.rotated_to
  FROM stashes AS s
  LEFT JOIN tokens AS t ON t.stash_name = s.name
  WHERE s.name = ?
  ORDER BY t.created_at DESC, t.id DESC
`;

const CHANGES_ASC = `
  SELECT
    id AS change_id,
    stash_name AS stash,
    path,
    version,
    kind,
    author,
    message,
    size_bytes AS size,
    created_at
  FROM versions
  WHERE id > ?
  ORDER BY id ASC
  LIMIT ?
`;

const CHANGES_BEFORE = `
  SELECT
    id AS change_id,
    stash_name AS stash,
    path,
    version,
    kind,
    author,
    message,
    size_bytes AS size,
    created_at
  FROM versions
  WHERE id < ?
  ORDER BY id DESC
  LIMIT ?
`;

const CHANGES_NEWEST = `
  SELECT
    id AS change_id,
    stash_name AS stash,
    path,
    version,
    kind,
    author,
    message,
    size_bytes AS size,
    created_at
  FROM versions
  ORDER BY id DESC
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
}

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
}

export interface AdminStore {
  listStashes(query: ListQuery): Promise<StashListResponse>;
  createStash(input: CreateStashBody): Promise<StashRecord>;
  getStash(stash: string): Promise<StashRecord | null>;
  createToken(stash: string, input: CreateTokenBody): Promise<CreatedToken>;
  listTokens(stash: string): Promise<TokenListResponse>;
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
  input: Pick<CreateTokenBody, "expiresAt" | "ttlSeconds">,
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

function mapStashSummary(row: StashAggregateRow): StashSummary {
  return {
    name: row.name,
    description: row.description,
    fileCount: row.file_count,
    deletedFileCount: row.deleted_file_count,
    lastChangeId: row.last_change_id,
    lastChangeAt: row.last_change_at === null ? null : toIso(row.last_change_at),
    createdAt: toIso(row.created_at),
  };
}

function mapStash(row: StashAggregateRow): StashRecord {
  return { ...mapStashSummary(row), meta: parseMeta(row.meta_json) };
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
      const parsed = ListQuery.safeParse(query);
      if (!parsed.success) validation("Invalid stash list query.");
      const { after, limit } = parsed.data;
      const db = env.DB.withSession("first-primary");
      const result = await db
        .prepare(LIST_STASHES)
        .bind(after ?? null, after ?? null, limit + 1)
        .all<StashAggregateRow>();
      const hasMore = result.results.length > limit;
      const rows = result.results.slice(0, limit);
      return {
        stashes: rows.map(mapStashSummary),
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
      };
    },

    async getStash(stash) {
      const name = validateStash(stash);
      const row = await env.DB.withSession("first-primary")
        .prepare(GET_STASH)
        .bind(name)
        .first<StashAggregateRow>();
      return row === null ? null : mapStash(row);
    },

    async createToken(stash, input) {
      const name = validateStash(stash);
      const parsed = CreateTokenBody.safeParse(input);
      if (!parsed.success) validation("Invalid token input.");
      const createdAt = deps.now();
      const expiresAt = resolveTokenExpiry(parsed.data, createdAt);
      const created = deps.mintToken();
      const tokenHash = await sha256Hex(created.token);
      const result = await env.DB.withSession("first-primary")
        .prepare(
          `INSERT INTO tokens
             (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
              expires_at, rotated_from, rotated_to)
           SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL
           WHERE EXISTS (SELECT 1 FROM stashes WHERE name = ?)`,
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
      if (result.results.length === 0) notFound();
      return { tokens: result.results.map(mapToken).filter((token) => token !== null) };
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
