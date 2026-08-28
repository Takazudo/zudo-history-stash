import {
  ApproveProposalBody,
  BODY_LIMIT_BYTES,
  ChangesQuery,
  CreateProposalBody,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  DiffCandidateBody,
  DiffQuery,
  EventsQuery,
  FileGetQuery,
  ListGcRunsQuery,
  HistoryQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListProposalsQuery,
  ListFilesQuery,
  ListStashesQuery,
  MAX_BODY_BYTES,
  MAX_META_BYTES,
  ProposalDiffQuery,
  PutFileBody,
  R2_SPILL_BYTES,
  ROUTES,
  RotateTokenBody,
  RejectProposalBody,
  RollbackBody,
  RunGcBody,
  STASH_CLIENT_ID_HEADER,
  StashEventSchema,
  canonicalJson,
  computeDiff,
  formatEtag,
  ifNoneMatchMatches,
  isStashClientId,
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
  GcKind,
  JsonValue,
  ReconnectReason,
  RouteId,
  StashEvent,
  TokenScope,
} from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../client.js";
import type {
  FakeBlobRow,
  FakeFileRow,
  FakeGcJobRow,
  FakeIdempotencyRow,
  FakeMintTokenOptions,
  FakeProposalRow,
  FakeR2ObjectRow,
  FakeRateLimitInput,
  FakeStash,
  FakeStashEvents,
  FakeStashOptions,
  FakeStashRow,
  FakeStashState,
  FakeTokenRow,
  FakeVersionRow,
} from "./types.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";
const MAX_DIFF_CONTEXT = 10;
const LAST_USED_INTERVAL_MS = 60_000;
const MAX_TOKEN_TTL_MS = 315_360_000 * 1_000;
const DEFAULT_DELETE_GRACE_DAYS = 30;
const DEFAULT_GC_ORPHAN_MIN_AGE_MS = 900_000;
const DEFAULT_PROPOSAL_TTL_DAYS = 14;
const GC_LEASE_TTL_MS = 300_000;
const MAX_R2_GC_PAGE_OBJECTS = 24;
const SHA256_HASH = /^sha256-[0-9a-f]{64}$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

const SUPPORTED_ROUTE_IDS = new Set<RouteId>([
  "me",
  "listStashes",
  "createStash",
  "getStash",
  "deleteStash",
  "restoreStash",
  "createToken",
  "listTokens",
  "rotateToken",
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
  "runGc",
  "listGcRuns",
  "createProposal",
  "listProposals",
  "getProposal",
  "getProposalDiff",
  "approveProposal",
  "rejectProposal",
  "stashEvents",
]);

const LIVE_STASH_ROUTE_IDS = new Set<RouteId>([
  "createToken",
  "listTokens",
  "rotateToken",
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
  "createProposal",
  "listProposals",
  "getProposal",
  "getProposalDiff",
  "approveProposal",
  "rejectProposal",
  "stashEvents",
]);

const RATE_LIMIT_CAPABILITY_BY_ROUTE = {
  health: null,
  getCapabilities: null,
  me: "read",
  listStashes: null,
  createStash: null,
  getStash: "read",
  deleteStash: "write",
  restoreStash: "write",
  createToken: null,
  listTokens: null,
  rotateToken: null,
  revokeToken: null,
  importHistory: null,
  listChanges: null,
  runGc: "write",
  listGcRuns: "read",
  createProposal: "write",
  listProposals: "read",
  getProposal: "read",
  getProposalDiff: "diff",
  approveProposal: "write",
  rejectProposal: "write",
  stashEvents: "read",
  listFiles: "read",
  getFile: "read",
  putFile: "write",
  deleteFile: "write",
  rollbackFile: "write",
  getHistory: "read",
  getDiff: "diff",
  diffCandidate: "diff",
  getStashChanges: "read",
  getRawFile: "read",
  headRawFile: "read",
  getRawVersion: "read",
  headRawVersion: "read",
  createUploadSession: "write",
  getUploadSession: "write",
  uploadSingleContent: "write",
  uploadPart: "write",
  completeUploadSession: "write",
  resumeUploadSession: "write",
  abortUploadSession: "write",
} as const satisfies Record<RouteId, "read" | "write" | "diff" | null>;

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
  proposalId?: string;
}

class FakeHttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: Current;
  readonly successorId?: string;

  constructor(code: ErrorCode, message: string, current?: Current, successorId?: string) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
    this.current = current;
    this.successorId = successorId;
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
      error: {
        code: error.code,
        message: error.message,
        ...(error.successorId === undefined ? {} : { successorId: error.successorId }),
      },
      ...(error.status === 409 && error.current !== undefined ? { current: error.current } : {}),
    },
    error.status,
  );
}

function fail(code: ErrorCode, message: string, current?: Current): never {
  throw new FakeHttpError(code, message, current);
}

