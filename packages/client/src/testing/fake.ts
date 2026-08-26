import {
  BODY_LIMIT_BYTES,
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  DiffCandidateBody,
  DiffQuery,
  FileGetQuery,
  HistoryQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListFilesQuery,
  ListQuery,
  MAX_BODY_BYTES,
  PutFileBody,
  ROUTES,
  RollbackBody,
  canonicalJson,
  computeDiff,
  formatEtag,
  ifNoneMatchMatches,
  isWellFormedString,
  requestHashInput,
  sha256Hex,
  statusForCode,
  utf8ByteLength,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
import type {
  Current,
  DiffSide,
  ErrorCode,
  JsonValue,
  RouteId,
  TokenScope,
} from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../client.js";
import type {
  FakeBlobRow,
  FakeFileRow,
  FakeIdempotencyRow,
  FakeStash,
  FakeStashOptions,
  FakeStashRow,
  FakeStashState,
  FakeTokenRow,
  FakeVersionRow,
} from "./types.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";
const MAX_DIFF_CONTEXT = 10;
const LAST_USED_INTERVAL_MS = 60_000;
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

const SUPPORTED_ROUTE_IDS = new Set<RouteId>([
  "me",
  "listStashes",
  "createStash",
  "getStash",
  "createToken",
  "listTokens",
  "revokeToken",
  "listFiles",
  "getFile",
  "putFile",
  "deleteFile",
  "rollbackFile",
  "getHistory",
  "getDiff",
  "diffCandidate",
  "getStashChanges",
]);

type Principal =
  | { kind: "admin" }
  | {
      kind: "stash";
      stash: string;
      tokenId: string;
      scope: TokenScope;
      expiresAt: number | null;
    };

interface MatchedRoute {
  routeId: RouteId;
  stash?: string;
  path?: string;
  tokenId?: string;
}

class FakeHttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: Current;

  constructor(code: ErrorCode, message: string, current?: Current) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
    this.current = current;
  }
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Content-Type")) responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function unsupported(): Response {
  return json(
    { error: { code: "not-implemented", message: "This route is not implemented by the fake." } },
    501,
  );
}

function errorResponse(error: FakeHttpError): Response {
  return json(
    {
      error: { code: error.code, message: error.message },
      ...(error.status === 409 && error.current !== undefined ? { current: error.current } : {}),
    },
    error.status,
  );
}

function fail(code: ErrorCode, message: string, current?: Current): never {
  throw new FakeHttpError(code, message, current);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return fail("invalid-path", "Invalid URL encoding.");
  }
}