function rotationRefusal(code: "already-rotated", message: string, successorId: string): never {
  throw new FakeHttpError(code, message, undefined, successorId);
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

  if (method === "POST" && pathname === "/v1/admin/gc") return { routeId: "runGc" };
  if (method === "GET" && pathname === "/v1/admin/gc/runs") return { routeId: "listGcRuns" };

  let match = /^\/v1\/stashes\/([^/]+)\/events$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "stashEvents", stash: decode(match[1]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/proposals\/([^/]+)\/diff$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined && match[2] !== undefined) {
    return {
      routeId: "getProposalDiff",
      stash: decode(match[1]),
      proposalId: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/proposals\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (method === "POST" && match?.[1] !== undefined && match[2] !== undefined) {
    return {
      routeId: match[3] === "approve" ? "approveProposal" : "rejectProposal",
      stash: decode(match[1]),
      proposalId: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/proposals\/([^/]+)$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined && match[2] !== undefined) {
    return {
      routeId: "getProposal",
      stash: decode(match[1]),
      proposalId: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/proposals$/.exec(pathname);
  if ((method === "GET" || method === "POST") && match?.[1] !== undefined) {
    return {
      routeId: method === "GET" ? "listProposals" : "createProposal",
      stash: decode(match[1]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/tokens\/([^/]+)\/rotate$/.exec(pathname);
  if (method === "POST" && match?.[1] !== undefined && match[2] !== undefined) {
    return {
      routeId: "rotateToken",
      stash: decode(match[1]),
      tokenId: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/tokens\/([^/]+)$/.exec(pathname);
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
  if (method === "DELETE" && match?.[1] !== undefined) {
    return { routeId: "deleteStash", stash: decode(match[1]) };
  }
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "getStash", stash: decode(match[1]) };
  }

  match = /^\/v1\/stashes\/([^/]+)\/restore$/.exec(pathname);
  if (method === "POST" && match?.[1] !== undefined) {
    return { routeId: "restoreStash", stash: decode(match[1]) };
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

  match = /^\/v1\/stashes\/([^/]+)\/diff(?:\/(.*))?$/.exec(pathname);
  if ((method === "GET" || method === "POST") && match?.[1] !== undefined) {
    return {
      routeId: method === "GET" ? "getDiff" : "diffCandidate",
      stash: decode(match[1]),
      path: decode(match[2] ?? ""),
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

function parseIsoDateTime(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (match === null) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  const date = new Date(parsed);
  const expectedMilliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== expectedMilliseconds
  ) {
    return undefined;
  }
  return parsed;
}

function resolveTokenExpiry(input: FakeMintTokenOptions, now: number): number | null {
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
    return fail(
      "validation",
      "Token expiry must be in the future and no more than ten years away.",
    );
  }
  return expiresAt;
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
  const limiter = options.rateLimit ?? (() => ({ success: true }));
  const deleteGraceDays = options.deleteGraceDays ?? DEFAULT_DELETE_GRACE_DAYS;
  const gcOrphanMinAgeMs = options.gcOrphanMinAgeMs ?? DEFAULT_GC_ORPHAN_MIN_AGE_MS;
  const proposalTtlDays = options.proposalTtlDays ?? DEFAULT_PROPOSAL_TTL_DAYS;
  if (!Number.isSafeInteger(deleteGraceDays) || deleteGraceDays < 1) {
    throw new TypeError("deleteGraceDays must be a positive safe integer");
  }
  if (!Number.isSafeInteger(gcOrphanMinAgeMs) || gcOrphanMinAgeMs < 0) {
    throw new TypeError("gcOrphanMinAgeMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(proposalTtlDays) || proposalTtlDays < 1) {
    throw new TypeError("proposalTtlDays must be a positive safe integer");
  }
  const state: FakeStashState = {
    stashes: new Map(),
    tokens: new Map(),
    blobs: new Map(),
    r2Objects: new Map(),
    files: new Map(),
    versions: [],
    proposals: new Map(),
    idempotency: new Map(),
    gcJobs: new Map<GcKind, FakeGcJobRow>([
      [
        "r2-orphans",
        {
          kind: "r2-orphans",
          nextCursor: null,
          leaseOwner: null,
          leaseGeneration: 0,
          leaseUntil: null,
          updatedAt: 0,
        },
      ],
      [
        "ledger",
        {
          kind: "ledger",
          nextCursor: null,
          leaseOwner: null,
          leaseGeneration: 0,
          leaseUntil: null,
          updatedAt: 0,
        },
      ],
    ]),
    gcRuns: [],
  };
  let nextToken = 1;
  let nextChangeId = 1;
  let nextR2ObjectSerial = 1;
  let nextProposalSerial = 1;
  let nextGcRun = 1;
  let nextGcCursorSerial = 1;
  const gcCursorPositions = new Map<string, { kind: GcKind; afterKey: string }>();

  interface EventSubscriber {
    stash: string;
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal: AbortSignal;
    abort: () => void;
    closed: boolean;
  }

  const eventEncoder = new TextEncoder();
  const eventSubscribers = new Map<string, Set<EventSubscriber>>();

  const encodeEvent = (event: StashEvent): Uint8Array => {
    const validated = StashEventSchema.parse(event);
    const id = validated.type === "change" ? `id: ${validated.changeId}\n` : "";
    return eventEncoder.encode(
      `event: ${validated.type}\n${id}data: ${JSON.stringify(validated)}\n\n`,
    );
  };

  const forgetSubscriber = (subscriber: EventSubscriber): void => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.signal.removeEventListener("abort", subscriber.abort);
    const subscribers = eventSubscribers.get(subscriber.stash);
    subscribers?.delete(subscriber);
    if (subscribers?.size === 0) eventSubscribers.delete(subscriber.stash);
  };

  const finishSubscriber = (subscriber: EventSubscriber, error?: unknown): void => {
    if (subscriber.closed) return;
    forgetSubscriber(subscriber);
    try {
      if (error === undefined) subscriber.controller.close();
      else subscriber.controller.error(error);
    } catch {
      // Cancellation can race fixture-driven closure or failure.
    }
  };

  const broadcastEvent = (stash: string, event: StashEvent): void => {
    const bytes = encodeEvent(event);
    for (const subscriber of [...(eventSubscribers.get(stash) ?? [])]) {
      if (subscriber.closed) continue;
      try {
        subscriber.controller.enqueue(bytes);
      } catch {
        forgetSubscriber(subscriber);
      }
    }
  };

  const closeSubscribers = (stash: string, error?: unknown): void => {
    for (const subscriber of [...(eventSubscribers.get(stash) ?? [])]) {
      finishSubscriber(subscriber, error);
    }
  };

  const events: FakeStashEvents = {
    emit(stashOrEvent: string | StashEvent, suppliedEvent?: StashEvent) {
      const event = typeof stashOrEvent === "string" ? suppliedEvent : stashOrEvent;
      const stash =
        typeof stashOrEvent === "string"
          ? stashOrEvent
          : stashOrEvent.type === "change" || stashOrEvent.type === "proposal"
            ? stashOrEvent.stash
            : undefined;
      if (stash === undefined || event === undefined) {
        throw new TypeError("ready and reconnect fixtures require an explicit stash");
      }
      broadcastEvent(stash, event);
    },
    rotate(stash, reason: ReconnectReason = "lifetime") {
      const event = { type: "reconnect" as const, reason };
      broadcastEvent(stash, event);
      closeSubscribers(stash);
    },
    close: closeSubscribers,
    error(stash, error = new TypeError("Simulated fake event stream failure")) {
      closeSubscribers(stash, error);
    },
    subscriberCount(stash) {
      return eventSubscribers.get(stash)?.size ?? 0;
    },
  };

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

  const changeEvent = (version: FakeVersionRow, origin: string | null): StashEvent => ({
    type: "change",
    changeId: version.changeId,
    stash: version.stash,
    path: version.path,
    version: version.version,
    kind: version.kind,
    origin,
    createdAt: iso(version.createdAt),
  });

  const requestOrigin = (request: Request): string | null => {
    const clientId = request.headers.get(STASH_CLIENT_ID_HEADER);
    return isStashClientId(clientId) ? clientId : null;
  };
  const bodyFor = (version: FakeVersionRow): string => {
    if (version.hash === null) return "";
    const body = state.blobs.get(version.stash)?.get(version.hash)?.body;
    if (body === undefined) return fail("internal", "The fake version points at a missing blob.");
    return body;
  };
  const storeBlob = (stash: string, hash: string, body: string, createdAt: number): FakeBlobRow => {
    const rows = nested(state.blobs, stash);
    const existing = rows.get(hash);
    if (existing !== undefined) return existing;
    const size = utf8ByteLength(body);
    let r2Key: string | null = null;
    if (size > R2_SPILL_BYTES) {
      const generation = `00000000-0000-4000-8000-${String(nextR2ObjectSerial).padStart(12, "0")}`;
      r2Key = `v2/${stash}/${hash}/${generation}`;
      nextR2ObjectSerial += 1;
      state.r2Objects.set(r2Key, { key: r2Key, stash, hash, size, createdAt });
    }
    const row: FakeBlobRow = { stash, hash, body, r2Key, size, createdAt };
    rows.set(hash, row);
    return row;
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

  const requireLiveStash = (stash: string): FakeStashRow => {
    const row = requireAdminStash(stash);
    if (row.deletedAt !== null) {
      return fail("not-found", "The requested resource was not found.");
    }
    return row;
  };

  const stashRecord = (row: FakeStashRow) => {
    const files = [...(state.files.get(row.name)?.values() ?? [])];
    const versions = state.versions.filter((version) => version.stash === row.name);
    const last = versions.reduce<FakeVersionRow | undefined>(
      (latest, version) =>
        latest === undefined || version.changeId > latest.changeId ? version : latest,
      undefined,
    );
    const deletedAt = row.deletedAt;
    const restoreUntilMs = deletedAt === null ? null : deletedAt + deleteGraceDays * 86_400_000;
    return {
      name: row.name,
      description: row.description,
      meta: cloneMeta(row.meta),
      fileCount: files.filter((file) => !file.deleted).length,
      deletedFileCount: files.filter((file) => file.deleted).length,
      lastChangeId: last?.changeId ?? null,
      lastChangeAt: last === undefined ? null : iso(last.createdAt),
      createdAt: iso(row.createdAt),
      deletedAt: deletedAt === null ? null : iso(deletedAt),
      restoreUntil: restoreUntilMs === null ? null : iso(restoreUntilMs),
      restorable: restoreUntilMs !== null && now() < restoreUntilMs,
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
    const row = {
      name,
      description,
      meta: cloneMeta(meta),
      createdAt: now(),
      deletedAt: null,
    };
    state.stashes.set(name, row);
    return row;
  };

  const prepareStoredToken = async (
    stash: string,
    scope: TokenScope,
    label: string,
    createdAt: number,
    expiresAt: number | null,
    rotatedFrom: string | null,
  ): Promise<{ row: FakeTokenRow; token: string }> => {
    requireLiveStash(stash);
    const serial = nextToken;
    nextToken += 1;
    const tokenSerial = serial.toString(36).padStart(43, "0");
    const idSerial = serial.toString(16).padStart(32, "0");
    const token = `zhs_${tokenSerial}`;
    const row: FakeTokenRow = {
      id: `tok_${idSerial}`,
      tokenHash: (await sha256Hex(token)).slice("sha256-".length),
      stash,
      label,
      scope,
      createdAt,
      expiresAt,
      rotatedFrom,
      rotatedTo: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    return { row, token };
  };

  const mintStoredToken = async (
    stash: string,
    scope: TokenScope,
    options: FakeMintTokenOptions = {},
  ): Promise<{ row: FakeTokenRow; token: string }> => {
    const createdAt = now();
    const expiresAt = resolveTokenExpiry(options, createdAt);
    const created = await prepareStoredToken(
      stash,
      scope,
      options.label ?? "",
      createdAt,
      expiresAt,
      null,
    );
    state.tokens.set(created.row.id, created.row);
    return created;
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
    const usedAt = now();
    const row = [...state.tokens.values()].find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.revokedAt === null &&
        (candidate.expiresAt === null || candidate.expiresAt > usedAt),
    );
    if (row === undefined) return fail("unauthorized", "A valid bearer token is required.");
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

  const applyRateLimit = async (
    principal: Principal,
    routeId: RouteId,
  ): Promise<Response | undefined> => {
    const capability = RATE_LIMIT_CAPABILITY_BY_ROUTE[routeId];
    if (principal.kind === "admin" || capability === null) return undefined;

    const limited = async (key: string): Promise<boolean | undefined> => {
      const input: FakeRateLimitInput = { capability, key, routeId };
      try {
        return !(await limiter(input)).success;
      } catch {
        return undefined;
      }
    };

    const principalLimited = await limited(`p:${principal.tokenId}`);
    if (principalLimited === undefined) return undefined;
    if (principalLimited) {
      return json(
        { error: { code: "rate-limited", message: "The request was rate limited." } },
        429,
        { "Retry-After": "60" },
      );
    }

    const stashLimited = await limited(`s:${principal.stash}`);
    if (stashLimited) {
      return json(
        { error: { code: "rate-limited", message: "The request was rate limited." } },
        429,
        { "Retry-After": "60" },
      );
    }
    return undefined;
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

  const handleEvents = (request: Request, stash: string, url: URL): Response => {
    const parsed = EventsQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid events query.");
    const versions = state.versions
      .filter((version) => version.stash === stash)
      .sort((left, right) => left.changeId - right.changeId);
    const head = versions.at(-1)?.changeId ?? null;
    const replayed =
      parsed.data.since === undefined
        ? []
        : versions.filter((version) => version.changeId > (parsed.data.since ?? 0));
    const checkpoint =
      replayed.at(-1)?.changeId ?? (parsed.data.since === undefined ? head : parsed.data.since);
    let subscriber: EventSubscriber | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          if (subscriber !== undefined) finishSubscriber(subscriber);
        };
        subscriber = {
          stash,
          controller,
          signal: request.signal,
          abort,
          closed: false,
        };
        if (request.signal.aborted) {
          finishSubscriber(subscriber);
          return;
        }
        let subscribers = eventSubscribers.get(stash);
        if (subscribers === undefined) {
          subscribers = new Set();
          eventSubscribers.set(stash, subscribers);
        }
        subscribers.add(subscriber);
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          for (const version of replayed)
            controller.enqueue(encodeEvent(changeEvent(version, null)));
          controller.enqueue(encodeEvent({ type: "ready", head, checkpoint }));
        } catch {
          forgetSubscriber(subscriber);
        }
      },
      cancel() {
        if (subscriber !== undefined) forgetSubscriber(subscriber);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  };

  const append = (
    stash: string,
    path: string,
    input: Omit<FakeVersionRow, "changeId" | "stash" | "path" | "version" | "createdAt">,
    appendOptions: { createdAt?: number; origin?: string | null } = {},
  ): FakeVersionRow => {
    const createdAt = appendOptions.createdAt ?? now();
    const file = getFile(stash, path);
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
    broadcastEvent(stash, changeEvent(row, appendOptions.origin ?? null));
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
    const parsed = ListStashesQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid stash list query.");
    const candidates = [...state.stashes.values()]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .filter((row) => parsed.data.includeDeleted || row.deletedAt === null)
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

  const handleDeleteStash = (stash: string): Response => {
    const row = requireAdminStash(stash);
    if (row.deletedAt !== null) {
      return fail("already-deleted", "Stash is already deleted.");
    }
    const deletedAt = now();
    let revokedTokens = 0;
    for (const token of state.tokens.values()) {
      if (token.stash !== stash || token.revokedAt !== null) continue;
      token.revokedAt = deletedAt;
      revokedTokens += 1;
    }
    row.deletedAt = deletedAt;
    const restoreUntil = deletedAt + deleteGraceDays * 86_400_000;
    return json({
      name: row.name,
      deletedAt: iso(deletedAt),
      revokedTokens,
      restoreUntil: iso(restoreUntil),
    });
  };

  const handleRestoreStash = (stash: string): Response => {
    const row = requireAdminStash(stash);
    const deletedAt = row.deletedAt;
    if (deletedAt === null) return fail("not-found", "The requested resource was not found.");
    const restoreUntil = deletedAt + deleteGraceDays * 86_400_000;
    if (now() >= restoreUntil) return fail("not-found", "The requested resource was not found.");
    row.deletedAt = null;
    return json(stashRecord(row));
  };

  const nextGcRunId = (): string =>
    `00000000-0000-4000-8000-${String(nextGcRun++).padStart(12, "0")}`;

  const nextGcCursor = (kind: GcKind, afterKey: string): string => {
    const cursor = `fake-gc-cursor-${String(nextGcCursorSerial).padStart(8, "0")}`;
    nextGcCursorSerial += 1;
    gcCursorPositions.set(cursor, { kind, afterKey });
    return cursor;
  };

  const gcJob = (kind: GcKind): FakeGcJobRow => {
    const job = state.gcJobs.get(kind);
    if (job === undefined) return fail("internal", "The fake GC job registry is incomplete.");
    return job;
  };

  type OrphanCandidate = FakeR2ObjectRow & { accepted: boolean; referenced: boolean };
  type LedgerCandidate = { key: string; row: FakeIdempotencyRow };

  const parseAcceptedR2Key = (key: string): { stash: string; hash: string } | null => {
    const segments = key.split("/");
    const legacy = segments.length === 2;
    const v2 = segments.length === 4 && segments[0] === "v2";
    if (!legacy && !v2) return null;
    const stash = segments[legacy ? 0 : 1];
    const hash = segments[legacy ? 1 : 2];
    if (stash === undefined || hash === undefined || !validateStashName(stash).ok) return null;
    if (!SHA256_HASH.test(hash)) return null;
    if (!legacy && (segments[3] === undefined || !LOWERCASE_UUID.test(segments[3]))) return null;
    return { stash, hash };
  };

  const orphanCandidates = (): OrphanCandidate[] => {
    // A version points to a logical blob by hash, but only the blob row's exact immutable
    // generation is live in R2. A later upload of the same hash therefore remains collectible.
    const referenced = new Set(
      [...state.blobs.values()]
        .flatMap((rows) => [...rows.values()])
        .map((blob) => blob.r2Key)
        .filter((key): key is string => key !== null),
    );
    return [...state.r2Objects.values()]
      .map((row) => {
        const parsed = parseAcceptedR2Key(row.key);
        return {
          ...row,
          accepted: parsed !== null,
          referenced: parsed !== null && referenced.has(row.key),
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
  };

  const ledgerCandidates = (): LedgerCandidate[] =>
    [...state.idempotency.entries()]
      .flatMap(([stash, rows]) =>
        [...rows.entries()].map(([key, row]) => ({ key: `${stash}\u0000${key}`, row })),
      )
      .sort((left, right) => left.key.localeCompare(right.key));

  const compareGcRuns = (left: { startedAt: string; runId: string }, right: typeof left) =>
    right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId);

  const pruneGcRuns = (kind: GcKind): void => {
    const forKind = state.gcRuns.filter((run) => run.kind === kind);
    if (forKind.length <= 500) return;
    const keep = new Set(forKind.sort(compareGcRuns).slice(0, 500));
    for (let index = state.gcRuns.length - 1; index >= 0; index -= 1) {
      const run = state.gcRuns[index];
      if (run !== undefined && run.kind === kind && !keep.has(run)) state.gcRuns.splice(index, 1);
    }
  };

  const pageStart = <T extends { key: string }>(
    candidates: readonly T[],
    cursor: string | undefined,
    kind: GcKind,
  ): number => {
    if (cursor === undefined) return 0;
    const position = gcCursorPositions.get(cursor);
    if (position === undefined) return fail("validation", "Invalid GC cursor.");
    if (position.kind !== kind) return fail("validation", "GC cursor kind does not match the job.");
    const start = candidates.findIndex((candidate) => candidate.key > position.afterKey);
    return start === -1 ? candidates.length : start;
  };

  const validateGcCursor = (cursor: string | undefined, kind: GcKind): void => {
    if (cursor === undefined) return;
    const position = gcCursorPositions.get(cursor);
    if (position === undefined) return fail("validation", "Invalid GC cursor.");
    if (position.kind !== kind) return fail("validation", "GC cursor kind does not match the job.");
  };

  const handleRunGc = async (request: Request): Promise<Response> => {
    const parsed = RunGcBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid garbage-collection input.");
    const { kind, dryRun, maxObjects, cursor: explicitCursor } = parsed.data;
    const job = gcJob(kind);
    const inputCursor = explicitCursor ?? job.nextCursor ?? undefined;
    validateGcCursor(inputCursor, kind);
    const startedAt = now();
    if (job.leaseUntil !== null && job.leaseUntil > startedAt) {
      return fail("gc-busy", "A garbage-collection run is already in progress.");
    }
    const runId = nextGcRunId();
    job.leaseOwner = runId;
    job.leaseGeneration += 1;
    job.leaseUntil = startedAt + GC_LEASE_TTL_MS;
    job.updatedAt = startedAt;

    const run = {
      runId,
      jobId: kind,
      kind,
      dryRun,
      scanned: 0,
      eligible: 0,
      deleted: 0,
      cursor: null as string | null,
      startedAt: iso(startedAt),
      finishedAt: null as string | null,
      error: null as string | null,
    };
    state.gcRuns.push(run);

    if (kind === "r2-orphans") {
      const candidates = orphanCandidates();
      const start = pageStart(candidates, inputCursor, kind);
      const page = candidates.slice(start, start + Math.min(maxObjects, MAX_R2_GC_PAGE_OBJECTS));
      run.scanned = page.length;
      const eligible = page.filter(
        (candidate) =>
          candidate.accepted &&
          !candidate.referenced &&
          startedAt - candidate.createdAt > gcOrphanMinAgeMs,
      );
      run.eligible = eligible.length;
      if (!dryRun) {
        for (const candidate of eligible) {
          state.r2Objects.delete(candidate.key);
        }
        run.deleted = eligible.length;
      }
      const last = page.at(-1);
      run.cursor =
        last === undefined || start + page.length >= candidates.length
          ? null
          : nextGcCursor(kind, last.key);
    } else {
      const candidates = ledgerCandidates();
      const start = pageStart(candidates, inputCursor, kind);
      const page = candidates.slice(start, start + maxObjects);
      run.scanned = page.length;
      // The fake has no configured idempotency retention clock; ledger rows are retained.
      run.cursor =
        page.at(-1) === undefined || start + page.length >= candidates.length
          ? null
          : nextGcCursor(kind, page.at(-1)?.key ?? "");
    }

    if (!dryRun) job.nextCursor = run.cursor;
    const finishedAt = now();
    run.finishedAt = iso(finishedAt);
    job.leaseOwner = null;
    job.leaseUntil = null;
    job.updatedAt = finishedAt;
    pruneGcRuns(kind);
    return json(run);
  };

  const handleListGcRuns = (url: URL): Response => {
    const parsed = ListGcRunsQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid garbage-collection run query.");
    pruneGcRuns("r2-orphans");
    pruneGcRuns("ledger");
    const runs = state.gcRuns
      .filter((run) => parsed.data.kind === undefined || run.kind === parsed.data.kind)
      .sort(compareGcRuns)
      .slice(0, parsed.data.limit);
    return json({ runs });
  };

  const handleCreateToken = async (request: Request, stash: string): Promise<Response> => {
    const parsed = CreateTokenBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid token input.");
    const { row, token } = await mintStoredToken(stash, parsed.data.scope, parsed.data);
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

  const requireRotationPredecessor = (
    stash: string,
    id: string,
    requestNow: number,
  ): FakeTokenRow => {
    const name = requireAdminStash(stash).name;
    const row = state.tokens.get(id);
    if (row === undefined || row.stash !== name || row.revokedAt !== null) {
      return fail("not-found", "The requested resource was not found.");
    }
    if (row.rotatedTo !== null) {
      return rotationRefusal("already-rotated", "Token was already rotated.", row.rotatedTo);
    }
    if (row.expiresAt !== null && row.expiresAt <= requestNow) {
      return fail("token-expired", "Token is expired.");
    }
    return row;
  };

  const handleRotateToken = async (
    request: Request,
    stash: string,
    id: string,
  ): Promise<Response> => {
    const parsed = RotateTokenBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid token rotation input.");

    const requestNow = now();
    const predecessor = requireRotationPredecessor(stash, id, requestNow);
    const originalExpiry = predecessor.expiresAt;
    const hasExpiryOverride =
      parsed.data.expiresAt !== undefined || parsed.data.ttlSeconds !== undefined;
    const successorExpiry = hasExpiryOverride
      ? resolveTokenExpiry(parsed.data, requestNow)
      : originalExpiry;
    const graceEnd = requestNow + parsed.data.graceSeconds * 1_000;
    const prepared = await prepareStoredToken(
      predecessor.stash,
      predecessor.scope,
      predecessor.label,
      requestNow,
      successorExpiry,
      predecessor.id,
    );

    // This re-check plus both mutations form one await-free commit section. Concurrent calls can
    // prepare candidates in parallel, but only one can claim rotatedTo and publish a successor.
    const currentPredecessor = requireRotationPredecessor(stash, id, requestNow);
    const predecessorExpiry = Math.min(currentPredecessor.expiresAt ?? graceEnd, graceEnd);
    currentPredecessor.rotatedTo = prepared.row.id;
    currentPredecessor.expiresAt = predecessorExpiry;
    state.tokens.set(prepared.row.id, prepared.row);

    return json(
      {
        id: prepared.row.id,
        token: prepared.token,
        label: prepared.row.label,
        scope: prepared.row.scope,
        createdAt: iso(prepared.row.createdAt),
        expiresAt: prepared.row.expiresAt === null ? null : iso(prepared.row.expiresAt),
        rotatedFrom: prepared.row.rotatedFrom,
        predecessor: {
          id: currentPredecessor.id,
          expiresAt: iso(predecessorExpiry),
        },
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

  const proposalsFor = (stash: string): Map<string, FakeProposalRow> =>
    nested(state.proposals, stash);

  const requireProposal = (stash: string, id: string): FakeProposalRow => {
    const row = state.proposals.get(stash)?.get(id);
    if (row === undefined) return fail("not-found", "The requested proposal was not found.");
    return row;
  };

  const proposalStatus = (row: FakeProposalRow, readAt = now()) =>
    row.status === "open" && row.expiresAt <= readAt ? ("expired" as const) : row.status;

  const proposalRecord = (row: FakeProposalRow, readAt = now()) => ({
    id: row.id,
    stash: row.stash,
    path: row.path,
    baseVersion: row.baseVersion,
    author: row.author,
    message: row.message,
    meta: cloneMeta(row.meta),
    size: row.size,
    hash: row.blobHash,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    status: proposalStatus(row, readAt),
    decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    appliedVersion: row.appliedVersion,
    appliedChangeId: row.appliedChangeId,
  });

  const publishProposal = (
    row: FakeProposalRow,
    status: "open" | "applied" | "rejected",
    origin: string | null,
  ): void => {
    broadcastEvent(row.stash, {
      type: "proposal",
      proposalId: row.id,
      stash: row.stash,
      path: row.path,
      status,
      origin,
    });
  };

  const proposalBody = (row: FakeProposalRow): string => {
    const body = state.blobs.get(row.stash)?.get(row.blobHash)?.body;
    if (body === undefined) return fail("internal", "The fake proposal points at a missing blob.");
    return body;
  };

  const proposalCursor = (row: FakeProposalRow): string => btoa(`${row.createdAt}:${row.id}`);

  const decodeProposalCursor = (cursor: string): { createdAt: number; id: string } => {
    let decoded: string;
    try {
      decoded = atob(cursor);
    } catch {
      return fail("validation", "Invalid proposal cursor.");
    }
    const match = /^(\d+):(prp_(\d{13})[0-9a-f]{8})$/.exec(decoded);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      return fail("validation", "Invalid proposal cursor.");
    }
    const createdAt = Number(match[1]);
    const idCreatedAt = Number(match[3]);
    if (!Number.isSafeInteger(createdAt) || idCreatedAt !== createdAt || btoa(decoded) !== cursor) {
      return fail("validation", "Invalid proposal cursor.");
    }
    return { createdAt, id: match[2] };
  };

  const principalId = (principal: Principal): string =>
    principal.kind === "admin" ? "admin" : principal.tokenId;

  const handleCreateProposal = async (request: Request, stash: string): Promise<Response> => {
    const key = idempotencyKey(request);
    const candidate = await requestJson(request);
    const candidateRecord =
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : undefined;
    if (candidateRecord !== undefined && "body" in candidateRecord) {
      const body = candidateRecord.body;
      if (typeof body === "string" && !isWellFormedString(body)) {
        return fail("body-not-well-formed", "Body is not well-formed Unicode.");
      }
      if (typeof body === "string" && utf8ByteLength(body) > MAX_BODY_BYTES) {
        return fail("payload-too-large", "The proposal body is too large.");
      }
    }

    // The core schema validates expiry against wall-clock Date.now(). The fake has an injected
    // clock, so retain all structural schema checks with a temporary future value and enforce
    // the actual supplied boundary against the fake clock below.
    const suppliedExpiresAt = candidateRecord?.expiresAt;
    const schemaCandidate =
      candidateRecord !== undefined && Object.hasOwn(candidateRecord, "expiresAt")
        ? {
            ...candidateRecord,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          }
        : candidate;
    const parsed = CreateProposalBody.safeParse(schemaCandidate);
    if (!parsed.success) return fail("validation", "Invalid proposal input.");
    let suppliedExpiry: number | undefined;
    if (suppliedExpiresAt !== undefined) {
      if (typeof suppliedExpiresAt !== "string") {
        return fail("validation", "Invalid proposal expiry.");
      }
      suppliedExpiry = parseIsoDateTime(suppliedExpiresAt);
      if (suppliedExpiry === undefined) {
        return fail("validation", "Invalid proposal expiry.");
      }
    }

    const requestHash = await sha256Hex(canonicalJson(candidate as JsonValue));
    requireLiveStash(stash);
    const replayForKey = (): Response | undefined => {
      if (key === undefined) return undefined;
      const existing = [...proposalsFor(stash).values()].find((row) => row.idempotencyKey === key);
      if (existing === undefined) return undefined;
      if (existing.requestHash !== requestHash) {
        return fail("idempotency-key-reused", "Idempotency key was used for another request");
      }
      return json(proposalRecord(existing, now()), 201, { "Idempotent-Replayed": "true" });
    };
    const replay = replayForKey();
    if (replay !== undefined) return replay;

    const createdAt = now();
    const expiresAt = suppliedExpiry ?? createdAt + proposalTtlDays * 86_400_000;
    if (expiresAt <= createdAt) {
      return fail("validation", "Proposal expiry must be in the future.");
    }

    const bodyHash = await sha256Hex(parsed.data.body);
    requireLiveStash(stash);
    const racedReplay = replayForKey();
    if (racedReplay !== undefined) return racedReplay;

    const id = `prp_${String(createdAt).padStart(13, "0")}${nextProposalSerial
      .toString(16)
      .padStart(8, "0")}`;
    nextProposalSerial += 1;
    const meta = { ...cloneMeta(parsed.data.meta), proposalId: id };
    if (utf8ByteLength(JSON.stringify(meta)) > MAX_META_BYTES) {
      return fail("validation", "Proposal metadata is too large after stamping.");
    }
    const blob = storeBlob(stash, bodyHash, parsed.data.body, createdAt);
    const row: FakeProposalRow = {
      id,
      stash,
      path: parsed.data.path,
      baseVersion: parsed.data.baseVersion,
      blobHash: bodyHash,
      size: blob.size,
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? "",
      meta,
      status: "open",
      expiresAt,
      createdAt,
      idempotencyKey: key ?? null,
      requestHash: key === undefined ? null : requestHash,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      appliedVersion: null,
      appliedChangeId: null,
    };
    proposalsFor(stash).set(id, row);
    publishProposal(row, "open", requestOrigin(request));
    return json(proposalRecord(row, createdAt), 201);
  };

  const handleListProposals = (stash: string, url: URL): Response => {
    const parsed = ListProposalsQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid proposal list query.");
    const readAt = now();
    const filtered = [...proposalsFor(stash).values()]
      .filter(
        (row) => parsed.data.status === "all" || proposalStatus(row, readAt) === parsed.data.status,
      )
      .filter((row) => parsed.data.path === undefined || row.path === parsed.data.path)
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
      );
    const cursor =
      parsed.data.after === undefined ? undefined : decodeProposalCursor(parsed.data.after);
    const candidates = filtered.filter(
      (row) =>
        cursor === undefined ||
        row.createdAt < cursor.createdAt ||
        (row.createdAt === cursor.createdAt && row.id < cursor.id),
    );
    const hasMore = candidates.length > parsed.data.limit;
    const page = candidates.slice(0, parsed.data.limit);
    const last = page.at(-1);
    return json({
      proposals: page.map((row) => proposalRecord(row, readAt)),
      nextAfter: hasMore && last !== undefined ? proposalCursor(last) : null,
      total: filtered.length,
    });
  };

  const handleGetProposal = (stash: string, id: string): Response => {
    const row = requireProposal(stash, id);
    return json({ ...proposalRecord(row, now()), body: proposalBody(row) });
  };

  const currentForPath = (stash: string, path: string): Current | null => {
    const file = getFile(stash, path);
    return file === undefined ? null : current(file, getHeadVersion(file));
  };

  const handleGetProposalDiff = (stash: string, id: string, url: URL): Response => {
    const parsed = ProposalDiffQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid proposal diff query.");
    ensureSafeInteger(parsed.data.context, "context");
    const row = requireProposal(stash, id);
    const baseVersion =
      row.baseVersion === null ? undefined : getVersion(stash, row.path, row.baseVersion);
    if (row.baseVersion !== null && baseVersion === undefined) {
      return fail("not-found", "The proposal base version was not found.");
    }
    const base = {
      version: row.baseVersion,
      hash: baseVersion?.hash ?? null,
      deleted: baseVersion?.kind === "delete",
    };
    const candidate = { hash: row.blobHash, size: row.size };
    const currentHead = currentForPath(stash, row.path);
    const stale = (currentHead?.version ?? null) !== row.baseVersion;
    const result =
      base.hash === row.blobHash
        ? { state: "same" as const }
        : computeDiff({
            fromText:
              baseVersion === undefined || baseVersion.kind === "delete"
                ? ""
                : bodyFor(baseVersion),
            toText: proposalBody(row),
            fromLabel:
              row.baseVersion === null
                ? `a/${row.path}@empty`
                : `a/${row.path}@v${row.baseVersion}`,
            toLabel: `b/${row.path}@${row.id}`,
            context: parsed.data.context,
          });
    return json({ ...result, base, candidate, current: currentHead, stale });
  };

  const approvalResult = (row: FakeProposalRow) => {
    if (row.appliedVersion === null || row.appliedChangeId === null) {
      return fail("internal", "The applied fake proposal has no applied version.");
    }
    const version = getVersion(row.stash, row.path, row.appliedVersion);
    if (
      version === undefined ||
      version.changeId !== row.appliedChangeId ||
      version.hash === null
    ) {
      return fail("internal", "The applied fake proposal points at a missing version.");
    }
    return {
      status: "applied" as const,
      appliedVersion: version.version,
      appliedChangeId: version.changeId,
      hash: version.hash,
      createdAt: iso(version.createdAt),
    };
  };

  const handleApproveProposal = async (
    request: Request,
    principal: Principal,
    stash: string,
    id: string,
  ): Promise<Response> => {
    const parsed = ApproveProposalBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid proposal approval input.");
    requireLiveStash(stash);
    const row = requireProposal(stash, id);
    if (row.status === "applied") return json(approvalResult(row));
    if (row.status === "rejected") return fail("proposal-closed", "The proposal is closed.");
    const decidedAt = now();
    if (row.expiresAt <= decidedAt) {
      return fail("proposal-expired", "The proposal has expired.");
    }
    const file = getFile(stash, row.path);
    const exactHead =
      row.baseVersion === null ? file === undefined : file?.headVersion === row.baseVersion;
    if (!exactHead) {
      return fail(
        "stale",
        "The proposal base no longer matches the current head.",
        file === undefined ? undefined : current(file, getHeadVersion(file)),
      );
    }

    // From this claim through the head append there are no awaits. Concurrent approvals may
    // parse together, but only one can observe open and publish the ordinary version.
    row.status = "applied";
    row.decidedAt = decidedAt;
    row.decidedBy = principalId(principal);
    row.decisionReason = null;
    const version = append(
      stash,
      row.path,
      {
        kind: "put",
        hash: row.blobHash,
        size: row.size,
        contentType: DEFAULT_CONTENT_TYPE,
        rollbackOf: null,
        author: parsed.data.author ?? row.author,
        message: parsed.data.message ?? row.message,
        meta: cloneMeta(row.meta),
      },
      { createdAt: decidedAt, origin: requestOrigin(request) },
    );
    row.appliedVersion = version.version;
    row.appliedChangeId = version.changeId;
    publishProposal(row, "applied", requestOrigin(request));
    return json(approvalResult(row));
  };

  const handleRejectProposal = async (
    request: Request,
    principal: Principal,
    stash: string,
    id: string,
  ): Promise<Response> => {
    const parsed = RejectProposalBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid proposal rejection input.");
    requireLiveStash(stash);
    const row = requireProposal(stash, id);
    if (row.status === "applied") return fail("proposal-closed", "The proposal is closed.");
    if (row.status === "rejected") return json(proposalRecord(row, now()));
    row.status = "rejected";
    row.decidedAt = now();
    row.decidedBy = principalId(principal);
    row.decisionReason = parsed.data.reason ?? null;
    publishProposal(row, "rejected", requestOrigin(request));
    return json(proposalRecord(row, row.decidedAt));
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
    const version = append(
      stash,
      path,
      {
        kind: "put",
        hash: bodyHash,
        size,
        contentType,
        rollbackOf: null,
        author: parsed.data.author ?? "",
        message: parsed.data.message ?? "",
        meta: cloneMeta(parsed.data.meta),
      },
      { origin: requestOrigin(request) },
    );
    storeBlob(stash, bodyHash, parsed.data.body, version.createdAt);
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
    const version = append(
      stash,
      path,
      {
        kind: "delete",
        hash: null,
        size: 0,
        contentType: DEFAULT_CONTENT_TYPE,
        rollbackOf: null,
        author: parsed.data.author ?? "",
        message: parsed.data.message ?? "",
        meta: {},
      },
      { origin: requestOrigin(request) },
    );
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
    const version = append(
      stash,
      path,
      {
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
      },
      { origin: requestOrigin(request) },
    );
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
      const rateLimited = await applyRateLimit(principal, match.routeId);
      if (rateLimited !== undefined) return rateLimited;
      const url = new URL(request.url);
      const stash = match.stash;
      const path = match.path === undefined ? undefined : requirePath(match.path);
      if (stash !== undefined && LIVE_STASH_ROUTE_IDS.has(match.routeId)) {
        requireLiveStash(stash);
      }
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
        case "deleteStash":
          return handleDeleteStash(stash ?? "");
        case "restoreStash":
          return handleRestoreStash(stash ?? "");
        case "createToken":
          return await handleCreateToken(request, stash ?? "");
        case "listTokens":
          return handleListTokens(stash ?? "");
        case "rotateToken":
          return await handleRotateToken(request, stash ?? "", match.tokenId ?? "");
        case "revokeToken":
          return handleRevokeToken(stash ?? "", match.tokenId ?? "");
        case "stashEvents":
          return handleEvents(request, stash ?? "", url);
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
        case "runGc":
          return await handleRunGc(request);
        case "listGcRuns":
          return handleListGcRuns(url);
        case "createProposal":
          return await handleCreateProposal(request, stash ?? "");
        case "listProposals":
          return handleListProposals(stash ?? "", url);
        case "getProposal":
          return handleGetProposal(stash ?? "", match.proposalId ?? "");
        case "getProposalDiff":
          return handleGetProposalDiff(stash ?? "", match.proposalId ?? "", url);
        case "approveProposal":
          return await handleApproveProposal(
            request,
            principal,
            stash ?? "",
            match.proposalId ?? "",
          );
        case "rejectProposal":
          return await handleRejectProposal(
            request,
            principal,
            stash ?? "",
            match.proposalId ?? "",
          );
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
    events,
    createStash(name) {
      return createStashRow(name).name;
    },
    async mintToken(stash, scope, tokenOptions = {}) {
      const parsed = CreateTokenBody.safeParse({ ...tokenOptions, scope });
      if (!parsed.success) throw new TypeError("Invalid fixture token input");
      return (await mintStoredToken(stash, parsed.data.scope, parsed.data)).token;
    },
    reset() {
      for (const stash of [...eventSubscribers.keys()]) closeSubscribers(stash);
      state.proposals.clear();
      state.stashes.clear();
      state.tokens.clear();
      state.blobs.clear();
      state.r2Objects.clear();
      state.files.clear();
      state.versions.length = 0;
      state.idempotency.clear();
      state.gcRuns.length = 0;
      for (const job of state.gcJobs.values()) {
        job.nextCursor = null;
        job.leaseOwner = null;
        job.leaseGeneration = 0;
        job.leaseUntil = null;
        job.updatedAt = 0;
      }
      gcCursorPositions.clear();
      nextToken = 1;
      nextChangeId = 1;
      nextR2ObjectSerial = 1;
      nextProposalSerial = 1;
      nextGcRun = 1;
      nextGcCursorSerial = 1;
    },
  };
}

/** The exact route subset modelled by the fake, exported for coverage assertions. */
export const FAKE_SUPPORTED_ROUTE_IDS = [...SUPPORTED_ROUTE_IDS] as readonly RouteId[];