function routeMatch(request: Request): MatchedRoute | undefined {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "GET" && pathname === "/v1/me") return { routeId: "me" };
  if (method === "GET" && pathname === "/v1/stashes") return { routeId: "listStashes" };
  if (method === "POST" && pathname === "/v1/stashes") return { routeId: "createStash" };

  let match = /^\/v1\/stashes\/([^/]+)\/tokens\/([^/]+)$/.exec(pathname);
  if (method === "DELETE" && match?.[1] !== undefined && match[2] !== undefined) {
    return {
      routeId: "revokeToken",
      stash: decode(match[1]),
      tokenId: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/tokens$/.exec(pathname);
  if ((method === "GET" || method === "POST") && match?.[1] !== undefined) {
    return {
      routeId: method === "GET" ? "listTokens" : "createToken",
      stash: decode(match[1]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "getStash", stash: decode(match[1]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/files$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "listFiles", stash: decode(match[1]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/files\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "PUT") && match?.[1] && match[2]) {
    return {
      routeId: method === "GET" ? "getFile" : "putFile",
      stash: decode(match[1]),
      path: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/delete\/(.+)$/.exec(pathname);
  if (method === "POST" && match?.[1] && match[2]) {
    return { routeId: "deleteFile", stash: decode(match[1]), path: decode(match[2]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/rollback\/(.+)$/.exec(pathname);
  if (method === "POST" && match?.[1] && match[2]) {
    return { routeId: "rollbackFile", stash: decode(match[1]), path: decode(match[2]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/history\/(.+)$/.exec(pathname);
  if (method === "GET" && match?.[1] && match[2]) {
    return { routeId: "getHistory", stash: decode(match[1]), path: decode(match[2]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/diff\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "POST") && match?.[1] && match[2]) {
    return {
      routeId: method === "GET" ? "getDiff" : "diffCandidate",
      stash: decode(match[1]),
      path: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/changes$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "getStashChanges", stash: decode(match[1]) };
  }
  return undefined;
}

function cloneMeta(meta: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  return JSON.parse(canonicalJson(meta ?? {})) as Record<string, JsonValue>;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function ordered<T extends { path: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

function ensureSafeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && !Number.isSafeInteger(value)) {
    fail("validation", `${name} must be a safe integer.`);
  }
}

function requirePath(path: string | undefined): string {
  if (path === undefined) return fail("invalid-path", "Invalid file path.");
  const result = validatePath(path);
  if (!result.ok) return fail(result.error, result.message);
  return path;
}

async function requestJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type");
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) {
    return fail("validation", "The request body must be JSON.");
  }
  const text = await request.text();
  if (utf8ByteLength(text) > BODY_LIMIT_BYTES) {
    return fail("payload-too-large", "The request payload is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("validation", "The request body must be valid JSON.");
  }
}

function current(file: FakeFileRow, version: FakeVersionRow): Current {
  return {
    version: file.headVersion,
    hash: file.headHash,
    deleted: file.deleted,
    kind: version.kind,
    author: version.author,
    createdAt: iso(version.createdAt),
  };
}

function changesPage(rows: FakeVersionRow[], since: number | undefined, limit: number) {
  const orderedRows =
    since === undefined
      ? [...rows].sort((left, right) => right.changeId - left.changeId)
      : [...rows].sort((left, right) => left.changeId - right.changeId);
  const hasMore = orderedRows.length > limit;
  const page = orderedRows.slice(0, limit);
  const changes = page.map((row) => ({
    changeId: row.changeId,
    stash: row.stash,
    path: row.path,
    version: row.version,
    kind: row.kind,
    author: row.author,
    message: row.message,
    size: row.size,
    createdAt: iso(row.createdAt),
  }));
  if (since !== undefined) {
    return {
      changes,
      nextSince: hasMore ? (page.at(-1)?.changeId ?? null) : null,
      hasMore,
    };
  }
  return {
    changes,
    nextBefore: hasMore ? (page.at(-1)?.changeId ?? null) : null,
    hasMore,
  };
}

/**
 * Creates a small consumer fake. It models only the route IDs in the issue; all other endpoints
 * intentionally return 501 so a test cannot accidentally depend on an unmodelled server feature.
 */
export function createFakeStash(options: FakeStashOptions = {}): FakeStash {
  const now = options.now ?? Date.now;
  const adminToken = options.adminToken ?? "admin";
  const state: FakeStashState = {
    stashes: new Map(),
    tokens: new Map(),
    blobs: new Map(),
    files: new Map(),
    versions: [],
    idempotency: new Map(),
  };
  let nextToken = 1;
  let nextChangeId = 1;

  const nested = <T>(table: Map<string, Map<string, T>>, stash: string): Map<string, T> => {
    let rows = table.get(stash);
    if (rows === undefined) {
      rows = new Map();
      table.set(stash, rows);
    }
    return rows;
  };

  const getFile = (stash: string, path: string): FakeFileRow | undefined =>
    state.files.get(stash)?.get(path);
  const versionsFor = (stash: string, path: string): FakeVersionRow[] =>
    state.versions.filter((row) => row.stash === stash && row.path === path);
  const getVersion = (stash: string, path: string, version: number): FakeVersionRow | undefined =>
    state.versions.find(
      (row) => row.stash === stash && row.path === path && row.version === version,
    );
  const getHeadVersion = (file: FakeFileRow): FakeVersionRow => {
    const version = getVersion(file.stash, file.path, file.headVersion);
    if (version === undefined)
      return fail("internal", "The fake head points at a missing version.");
    return version;
  };
  const bodyFor = (version: FakeVersionRow): string => {
    if (version.hash === null) return "";
    const body = state.blobs.get(version.stash)?.get(version.hash)?.body;
    if (body === undefined) return fail("internal", "The fake version points at a missing blob.");
    return body;
  };
  const requireStash = (stash: string): FakeStashRow => {
    const row = state.stashes.get(stash);
    if (row === undefined) return fail("not-found", "The requested resource was not found.");
    return row;
  };

  const requireAdminStash = (stash: string): FakeStashRow => {
    const validation = validateStashName(stash);
    if (!validation.ok) return fail("validation", validation.message);
    return requireStash(stash);
  };

  const stashRecord = (row: FakeStashRow) => {
    const files = [...(state.files.get(row.name)?.values() ?? [])];
    const versions = state.versions.filter((version) => version.stash === row.name);
    const last = versions.reduce<FakeVersionRow | undefined>(
      (latest, version) =>
        latest === undefined || version.changeId > latest.changeId ? version : latest,
      undefined,
    );
    return {
      name: row.name,
      description: row.description,
      meta: cloneMeta(row.meta),
      fileCount: files.filter((file) => !file.deleted).length,
      deletedFileCount: files.filter((file) => file.deleted).length,
      lastChangeId: last?.changeId ?? null,
      lastChangeAt: last === undefined ? null : iso(last.createdAt),
      createdAt: iso(row.createdAt),
    };
  };

  const createStashRow = (
    name: string,
    description = "",
    meta: Record<string, JsonValue> = {},
  ): FakeStashRow => {
    const validation = validateStashName(name);
    if (!validation.ok) return fail("validation", validation.message);
    if (state.stashes.has(name)) {
      return fail("exists", "A stash with that name already exists.");
    }
    const row = { name, description, meta: cloneMeta(meta), createdAt: now() };
    state.stashes.set(name, row);
    return row;
  };

  const mintStoredToken = async (
    stash: string,
    scope: TokenScope,
    label: string,
  ): Promise<{ row: FakeTokenRow; token: string }> => {
    requireAdminStash(stash);
    const serial = nextToken;
    nextToken += 1;
    const tokenSerial = serial.toString(36).padStart(43, "0");
    const idSerial = serial.toString(16).padStart(32, "0");
    const token = `zhs_${tokenSerial}`;
    const createdAt = now();
    const row: FakeTokenRow = {
      id: `tok_${idSerial}`,
      tokenHash: (await sha256Hex(token)).slice("sha256-".length),
      stash,
      label,
      scope,
      createdAt,
      expiresAt: null,
      rotatedFrom: null,
      rotatedTo: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    state.tokens.set(row.id, row);
    return { row, token };
  };

  const authenticate = async (request: Request): Promise<Principal> => {
    const authorization = request.headers.get("Authorization");
    const match = authorization === null ? null : /^Bearer ([^\s,]+)$/.exec(authorization);
    const token = match?.[1];
    if (token === undefined) return fail("unauthorized", "A valid bearer token is required.");
    if (token === adminToken) return { kind: "admin" };
    if (!token.startsWith("zhs_")) {
      return fail("unauthorized", "A valid bearer token is required.");
    }
    const tokenHash = (await sha256Hex(token)).slice("sha256-".length);
    const row = [...state.tokens.values()].find(
      (candidate) => candidate.tokenHash === tokenHash && candidate.revokedAt === null,
    );
    if (row === undefined) return fail("unauthorized", "A valid bearer token is required.");
    const usedAt = now();
    if (row.lastUsedAt === null || row.lastUsedAt <= usedAt - LAST_USED_INTERVAL_MS) {
      row.lastUsedAt = usedAt;
    }
    return {
      kind: "stash",
      stash: row.stash,
      tokenId: row.id,
      scope: row.scope,
      expiresAt: row.expiresAt,
    };
  };

  const authorize = (principal: Principal, match: MatchedRoute): void => {
    const route = ROUTES.find((candidate) => candidate.id === match.routeId);
    if (route === undefined) return fail("internal", "The fake route table is out of sync.");
    if (principal.kind === "admin") return;
    if (route.principal === "admin") {
      return fail("not-found", "The requested resource was not found.");
    }
    if (match.stash !== undefined && match.stash !== principal.stash) {
      return fail("not-found", "The requested resource was not found.");
    }
    if (route.principal === "write" && principal.scope !== "write") {
      return fail("scope", "This token does not have write access.");
    }
  };

  const idempotencyKey = (request: Request): string | undefined => {
    const key = request.headers.get("Idempotency-Key") ?? undefined;
    if (key !== undefined && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS)) {
      return fail(
        "validation",
        `Idempotency-Key must contain between 1 and ${IDEMPOTENCY_KEY_MAX_CHARS} characters.`,
      );
    }
    return key;
  };

  const replay = (
    stash: string,
    key: string | undefined,
    requestHash: string,
  ): Response | undefined => {
    if (key === undefined) return undefined;
    const ledger = state.idempotency.get(stash)?.get(key);
    if (ledger === undefined) return undefined;
    if (ledger.requestHash !== requestHash) {
      return errorResponse(
        new FakeHttpError("idempotency-key-reused", "Idempotency key was used for another request"),
      );
    }
    const version = getVersion(stash, ledger.path, ledger.version);
    if (version === undefined)
      return fail("internal", "The fake ledger points at a missing version.");
    const base = {
      version: version.version,
      changeId: version.changeId,
      createdAt: iso(version.createdAt),
    };
    let value: unknown;
    if (version.kind === "delete") {
      value = base;
    } else if (version.kind === "rollback") {
      const previous = getVersion(stash, ledger.path, version.version - 1);
      if (version.hash === null || version.rollbackOf === null || previous === undefined) {
        return fail("internal", "The fake rollback ledger row is invalid.");
      }
      value = {
        ...base,
        hash: version.hash,
        rollbackOf: version.rollbackOf,
        identicalToHead: previous.hash === version.hash,
      };
    } else {
      if (version.hash === null) return fail("internal", "The fake put ledger row is invalid.");
      value = { ...base, hash: version.hash, size: version.size };
    }
    return json(value, ledger.statusCode, { "Idempotent-Replayed": "true" });
  };

  const append = (
    stash: string,
    path: string,
    input: Omit<FakeVersionRow, "changeId" | "stash" | "path" | "version" | "createdAt">,
  ): FakeVersionRow => {
    const file = getFile(stash, path);
    const createdAt = now();
    const row: FakeVersionRow = {
      ...input,
      changeId: nextChangeId,
      stash,
      path,
      version: (file?.headVersion ?? 0) + 1,
      createdAt,
    };
    nextChangeId += 1;
    state.versions.push(row);
    if (file === undefined) {
      nested(state.files, stash).set(path, {
        stash,
        path,
        headVersion: row.version,
        headHash: row.hash,
        deleted: row.kind === "delete",
        createdAt,
        updatedAt: createdAt,
      });
    } else {
      file.headVersion = row.version;
      file.headHash = row.hash;
      file.deleted = row.kind === "delete";
      file.updatedAt = createdAt;
    }
    return row;
  };

  const ledger = (
    stash: string,
    key: string | undefined,
    requestHash: string,
    version: FakeVersionRow,
    statusCode: 200 | 201,
  ): void => {
    if (key === undefined) return;
    const row: FakeIdempotencyRow = {
      stash,
      key,
      requestHash,
      path: version.path,
      version: version.version,
      statusCode,
      createdAt: version.createdAt,
    };
    nested(state.idempotency, stash).set(key, row);
  };

  const handleCreateStash = async (request: Request): Promise<Response> => {
    const candidate = await requestJson(request);
    const parsed = CreateStashBody.safeParse(candidate);
    if (!parsed.success) return fail("validation", "Invalid stash input.");
    const row = createStashRow(
      parsed.data.name,
      parsed.data.description ?? "",
      parsed.data.meta ?? {},
    );
    return json(stashRecord(row), 201);
  };

  const handleListStashes = (url: URL): Response => {
    const parsed = ListQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid stash list query.");
    const candidates = [...state.stashes.values()]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .filter((row) => parsed.data.after === undefined || row.name > parsed.data.after);
    const hasMore = candidates.length > parsed.data.limit;
    const page = candidates.slice(0, parsed.data.limit);
    return json({
      stashes: page.map((row) => {
        const { meta: _meta, ...summary } = stashRecord(row);
        return summary;
      }),
      nextAfter: hasMore ? (page.at(-1)?.name ?? null) : null,
    });
  };

  const handleGetStash = (stash: string): Response => json(stashRecord(requireAdminStash(stash)));

  const handleCreateToken = async (request: Request, stash: string): Promise<Response> => {
    const parsed = CreateTokenBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid token input.");
    const { row, token } = await mintStoredToken(stash, parsed.data.scope, parsed.data.label ?? "");
    return json(
      {
        id: row.id,
        token,
        label: row.label,
        scope: row.scope,
        createdAt: iso(row.createdAt),
        expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
        rotatedFrom: row.rotatedFrom,
      },
      201,
    );
  };

  const handleListTokens = (stash: string): Response => {
    requireAdminStash(stash);
    const tokens = [...state.tokens.values()]
      .filter((row) => row.stash === stash)
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
      )
      .map((row) => ({
        id: row.id,
        label: row.label,
        scope: row.scope,
        createdAt: iso(row.createdAt),
        expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
        rotatedFrom: row.rotatedFrom,
        rotatedTo: row.rotatedTo,
        revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
        lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
      }));
    return json({ tokens });
  };

  const handleRevokeToken = (stash: string, id: string): Response => {
    const name = requireAdminStash(stash).name;
    const row = state.tokens.get(id);
    if (row === undefined || row.stash !== name) {
      return fail("not-found", "The requested resource was not found.");
    }
    row.revokedAt = now();
    return new Response(null, { status: 204 });
  };

  const handleListFiles = (stash: string, url: URL): Response => {
    const parsed = ListFilesQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid file list query.");
    const { after, includeDeleted, limit } = parsed.data;
    const candidates = ordered([...(state.files.get(stash)?.values() ?? [])]).filter(
      (file) => (includeDeleted || !file.deleted) && (after === undefined || file.path > after),
    );
    const hasMore = candidates.length > limit;
    const page = candidates.slice(0, limit);
    return json({
      files: page.map((file) => {
        const head = getHeadVersion(file);
        return {
          path: file.path,
          headVersion: file.headVersion,
          hash: file.headHash,
          size: head.size,
          deleted: file.deleted,
          updatedAt: iso(file.updatedAt),
        };
      }),
      nextAfter: hasMore ? (page.at(-1)?.path ?? null) : null,
    });
  };

  const handleGetFile = (request: Request, stash: string, path: string, url: URL): Response => {
    const parsed = FileGetQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid file query.");
    const file = getFile(stash, path);
    if (file === undefined) {
      return fail(
        parsed.data.version === undefined ? "not-found" : "version-not-found",
        parsed.data.version === undefined ? "File not found." : "Version not found.",
      );
    }
    const version =
      parsed.data.version === undefined
        ? getHeadVersion(file)
        : getVersion(stash, path, parsed.data.version);
    if (version === undefined) return fail("version-not-found", "Version not found.");
    if (version.kind === "delete" && parsed.data.version === undefined) {
      return json(
        {
          error: { code: "file-deleted", message: "The file head is deleted." },
          current: current(file, version),
        },
        404,
      );
    }
    const deleted = version.kind === "delete";
    const etag = deleted
      ? formatEtag({ version: version.version, hash: null, deleted: true })
      : formatEtag({ version: version.version, hash: version.hash ?? "", deleted: false });
    const headers = { ETag: etag, "X-Stash-Version": String(version.version) };
    if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return json(
      {
        path,
        version: version.version,
        hash: version.hash,
        size: version.size,
        kind: version.kind,
        author: version.author,
        message: version.message,
        meta: cloneMeta(version.meta),
        createdAt: iso(version.createdAt),
        deleted,
        body: deleted ? null : bodyFor(version),
      },
      200,
      headers,
    );
  };

  const handlePut = async (request: Request, stash: string, path: string): Promise<Response> => {
    requireStash(stash);
    const key = idempotencyKey(request);
    const candidate = await requestJson(request);
    const parsed = PutFileBody.safeParse(candidate);
    if (!parsed.success) {
      if (typeof candidate === "object" && candidate !== null && "body" in candidate) {
        const body = candidate.body;
        if (typeof body === "string" && !isWellFormedString(body)) {
          return fail("body-not-well-formed", "Body is not well-formed Unicode.");
        }
        if (typeof body === "string" && utf8ByteLength(body) > MAX_BODY_BYTES) {
          return fail("payload-too-large", "The file body is too large.");
        }
      }
      return fail("validation", "Invalid file write input.");
    }
    const bodyHash = await sha256Hex(parsed.data.body);
    const contentType = parsed.data.contentType ?? DEFAULT_CONTENT_TYPE;
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("put", {
          path,
          expectedVersion: parsed.data.expectedVersion,
          bodyHash,
          contentType,
          author: parsed.data.author,
          message: parsed.data.message,
          meta: parsed.data.meta,
          skipIfUnchanged: parsed.data.skipIfUnchanged,
        }),
      ),
    );
    const replayed = replay(stash, key, requestHash);
    if (replayed !== undefined) return replayed;
    const file = getFile(stash, path);
    if (parsed.data.expectedVersion === null) {
      if (file !== undefined) {
        return fail("exists", "File already exists", current(file, getHeadVersion(file)));
      }
    } else if (file === undefined) {
      return fail("not-found", "File not found");
    } else if (file.headVersion !== parsed.data.expectedVersion) {
      return fail("stale", "Expected version is stale", current(file, getHeadVersion(file)));
    }
    if (
      parsed.data.skipIfUnchanged &&
      file !== undefined &&
      !file.deleted &&
      file.headHash === bodyHash
    ) {
      return json({ unchanged: true, version: file.headVersion });
    }
    const size = utf8ByteLength(parsed.data.body);
    const blobRows = nested(state.blobs, stash);
    const version = append(stash, path, {
      kind: "put",
      hash: bodyHash,
      size,
      contentType,
      rollbackOf: null,
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? "",
      meta: cloneMeta(parsed.data.meta),
    });
    if (!blobRows.has(bodyHash)) {
      const blob: FakeBlobRow = {
        stash,
        hash: bodyHash,
        body: parsed.data.body,
        size,
        createdAt: version.createdAt,
      };
      blobRows.set(bodyHash, blob);
    }
    ledger(stash, key, requestHash, version, 201);
    return json(
      {
        version: version.version,
        hash: bodyHash,
        size: version.size,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
      },
      201,
    );
  };

  const handleDelete = async (request: Request, stash: string, path: string): Promise<Response> => {
    requireStash(stash);
    const key = idempotencyKey(request);
    const parsed = DeleteFileBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid delete input.");
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("delete", {
          path,
          expectedVersion: parsed.data.expectedVersion,
          author: parsed.data.author,
          message: parsed.data.message,
        }),
      ),
    );
    const replayed = replay(stash, key, requestHash);
    if (replayed !== undefined) return replayed;
    const file = getFile(stash, path);
    if (file === undefined) return fail("not-found", "File not found");
    const head = getHeadVersion(file);
    if (file.headVersion !== parsed.data.expectedVersion) {
      return fail("stale", "Expected version is stale", current(file, head));
    }
    if (file.deleted)
      return fail("already-deleted", "File is already deleted", current(file, head));
    const version = append(stash, path, {
      kind: "delete",
      hash: null,
      size: 0,
      contentType: DEFAULT_CONTENT_TYPE,
      rollbackOf: null,
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? "",
      meta: {},
    });
    ledger(stash, key, requestHash, version, 200);
    return json(
      { version: version.version, changeId: version.changeId, createdAt: iso(version.createdAt) },
      200,
    );
  };

  const handleRollback = async (
    request: Request,
    stash: string,
    path: string,
  ): Promise<Response> => {
    requireStash(stash);
    const key = idempotencyKey(request);
    const parsed = RollbackBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid rollback input.");
    const requestHash = await sha256Hex(
      canonicalJson(
        requestHashInput("rollback", {
          path,
          expectedVersion: parsed.data.expectedVersion,
          toVersion: parsed.data.toVersion,
          author: parsed.data.author,
          message: parsed.data.message,
          meta: parsed.data.meta,
        }),
      ),
    );
    const replayed = replay(stash, key, requestHash);
    if (replayed !== undefined) return replayed;
    const file = getFile(stash, path);
    if (file === undefined) return fail("not-found", "File not found");
    const head = getHeadVersion(file);
    if (file.headVersion !== parsed.data.expectedVersion) {
      return fail("stale", "Expected version is stale", current(file, head));
    }
    const target = getVersion(stash, path, parsed.data.toVersion);
    if (target === undefined) return fail("version-not-found", "Version not found");
    if (target.hash === null) {
      return fail("rollback-target-tombstone", "Cannot rollback to a tombstone");
    }
    const version = append(stash, path, {
      kind: "rollback",
      hash: target.hash,
      size: target.size,
      contentType: target.contentType,
      rollbackOf: target.version,
      author: parsed.data.author ?? "",
      message:
        parsed.data.message === undefined || parsed.data.message === ""
          ? `Rollback to v${target.version}`
          : parsed.data.message,
      meta: cloneMeta(parsed.data.meta),
    });
    ledger(stash, key, requestHash, version, 201);
    return json(
      {
        version: version.version,
        hash: target.hash,
        rollbackOf: target.version,
        identicalToHead: target.hash === head.hash,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
      },
      201,
    );
  };

  const handleHistory = (stash: string, path: string, url: URL): Response => {
    const parsed = HistoryQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid history query.");
    const file = getFile(stash, path);
    if (file === undefined) return fail("not-found", "File not found.");
    const all = versionsFor(stash, path).sort((left, right) => right.version - left.version);
    const candidates = all.filter(
      (version) => parsed.data.before === undefined || version.version < parsed.data.before,
    );
    const hasMore = candidates.length > parsed.data.limit;
    const page = candidates.slice(0, parsed.data.limit);
    return json({
      path,
      headVersion: file.headVersion,
      deleted: file.deleted,
      total: all.length,
      versions: page.map((version) => ({
        version: version.version,
        kind: version.kind,
        hash: version.hash,
        size: version.size,
        rollbackOf: version.rollbackOf,
        author: version.author,
        message: version.message,
        meta: cloneMeta(version.meta),
        createdAt: iso(version.createdAt),
      })),
      nextBefore: hasMore ? (page.at(-1)?.version ?? null) : null,
    });
  };

  const resolveDiffSide = (
    stash: string,
    path: string,
    requested: number | "head",
  ): { row: FakeVersionRow; side: DiffSide } => {
    const file = getFile(stash, path);
    if (file === undefined) return fail("not-found", "The requested file was not found.");
    const version = getVersion(stash, path, requested === "head" ? file.headVersion : requested);
    if (version === undefined) {
      return fail("version-not-found", "The requested file version was not found.");
    }
    return {
      row: version,
      side: { version: version.version, hash: version.hash, deleted: version.kind === "delete" },
    };
  };

  const handleGetDiff = (stash: string, path: string, url: URL): Response => {
    const parsed = DiffQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid diff query.");
    ensureSafeInteger(parsed.data.from, "from");
    if (parsed.data.to !== "head") ensureSafeInteger(parsed.data.to, "to");
    ensureSafeInteger(parsed.data.context, "context");
    ensureSafeInteger(parsed.data.maxUnifiedBytes, "maxUnifiedBytes");
    if (parsed.data.context !== undefined && parsed.data.context > MAX_DIFF_CONTEXT) {
      return fail("validation", `context must be at most ${MAX_DIFF_CONTEXT}.`);
    }
    const from = resolveDiffSide(stash, path, parsed.data.from);
    const to = resolveDiffSide(stash, path, parsed.data.to);
    if (from.side.hash === to.side.hash) {
      return json({ state: "same", from: from.side, to: to.side });
    }
    return json({
      ...computeDiff({
        fromText: from.side.deleted ? "" : bodyFor(from.row),
        toText: to.side.deleted ? "" : bodyFor(to.row),
        fromLabel: `a/${path}@v${from.row.version}`,
        toLabel: `b/${path}@v${to.row.version}`,
        context: parsed.data.context,
        maxUnifiedBytes: parsed.data.maxUnifiedBytes,
      }),
      from: from.side,
      to: to.side,
    });
  };

  const handleCandidateDiff = async (
    request: Request,
    stash: string,
    path: string,
  ): Promise<Response> => {
    const candidate = await requestJson(request);
    const parsed = DiffCandidateBody.safeParse(candidate);
    if (!parsed.success) {
      if (typeof candidate === "object" && candidate !== null && "body" in candidate) {
        const body = candidate.body;
        if (typeof body === "string" && !isWellFormedString(body)) {
          return fail("body-not-well-formed", "Body is not well-formed Unicode.");
        }
        if (typeof body === "string" && utf8ByteLength(body) > MAX_BODY_BYTES) {
          return fail("payload-too-large", "Body is too large.");
        }
      }
      return fail("validation", "Invalid candidate diff input.");
    }
    if (parsed.data.from !== "head") ensureSafeInteger(parsed.data.from, "from");
    ensureSafeInteger(parsed.data.context, "context");
    if (parsed.data.context !== undefined && parsed.data.context > MAX_DIFF_CONTEXT) {
      return fail("validation", `context must be at most ${MAX_DIFF_CONTEXT}.`);
    }
    const from = resolveDiffSide(stash, path, parsed.data.from);
    return json(
      computeDiff({
        fromText: from.side.deleted ? "" : bodyFor(from.row),
        toText: parsed.data.body,
        fromLabel: `a/${path}@v${from.row.version}`,
        toLabel: `b/${path}@candidate`,
        context: parsed.data.context,
      }),
    );
  };

  const handleChanges = (stash: string, url: URL): Response => {
    const parsed = ChangesQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid changes query.");
    const rows = state.versions.filter(
      (row) =>
        row.stash === stash &&
        (parsed.data.since === undefined || row.changeId > parsed.data.since) &&
        (parsed.data.before === undefined || row.changeId < parsed.data.before),
    );
    return json(changesPage(rows, parsed.data.since, parsed.data.limit));
  };

  const fetch: StashFetch = async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      return errorResponse(new FakeHttpError("validation", "Invalid request."));
    }
    try {
      const match = routeMatch(request);
      if (match === undefined || !SUPPORTED_ROUTE_IDS.has(match.routeId)) return unsupported();
      const principal = await authenticate(request);
      authorize(principal, match);
      const url = new URL(request.url);
      const stash = match.stash;
      const path = match.path === undefined ? undefined : requirePath(match.path);
      switch (match.routeId) {
        case "me":
          return json(
            principal.kind === "admin"
              ? { principal: "admin" }
              : {
                  principal: "stash",
                  stash: principal.stash,
                  tokenId: principal.tokenId,
                  scope: principal.scope,
                  expiresAt: principal.expiresAt === null ? null : iso(principal.expiresAt),
                },
          );
        case "listStashes":
          return handleListStashes(url);
        case "createStash":
          return await handleCreateStash(request);
        case "getStash":
          return handleGetStash(stash ?? "");
        case "createToken":
          return await handleCreateToken(request, stash ?? "");
        case "listTokens":
          return handleListTokens(stash ?? "");
        case "revokeToken":
          return handleRevokeToken(stash ?? "", match.tokenId ?? "");
        case "listFiles":
          return handleListFiles(stash ?? "", url);
        case "getFile":
          return handleGetFile(request, stash ?? "", path ?? "", url);
        case "putFile":
          return await handlePut(request, stash ?? "", path ?? "");
        case "deleteFile":
          return await handleDelete(request, stash ?? "", path ?? "");
        case "rollbackFile":
          return await handleRollback(request, stash ?? "", path ?? "");
        case "getHistory":
          return handleHistory(stash ?? "", path ?? "", url);
        case "getDiff":
          return handleGetDiff(stash ?? "", path ?? "", url);
        case "diffCandidate":
          return await handleCandidateDiff(request, stash ?? "", path ?? "");
        case "getStashChanges":
          return handleChanges(stash ?? "", url);
        default:
          return unsupported();
      }
    } catch (error) {
      if (error instanceof FakeHttpError) return errorResponse(error);
      return errorResponse(new FakeHttpError("internal", "An internal error occurred."));
    }
  };

  return {
    fetch,
    state,
    createStash(name) {
      return createStashRow(name).name;
    },
    async mintToken(stash, scope) {
      if (scope !== "read" && scope !== "write") {
        throw new TypeError("scope must be read or write");
      }
      return (await mintStoredToken(stash, scope, "")).token;
    },
    reset() {
      state.stashes.clear();
      state.tokens.clear();
      state.blobs.clear();
      state.files.clear();
      state.versions.length = 0;
      state.idempotency.clear();
      nextToken = 1;
      nextChangeId = 1;
    },
  };
}

/** The exact route subset modelled by the fake, exported for coverage assertions. */
export const FAKE_SUPPORTED_ROUTE_IDS = [...SUPPORTED_ROUTE_IDS] as readonly RouteId[];
