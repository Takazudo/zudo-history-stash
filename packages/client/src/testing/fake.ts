import {
  BODY_LIMIT_BYTES,
  COMMIT_DIFF_INLINE_ENTRIES,
  DIFF_MAX_BYTES,
  ChangesQuery,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  CreateChangeSetBody,
  CreateCommitBody,
  CreateUploadSessionBody,
  CompleteUploadSessionBody,
  AbortUploadSessionBody,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  decodeCanonicalBase64,
  DiffCandidateBody,
  DiffQuery,
  EventsQuery,
  FileGetQuery,
  ListGcRunsQuery,
  HistoryQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListFilesQuery,
  ListChangeSetsQuery,
  ListCommitsQuery,
  ListStashesQuery,
  MAX_COMMIT_INLINE_BYTES,
  MAX_META_BYTES,
  MAX_BODY_BYTES,
  PutFileBody,
  R2_SPILL_BYTES,
  RevertCommitBody,
  ApproveChangeSetBody,
  RejectChangeSetBody,
  SnapshotQuery,
  ROUTES,
  RotateTokenBody,
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
  parseSnapshotSelector,
  pathPrefixRange,
  requestHashInput,
  sha256Hex,
  statusForCode,
  utf8ByteLength,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
import type {
  Current,
  CapabilitiesResponse,
  ChangeSetDiffResult,
  ChangeSetEntryInput,
  ChangeSetRecord,
  CommitConflict,
  CommitDiffResult,
  CommitEntryInput,
  CommitEntryRecord,
  CommitResult,
  CreateChangeSetBody as CreateChangeSetBodyType,
  CreateCommitBody as CreateCommitBodyType,
  DiffSide,
  ErrorCode,
  GcKind,
  JsonValue,
  ParsedRevertCommitBody,
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
  FakeChangeSetEntryRow,
  FakeChangeSetRow,
  FakeCommitRow,
  FakeIdempotencyRow,
  FakeMintTokenOptions,
  FakeR2ObjectRow,
  FakeRateLimitInput,
  FakeStash,
  FakeStashEvents,
  FakeStashOptions,
  FakeStashRow,
  FakeStashState,
  FakeTokenRow,
  FakeVersionRow,
  FakeUploadSessionRow,
} from "./types.js";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";
const MAX_DIFF_CONTEXT = 10;
const LAST_USED_INTERVAL_MS = 60_000;
const MAX_TOKEN_TTL_MS = 315_360_000 * 1_000;
const DEFAULT_DELETE_GRACE_DAYS = 30;
const DEFAULT_GC_ORPHAN_MIN_AGE_MS = 900_000;
const GC_LEASE_TTL_MS = 300_000;
const MAX_R2_GC_PAGE_OBJECTS = 24;
const SHA256_HASH = /^sha256-[0-9a-f]{64}$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANGE_SET_ID = /^chs_\d{13}[0-9a-f]{8}$/;
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;
const DEFAULT_CAPABILITIES: CapabilitiesResponse = {
  representations: ["text", "binary"],
  contentAccess: ["inline", "raw", "deleted"],
  transferModes: ["json", "single", "multipart"],
  storageTiers: ["d1", "r2"],
  commitEntryKinds: ["put", "copy", "delete", "rollback"],
  limits: {
    jsonInlineMaxBytes: MAX_BODY_BYTES,
    d1InlineMaxBytes: 1_000_000,
    httpRequestMaxBytes: 100_000_000,
    singleUploadMaxBytes: 32_000_000,
    maxFileBytes: 1_073_741_824,
    diffMaxBytesPerSide: DIFF_MAX_BYTES,
    multipartPartBytes: 8_388_608,
    maxMultipartParts: 10_000,
    maxOpenUploadSessionsPerStash: 32,
    maxReservedUploadBytesPerStash: 2_147_483_648,
    uploadSessionTtlSeconds: 86_400,
  },
};

const SUPPORTED_ROUTE_IDS = new Set<RouteId>([
  "getCapabilities",
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
  "createCommit",
  "getCommit",
  "listCommits",
  "getCommitDiff",
  "revertCommit",
  "getSnapshot",
  "createChangeSet",
  "listChangeSets",
  "getChangeSet",
  "getChangeSetDiff",
  "approveChangeSet",
  "rejectChangeSet",
  "stashEvents",
  "getRawFile",
  "headRawFile",
  "getRawVersion",
  "headRawVersion",
  "createUploadSession",
  "getUploadSession",
  "uploadSingleContent",
  "uploadPart",
  "completeUploadSession",
  "resumeUploadSession",
  "abortUploadSession",
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
  "getCommit",
  "listCommits",
  "getCommitDiff",
  "createCommit",
  "revertCommit",
  "getSnapshot",
  "createChangeSet",
  "listChangeSets",
  "getChangeSet",
  "getChangeSetDiff",
  "approveChangeSet",
  "rejectChangeSet",
  "stashEvents",
  "getRawFile",
  "headRawFile",
  "getRawVersion",
  "headRawVersion",
  "createUploadSession",
  "getUploadSession",
  "uploadSingleContent",
  "uploadPart",
  "completeUploadSession",
  "resumeUploadSession",
  "abortUploadSession",
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
  createCommit: "write",
  getCommit: "read",
  listCommits: "read",
  getCommitDiff: "diff",
  revertCommit: "write",
  getSnapshot: "read",
  createChangeSet: "write",
  listChangeSets: "read",
  getChangeSet: "read",
  getChangeSetDiff: "diff",
  approveChangeSet: "write",
  rejectChangeSet: "write",
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
  id?: string;
  tokenId?: string;
  sessionId?: string;
  version?: number;
  partNumber?: number;
}

class FakeHttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: Current;
  readonly successorId?: string;
  readonly conflicts?: CommitConflict[];

  constructor(
    code: ErrorCode,
    message: string,
    current?: Current,
    successorId?: string,
    conflicts?: CommitConflict[],
  ) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
    this.current = current;
    this.successorId = successorId;
    this.conflicts = conflicts;
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
      ...(error.conflicts === undefined ? {} : { conflicts: error.conflicts }),
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
  if (method === "GET" && pathname === "/v1/capabilities") return { routeId: "getCapabilities" };
  if (method === "GET" && pathname === "/v1/me") return { routeId: "me" };
  if (method === "GET" && pathname === "/v1/stashes") return { routeId: "listStashes" };
  if (method === "POST" && pathname === "/v1/stashes") return { routeId: "createStash" };

  if (method === "POST" && pathname === "/v1/admin/gc") return { routeId: "runGc" };
  if (method === "GET" && pathname === "/v1/admin/gc/runs") return { routeId: "listGcRuns" };

  let match = /^\/v1\/stashes\/([^/]+)\/events$/.exec(pathname);
  if (method === "GET" && match?.[1] !== undefined) {
    return { routeId: "stashEvents", stash: decode(match[1]) };
  }

  const commitCollection = /^\/v1\/stashes\/([^/]+)\/commits$/.exec(pathname);
  if ((method === "GET" || method === "POST") && commitCollection?.[1] !== undefined) {
    return {
      routeId: method === "POST" ? "createCommit" : "listCommits",
      stash: decode(commitCollection[1]),
    };
  }
  const changeSetCollection = /^\/v1\/stashes\/([^/]+)\/change-sets$/.exec(pathname);
  if ((method === "GET" || method === "POST") && changeSetCollection?.[1] !== undefined) {
    return {
      routeId: method === "POST" ? "createChangeSet" : "listChangeSets",
      stash: decode(changeSetCollection[1]),
    };
  }

  const skeletons: Array<[RegExp, RouteId, "GET" | "POST"]> = [
    [/^\/v1\/stashes\/([^/]+)\/commits\/([^/]+)$/, "getCommit", "GET"],
    [/^\/v1\/stashes\/([^/]+)\/commits\/([^/]+)\/diff$/, "getCommitDiff", "GET"],
    [/^\/v1\/stashes\/([^/]+)\/commits\/([^/]+)\/revert$/, "revertCommit", "POST"],
    [/^\/v1\/stashes\/([^/]+)\/snapshot$/, "getSnapshot", "GET"],
    [/^\/v1\/stashes\/([^/]+)\/change-sets\/([^/]+)$/, "getChangeSet", "GET"],
    [/^\/v1\/stashes\/([^/]+)\/change-sets\/([^/]+)\/diff$/, "getChangeSetDiff", "GET"],
    [/^\/v1\/stashes\/([^/]+)\/change-sets\/([^/]+)\/approve$/, "approveChangeSet", "POST"],
    [/^\/v1\/stashes\/([^/]+)\/change-sets\/([^/]+)\/reject$/, "rejectChangeSet", "POST"],
  ];
  for (const [pattern, routeId, routeMethod] of skeletons) {
    if (method !== routeMethod) continue;
    const skeleton = pattern.exec(pathname);
    if (skeleton?.[1] !== undefined) {
      const id = skeleton[2];
      return {
        routeId,
        stash: decode(skeleton[1]),
        ...(id === undefined ? {} : { id: decode(id) }),
      };
    }
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

  match = /^\/v1\/stashes\/([^/]+)\/versions\/(\d+)\/raw\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && match?.[1] && match[2] && match[3]) {
    return {
      routeId: method === "HEAD" ? "headRawVersion" : "getRawVersion",
      stash: decode(match[1]),
      version: Number(match[2]),
      path: decode(match[3]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/raw\/(.+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && match?.[1] && match[2]) {
    return {
      routeId: method === "HEAD" ? "headRawFile" : "getRawFile",
      stash: decode(match[1]),
      path: decode(match[2]),
    };
  }

  match = /^\/v1\/stashes\/([^/]+)\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(pathname);
  if (method === "PUT" && match?.[1] && match[2] && match[3]) {
    return {
      routeId: "uploadPart",
      stash: decode(match[1]),
      sessionId: decode(match[2]),
      partNumber: Number(match[3]),
    };
  }
  match = /^\/v1\/stashes\/([^/]+)\/uploads\/([^/]+)\/(content|complete|resume)$/.exec(pathname);
  if (match?.[1] && match[2] && match[3]) {
    const routeId =
      match[3] === "content"
        ? "uploadSingleContent"
        : match[3] === "complete"
          ? "completeUploadSession"
          : "resumeUploadSession";
    if (routeId === "uploadSingleContent" ? method === "PUT" : method === "POST") {
      return { routeId, stash: decode(match[1]), sessionId: decode(match[2]) };
    }
  }
  match = /^\/v1\/stashes\/([^/]+)\/uploads\/([^/]+)$/.exec(pathname);
  if ((method === "GET" || method === "DELETE") && match?.[1] && match[2]) {
    return {
      routeId: method === "GET" ? "getUploadSession" : "abortUploadSession",
      stash: decode(match[1]),
      sessionId: decode(match[2]),
    };
  }
  match = /^\/v1\/stashes\/([^/]+)\/uploads\/(.+)$/.exec(pathname);
  if (method === "POST" && match?.[1] && match[2]) {
    return { routeId: "createUploadSession", stash: decode(match[1]), path: decode(match[2]) };
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

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    commitId: row.commitId,
    stash: row.stash,
    path: row.path,
    version: row.version,
    kind: row.kind,
    author: row.author,
    message: row.message,
    size: row.size,
    representation: row.representation ?? "text",
    contentAccess: row.kind === "delete" ? "deleted" : (row.contentAccess ?? "inline"),
    contentType: row.contentType,
    byteSize: row.size,
    etag: row.kind === "delete" ? null : row.hash,
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
 * Creates a small consumer fake. It models the explicitly exported conformance route set; all
 * other endpoints intentionally return 501 so a test cannot accidentally depend on an unmodelled
 * server feature.
 */
export function createFakeStash(options: FakeStashOptions = {}): FakeStash {
  const now = options.now ?? Date.now;
  const adminToken = options.adminToken ?? "admin";
  const limiter = options.rateLimit ?? (() => ({ success: true }));
  const deleteGraceDays = options.deleteGraceDays ?? DEFAULT_DELETE_GRACE_DAYS;
  const gcOrphanMinAgeMs = options.gcOrphanMinAgeMs ?? DEFAULT_GC_ORPHAN_MIN_AGE_MS;
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  if (!Number.isSafeInteger(deleteGraceDays) || deleteGraceDays < 1) {
    throw new TypeError("deleteGraceDays must be a positive safe integer");
  }
  if (!Number.isSafeInteger(gcOrphanMinAgeMs) || gcOrphanMinAgeMs < 0) {
    throw new TypeError("gcOrphanMinAgeMs must be a non-negative safe integer");
  }
  const state: FakeStashState = {
    stashes: new Map(),
    tokens: new Map(),
    blobs: new Map(),
    r2Objects: new Map(),
    files: new Map(),
    versions: [],
    commits: new Map(),
    changeSets: new Map(),
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
      [
        "content",
        {
          kind: "content",
          nextCursor: null,
          leaseOwner: null,
          leaseGeneration: 0,
          leaseUntil: null,
          updatedAt: 0,
        },
      ],
    ]),
    gcRuns: [],
    uploadSessions: new Map(),
  };
  let nextToken = 1;
  let nextChangeId = 1;
  let nextChangeSetId = 1;
  let nextR2ObjectSerial = 1;
  let nextGcRun = 1;
  let nextGcCursorSerial = 1;
  let nextUploadSession = 1;
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
          : "stash" in stashOrEvent
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
    commitId: version.commitId,
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
    if (body === undefined || body === null)
      return fail("unsupported-representation", "Binary content has no JSON body.");
    return body;
  };
  const bytesFor = (version: FakeVersionRow): Uint8Array => {
    if (version.hash === null) return new Uint8Array();
    const bytes = state.blobs.get(version.stash)?.get(version.hash)?.bytes;
    if (bytes === undefined) return fail("internal", "The fake version points at a missing blob.");
    return bytes;
  };

  const operationFor = (version: FakeVersionRow): CommitEntryRecord["op"] =>
    version.copiedFrom === undefined
      ? version.kind === "rollback"
        ? "rollback"
        : version.kind === "delete"
          ? "delete"
          : "put"
      : "copy";

  const commitEntry = (
    version: FakeVersionRow,
    op: CommitEntryRecord["op"] = operationFor(version),
  ): CommitEntryRecord => {
    const blob =
      version.hash === null ? undefined : state.blobs.get(version.stash)?.get(version.hash);
    const previous =
      version.version > 1
        ? getVersion(version.stash, version.path, version.version - 1)
        : undefined;
    return {
      path: version.path,
      op,
      version: version.version,
      kind: version.kind,
      changeId: version.changeId,
      hash: version.hash,
      size: version.size,
      contentType: version.contentType,
      representation: version.representation ?? "text",
      rollbackOf: version.rollbackOf,
      ...(blob === undefined
        ? {}
        : { storageTier: blob.r2Key === null ? ("d1" as const) : ("r2" as const) }),
      ...(version.copiedFrom === undefined ? {} : { copiedFrom: version.copiedFrom }),
      ...(op === "rollback"
        ? {
            identicalToHead:
              previous !== undefined &&
              previous.hash === version.hash &&
              previous.contentType === version.contentType &&
              previous.representation === version.representation,
          }
        : {}),
    };
  };

  const defaultCommitSource = (version: FakeVersionRow): string => operationFor(version);

  const registerCommitEntry = (
    version: FakeVersionRow,
    options: {
      source?: string;
      sourceId?: string | null;
      author?: string;
      message?: string;
      meta?: Record<string, JsonValue>;
      createdBy?: string;
      revertsCommitId?: string | null;
      requestedOp?: CommitEntryRecord["op"];
    } = {},
  ): FakeCommitRow => {
    const existing = state.commits.get(version.commitId);
    if (existing !== undefined) {
      const operation = options.requestedOp ?? operationFor(version);
      if (!existing.entries.some((entry) => entry.changeId === version.changeId)) {
        existing.entries.push(commitEntry(version, operation));
        existing.entryCount = existing.entries.length;
        existing.lastChangeId = version.changeId;
        existing.requestedEntries.push(operation);
      }
      return existing;
    }
    const operation = options.requestedOp ?? operationFor(version);
    const value: FakeCommitRow = {
      id: version.commitId,
      stash: version.stash,
      source: options.source ?? defaultCommitSource(version),
      sourceId: options.sourceId ?? null,
      author: options.author ?? version.author,
      message: options.message ?? version.message,
      meta: cloneMeta(options.meta ?? version.meta),
      entryCount: 1,
      firstChangeId: version.changeId,
      lastChangeId: version.changeId,
      revertsCommitId: options.revertsCommitId ?? null,
      createdBy: options.createdBy ?? "system",
      createdAt: iso(version.createdAt),
      entries: [commitEntry(version, operation)],
      requestHash: null,
      idempotencyKey: null,
      requestedEntries: [operation],
    };
    state.commits.set(value.id, value);
    return value;
  };

  const finalizeCommit = (
    id: string,
    options: {
      source?: string;
      sourceId?: string | null;
      author?: string;
      message?: string;
      meta?: Record<string, JsonValue>;
      createdBy?: string;
      revertsCommitId?: string | null;
      requestHash?: string | null;
      idempotencyKey?: string | null;
    },
  ): FakeCommitRow => {
    const commit = state.commits.get(id);
    if (commit === undefined) return fail("internal", "The fake commit is unavailable.");
    if (options.source !== undefined) commit.source = options.source;
    if (options.sourceId !== undefined) commit.sourceId = options.sourceId;
    if (options.author !== undefined) commit.author = options.author;
    if (options.message !== undefined) commit.message = options.message;
    if (options.meta !== undefined) commit.meta = cloneMeta(options.meta);
    if (options.createdBy !== undefined) commit.createdBy = options.createdBy;
    if (options.revertsCommitId !== undefined) commit.revertsCommitId = options.revertsCommitId;
    if (options.requestHash !== undefined) commit.requestHash = options.requestHash;
    if (options.idempotencyKey !== undefined) commit.idempotencyKey = options.idempotencyKey;
    commit.entries = state.versions
      .filter((version) => version.stash === commit.stash && version.commitId === commit.id)
      .sort((left, right) => left.changeId - right.changeId)
      .map((version, index) =>
        commitEntry(version, commit.requestedEntries[index] ?? operationFor(version)),
      );
    commit.entryCount = commit.entries.length;
    commit.firstChangeId = commit.entries[0]?.changeId ?? commit.firstChangeId;
    commit.lastChangeId = commit.entries.at(-1)?.changeId ?? commit.lastChangeId;
    return commit;
  };
  const storeBlob = (stash: string, hash: string, body: string, createdAt: number): FakeBlobRow => {
    const rows = nested(state.blobs, stash);
    const existing = rows.get(hash);
    if (existing !== undefined) {
      // The Worker keeps text and byte blobs in separate tables. The compact fake shares hashes,
      // so preserve the text materialization when equal binary bytes arrived first.
      if (existing.body === null) existing.body = body;
      return existing;
    }
    const size = utf8ByteLength(body);
    let r2Key: string | null = null;
    if (size > R2_SPILL_BYTES) {
      const generation = `00000000-0000-4000-8000-${String(nextR2ObjectSerial).padStart(12, "0")}`;
      r2Key = `v2/${stash}/${hash}/${generation}`;
      nextR2ObjectSerial += 1;
      state.r2Objects.set(r2Key, { key: r2Key, stash, hash, size, createdAt });
    }
    const row: FakeBlobRow = {
      stash,
      hash,
      body,
      bytes: new TextEncoder().encode(body),
      r2Key,
      size,
      createdAt,
    };
    rows.set(hash, row);
    return row;
  };
  const storeBinary = (
    stash: string,
    hash: string,
    bytes: Uint8Array,
    createdAt: number,
  ): FakeBlobRow => {
    const rows = nested(state.blobs, stash);
    const existing = rows.get(hash);
    if (existing !== undefined) return existing;
    let r2Key: string | null = null;
    if (bytes.byteLength > R2_SPILL_BYTES) {
      const generation = `00000000-0000-4000-8000-${String(nextR2ObjectSerial).padStart(12, "0")}`;
      r2Key = `v2/${stash}/${hash}/${generation}`;
      nextR2ObjectSerial += 1;
      state.r2Objects.set(r2Key, {
        key: r2Key,
        stash,
        hash,
        size: bytes.byteLength,
        createdAt,
      });
    }
    const row: FakeBlobRow = {
      stash,
      hash,
      body: null,
      bytes: bytes.slice(),
      r2Key,
      size: bytes.byteLength,
      createdAt,
    };
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
      commitId: version.commitId,
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
        ...(version.representation === undefined
          ? {}
          : {
              representation: version.representation,
              contentType: version.contentType,
              byteSize: version.size,
              etag: version.hash,
            }),
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
    input: Omit<
      FakeVersionRow,
      "changeId" | "stash" | "path" | "version" | "createdAt" | "commitId"
    >,
    appendOptions: {
      createdAt?: number;
      origin?: string | null;
      commitId?: string;
      publish?: boolean;
      requestedOp?: CommitEntryRecord["op"];
    } = {},
  ): FakeVersionRow => {
    const createdAt = appendOptions.createdAt ?? now();
    const file = getFile(stash, path);
    const row: FakeVersionRow = {
      ...input,
      changeId: nextChangeId,
      commitId: appendOptions.commitId ?? `cmt_fake_${String(nextChangeId).padStart(8, "0")}`,
      stash,
      path,
      version: (file?.headVersion ?? 0) + 1,
      createdAt,
    };
    nextChangeId += 1;
    state.versions.push(row);
    registerCommitEntry(row, {
      requestedOp: appendOptions.requestedOp,
    });
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
    if (appendOptions.publish !== false) {
      broadcastEvent(stash, changeEvent(row, appendOptions.origin ?? null));
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
    } else if (kind === "content") {
      const candidates = [...state.blobs.entries()]
        .flatMap(([stash, rows]) =>
          [...rows.entries()].map(([hash, row]) => ({ key: `${stash}\u0000${hash}`, row })),
        )
        .sort((left, right) => left.key.localeCompare(right.key));
      const start = pageStart(candidates, inputCursor, kind);
      const page = candidates.slice(start, start + maxObjects);
      run.scanned = page.length;
      // The fake reuses the orphan grace; its live change-set check deliberately differs from
      // the Worker's separate GC_CONTENT_MIN_AGE_MS and expires_at > now - grace rules.
      const eligible = page.filter(({ row: blob }) => {
        const referencedByVersion = state.versions.some(
          (version) => version.stash === blob.stash && version.hash === blob.hash,
        );
        const referencedByChangeSet = [...state.changeSets.values()].some(
          (changeSet) =>
            changeSet.stash === blob.stash &&
            changeSet.status === "open" &&
            changeSet.expiresAt > startedAt &&
            changeSet.entries.some((entry) => entry.hash === blob.hash),
        );
        return (
          !referencedByVersion &&
          !referencedByChangeSet &&
          startedAt - blob.createdAt > gcOrphanMinAgeMs
        );
      });
      run.eligible = eligible.length;
      if (!dryRun) {
        for (const { row: blob } of eligible) {
          state.blobs.get(blob.stash)?.delete(blob.hash);
        }
        run.deleted = eligible.length;
      }
      const last = page.at(-1);
      run.cursor =
        last === undefined || start + page.length >= candidates.length
          ? null
          : nextGcCursor(kind, last.key);
      // Content rows leave R2 objects for the existing r2-orphans job to reclaim in a later phase.
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
    pruneGcRuns("content");
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

  const handleListFiles = (stash: string, url: URL): Response => {
    const parsed = ListFilesQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid file list query.");
    const { after, includeDeleted, limit, prefix, delimiter } = parsed.data;
    const normalizedPrefix =
      prefix === undefined ? undefined : prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (normalizedPrefix !== undefined) {
      const validation = validatePath(normalizedPrefix);
      if (!validation.ok) return fail(validation.error, validation.message);
    }
    if (delimiter !== undefined && delimiter !== "/") {
      return fail("validation", "delimiter must be '/'.");
    }
    const all = [...(state.files.get(stash)?.values() ?? [])]
      .filter((file) => includeDeleted || !file.deleted)
      .filter((file) =>
        normalizedPrefix === undefined
          ? true
          : file.path >= `${normalizedPrefix}/` && file.path < `${normalizedPrefix}0`,
      )
      .map((file) => {
        const relative =
          normalizedPrefix === undefined
            ? file.path
            : file.path.slice(`${normalizedPrefix}/`.length);
        const separator = delimiter === undefined ? -1 : relative.indexOf("/");
        return separator < 0
          ? { path: file.path, file }
          : {
              path: `${normalizedPrefix === undefined ? "" : `${normalizedPrefix}/`}${relative.slice(0, separator + 1)}`,
              file: undefined,
            };
      });
    const candidates = [...new Map(all.map((entry) => [entry.path, entry])).values()]
      .filter((entry) => after === undefined || entry.path > after)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const hasMore = candidates.length > limit;
    const page = candidates.slice(0, limit);
    return json({
      files: page.flatMap(({ file }) => {
        if (file === undefined) return [];
        const head = getHeadVersion(file);
        return {
          path: file.path,
          headVersion: file.headVersion,
          hash: file.headHash,
          size: head.size,
          representation: head.representation ?? "text",
          contentAccess: file.deleted ? "deleted" : (head.contentAccess ?? "inline"),
          contentType: head.contentType,
          byteSize: head.size,
          etag: file.deleted ? null : head.hash,
          deleted: file.deleted,
          updatedAt: iso(file.updatedAt),
        };
      }),
      ...(delimiter === undefined
        ? {}
        : { commonPrefixes: page.flatMap(({ path, file }) => (file === undefined ? [path] : [])) }),
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
        representation: version.representation ?? "text",
        contentAccess: deleted ? "deleted" : (version.contentAccess ?? "inline"),
        contentType: version.contentType,
        byteSize: version.size,
        body: deleted || version.contentAccess === "raw" ? null : bodyFor(version),
      },
      200,
      headers,
    );
  };

  const handlePut = async (
    request: Request,
    stash: string,
    path: string,
    principal: Principal,
  ): Promise<Response> => {
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
        representation: "text",
        contentAccess: size <= capabilities.limits.jsonInlineMaxBytes ? "inline" : "raw",
        rollbackOf: null,
        author: parsed.data.author ?? "",
        message: parsed.data.message ?? "",
        meta: cloneMeta(parsed.data.meta),
      },
      { origin: requestOrigin(request) },
    );
    storeBlob(stash, bodyHash, parsed.data.body, version.createdAt);
    finalizeCommit(version.commitId, { createdBy: principalName(principal) });
    ledger(stash, key, requestHash, version, 201);
    return json(
      {
        commitId: version.commitId,
        version: version.version,
        hash: bodyHash,
        size: version.size,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
      },
      201,
    );
  };

  const handleDelete = async (
    request: Request,
    stash: string,
    path: string,
    principal: Principal,
  ): Promise<Response> => {
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
        contentType: head.contentType,
        representation: head.representation,
        contentAccess: "deleted",
        rollbackOf: null,
        author: parsed.data.author ?? "",
        message: parsed.data.message ?? "",
        meta: {},
      },
      { origin: requestOrigin(request) },
    );
    finalizeCommit(version.commitId, { createdBy: principalName(principal) });
    ledger(stash, key, requestHash, version, 200);
    return json(
      {
        commitId: version.commitId,
        version: version.version,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
      },
      200,
    );
  };

  const handleRollback = async (
    request: Request,
    stash: string,
    path: string,
    principal: Principal,
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
        representation: target.representation,
        contentAccess: target.contentAccess,
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
    finalizeCommit(version.commitId, { createdBy: principalName(principal) });
    ledger(stash, key, requestHash, version, 201);
    return json(
      {
        commitId: version.commitId,
        version: version.version,
        hash: target.hash,
        rollbackOf: target.version,
        identicalToHead: target.hash === head.hash,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
        ...(target.representation === undefined
          ? {}
          : {
              representation: target.representation,
              contentType: target.contentType,
              byteSize: target.size,
              etag: target.hash,
            }),
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
        commitId: version.commitId,
        version: version.version,
        kind: version.kind,
        hash: version.hash,
        size: version.size,
        rollbackOf: version.rollbackOf,
        author: version.author,
        message: version.message,
        meta: cloneMeta(version.meta),
        createdAt: iso(version.createdAt),
        representation: version.representation ?? "text",
        contentAccess: version.kind === "delete" ? "deleted" : (version.contentAccess ?? "inline"),
        contentType: version.contentType,
        byteSize: version.size,
        etag: version.kind === "delete" ? null : version.hash,
      })),
      nextBefore: hasMore ? (page.at(-1)?.version ?? null) : null,
    });
  };

  const uploadRecord = (row: FakeUploadSessionRow) => ({
    id: row.id,
    stash: row.stash,
    path: row.path,
    principal: row.principal,
    state: row.state,
    expectedVersion: row.expectedVersion,
    declaredSize: row.declaredSize,
    declaredHash: row.declaredHash,
    representation: row.representation,
    contentType: row.contentType,
    author: row.author,
    message: row.message,
    meta: row.meta === null ? null : cloneMeta(row.meta),
    mode: row.mode,
    storageTier: row.storageTier,
    partSize: row.partSize,
    expiresAt: iso(row.expiresAt),
    attemptGeneration: row.attemptGeneration,
    uploadedSize: row.uploadedBytes?.byteLength ?? null,
    uploadedHash: row.uploadedHash,
    finalizationLeaseOwner: null,
    finalizationLeaseExpiresAt: null,
    result: row.result,
  });

  const requireUpload = (stash: string, id: string, principal: Principal): FakeUploadSessionRow => {
    const row = state.uploadSessions.get(id);
    const owned =
      row !== undefined &&
      (row.principal.kind === "admin"
        ? principal.kind === "admin"
        : principal.kind === "stash" && row.principal.tokenId === principal.tokenId);
    if (row === undefined || row.stash !== stash || !owned)
      return fail("not-found", "Upload session not found.");
    if (row.state === "open" && row.expiresAt <= now()) row.state = "expired";
    return row;
  };

  const sessionParts = (row: FakeUploadSessionRow) =>
    [...row.parts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([partNumber, bytes]) => ({
        partNumber,
        size: bytes.byteLength,
        generation: row.attemptGeneration,
        etag: `fake-part-${row.attemptGeneration}-${partNumber}-${bytes.byteLength}`,
      }));

  const handleCreateUpload = async (
    request: Request,
    stash: string,
    path: string,
    principal: Principal,
  ): Promise<Response> => {
    const parsed = CreateUploadSessionBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid upload session input.");
    const key = idempotencyKey(request) ?? null;
    const mode =
      parsed.data.mode === "auto"
        ? !parsed.data.resumable && parsed.data.size <= capabilities.limits.singleUploadMaxBytes
          ? "single"
          : "multipart"
        : parsed.data.mode;
    const existing = [...state.uploadSessions.values()].find(
      (row) => row.stash === stash && row.createKey === key && key !== null,
    );
    const samePrincipal =
      existing === undefined ||
      (existing.principal.kind === "admin"
        ? principal.kind === "admin"
        : principal.kind === "stash" && existing.principal.tokenId === principal.tokenId);
    if (
      existing !== undefined &&
      (!samePrincipal ||
        existing.path !== path ||
        existing.expectedVersion !== parsed.data.expectedVersion ||
        existing.declaredSize !== parsed.data.size ||
        existing.declaredHash !== (parsed.data.hash ?? null) ||
        existing.representation !== parsed.data.representation ||
        existing.contentType !== parsed.data.contentType ||
        existing.mode !== mode ||
        existing.author !== (parsed.data.author ?? null) ||
        existing.message !== (parsed.data.message ?? null) ||
        (existing.meta === null ? null : canonicalJson(existing.meta)) !==
          (parsed.data.meta === undefined ? null : canonicalJson(parsed.data.meta)))
    )
      return fail("idempotency-key-reused", "Idempotency-Key was reused.");
    if (existing !== undefined)
      return json(uploadRecord(existing), 201, { "Idempotent-Replayed": "true" });
    const file = getFile(stash, path);
    if (parsed.data.expectedVersion === null && file !== undefined)
      return fail("exists", "File already exists.");
    if (parsed.data.expectedVersion !== null && file === undefined)
      return fail("not-found", "File not found.");
    if (file !== undefined && parsed.data.expectedVersion !== file.headVersion)
      return fail("stale", "Expected version is stale.", current(file, getHeadVersion(file)));
    if (parsed.data.size > capabilities.limits.maxFileBytes)
      return fail("payload-too-large", "The declared file size is too large.");
    if (
      mode === "single" &&
      (parsed.data.resumable || parsed.data.size > capabilities.limits.singleUploadMaxBytes)
    ) {
      return fail(
        parsed.data.resumable ? "validation" : "payload-too-large",
        "Invalid single upload mode.",
      );
    }
    if (mode === "multipart" && parsed.data.size === 0)
      return fail("validation", "An empty file must use single upload mode.");
    const row: FakeUploadSessionRow = {
      id: `upl_fake_${String(nextUploadSession++).padStart(8, "0")}`,
      stash,
      path,
      principal:
        principal.kind === "admin"
          ? { kind: "admin" }
          : { kind: "stash", tokenId: principal.tokenId },
      state: "open",
      expectedVersion: parsed.data.expectedVersion,
      declaredSize: parsed.data.size,
      declaredHash: parsed.data.hash ?? null,
      representation: parsed.data.representation,
      contentType: parsed.data.contentType,
      author: parsed.data.author ?? null,
      message: parsed.data.message ?? null,
      meta: parsed.data.meta === undefined ? null : cloneMeta(parsed.data.meta),
      mode,
      storageTier:
        mode === "multipart" || parsed.data.size > capabilities.limits.d1InlineMaxBytes
          ? "r2"
          : "d1",
      partSize: mode === "multipart" ? capabilities.limits.multipartPartBytes : null,
      expiresAt: now() + capabilities.limits.uploadSessionTtlSeconds * 1_000,
      attemptGeneration: 0,
      uploadedBytes: null,
      uploadedHash: null,
      parts: new Map(),
      result: null,
      createKey: key,
      completeKey: null,
      uploadKey: null,
      abortKey: null,
      terminalCurrent: null,
      skipIfUnchanged: parsed.data.skipIfUnchanged,
    };
    state.uploadSessions.set(row.id, row);
    return json(uploadRecord(row), 201);
  };

  const handleUploadBytes = async (
    request: Request,
    row: FakeUploadSessionRow,
    partNumber?: number,
  ): Promise<Response> => {
    const key = idempotencyKey(request) ?? null;
    if (partNumber === undefined && row.state === "uploaded" && row.uploadKey === key) {
      return json(uploadRecord(row), 202, { "Idempotent-Replayed": "true" });
    }
    if (row.state !== "open")
      return fail(
        row.state === "expired" ? "upload-session-expired" : "upload-session-not-open",
        "Upload session does not accept bytes.",
      );
    const generation = Number(
      new URL(request.url).searchParams.get("generation") ?? row.attemptGeneration,
    );
    if (generation !== row.attemptGeneration)
      return fail("upload-session-not-open", "Upload generation is stale.");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (partNumber === undefined) {
      if (row.mode !== "single" || bytes.byteLength !== row.declaredSize)
        return fail("upload-size-mismatch", "Upload size does not match its declaration.");
      const hash = await sha256Hex(bytes.slice().buffer);
      if (row.declaredHash !== null && row.declaredHash !== hash) {
        row.state = "failed";
        return fail("upload-hash-mismatch", "Upload hash does not match its declaration.");
      }
      if (row.representation === "text") {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          row.state = "failed";
          return fail("unsupported-representation", "Text uploads must contain valid UTF-8.");
        }
      }
      row.uploadedBytes = bytes;
      row.uploadedHash = hash;
      row.uploadKey = key;
      row.state = "uploaded";
      return json(uploadRecord(row), 202);
    }
    if (row.mode !== "multipart" || row.partSize === null)
      return fail("upload-session-not-open", "Upload session does not accept parts.");
    const expectedParts = Math.ceil(row.declaredSize / row.partSize);
    const expectedSize =
      partNumber === expectedParts
        ? row.declaredSize - row.partSize * (expectedParts - 1)
        : row.partSize;
    if (partNumber < 1 || partNumber > expectedParts || bytes.byteLength !== expectedSize)
      return fail("upload-size-mismatch", "Upload part size is incorrect.");
    row.parts.set(partNumber, bytes);
    return json({ ...uploadRecord(row), parts: sessionParts(row) }, 202);
  };

  const handleCompleteUpload = async (
    request: Request,
    row: FakeUploadSessionRow,
    resume = false,
  ): Promise<Response> => {
    const parsed = CompleteUploadSessionBody.safeParse(await requestJson(request));
    if (!parsed.success || parsed.data.generation !== row.attemptGeneration)
      return fail("validation", "Invalid upload completion input.");
    const key = idempotencyKey(request) ?? null;
    if (row.state === "stale") {
      if (row.completeKey !== key)
        return fail("idempotency-key-reused", "Idempotency-Key was reused.");
      return json(
        {
          error: { code: "stale", message: "Expected version is stale." },
          ...(row.terminalCurrent === null ? {} : { current: row.terminalCurrent }),
        },
        409,
        { "Idempotent-Replayed": "true" },
      );
    }
    if (row.state === "committed") {
      if (row.completeKey !== key)
        return fail("idempotency-key-reused", "Idempotency-Key was reused.");
      const status = row.result !== null && "unchanged" in row.result ? 200 : 201;
      return json(resume ? uploadRecord(row) : row.result, resume ? 200 : status, {
        "Idempotent-Replayed": "true",
      });
    }
    if (resume && row.state === "open") return json(uploadRecord(row));
    if (row.state !== "open" && row.state !== "uploaded")
      return fail(
        row.state === "expired" ? "upload-session-expired" : "upload-session-not-open",
        "Upload session is not ready to complete.",
      );
    let bytes: Uint8Array;
    if (row.mode === "single") {
      if (row.uploadedBytes === null)
        return fail("upload-session-not-open", "Upload session is not ready to complete.");
      bytes = row.uploadedBytes;
    } else {
      const parts = sessionParts(row);
      const expected = Math.ceil(row.declaredSize / (row.partSize ?? 1));
      if (parts.length !== expected)
        return fail("upload-size-mismatch", "Multipart upload is incomplete.");
      bytes = new Uint8Array(row.declaredSize);
      let offset = 0;
      for (let part = 1; part <= expected; part += 1) {
        const value = row.parts.get(part);
        if (value === undefined)
          return fail("upload-size-mismatch", "Multipart upload is incomplete.");
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    }
    const hash = await sha256Hex(bytes.slice().buffer);
    if (row.declaredHash !== null && row.declaredHash !== hash) {
      row.state = "failed";
      return fail("upload-hash-mismatch", "Upload hash does not match its declaration.");
    }
    let text: string | null = null;
    if (row.representation === "text") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        row.state = "failed";
        return fail("unsupported-representation", "Text uploads must contain valid UTF-8.");
      }
    }
    const file = getFile(row.stash, row.path);
    if (file !== undefined && file.headVersion !== row.expectedVersion) {
      row.state = "stale";
      row.completeKey = key;
      row.terminalCurrent = current(file, getHeadVersion(file));
      return fail("stale", "Expected version is stale.", row.terminalCurrent);
    }
    if (row.skipIfUnchanged && file !== undefined && !file.deleted && file.headHash === hash) {
      row.result = {
        unchanged: true,
        version: file.headVersion,
        hash,
        size: bytes.byteLength,
        representation: row.representation,
        contentType: row.contentType,
      };
    } else {
      const author = row.author ?? (row.principal.kind === "stash" ? row.principal.tokenId : "");
      const message = row.message ?? "";
      const meta = row.meta ?? {};
      const version = append(row.stash, row.path, {
        kind: "put",
        hash,
        size: bytes.byteLength,
        contentType: row.contentType,
        representation: row.representation,
        contentAccess:
          row.representation === "text" &&
          bytes.byteLength <= capabilities.limits.jsonInlineMaxBytes
            ? "inline"
            : "raw",
        rollbackOf: null,
        author,
        message,
        meta: cloneMeta(meta),
      });
      const r2Key =
        row.storageTier === "r2"
          ? `v2/${row.stash}/${hash}/00000000-0000-4000-8000-${String(nextR2ObjectSerial++).padStart(12, "0")}`
          : null;
      if (r2Key !== null) {
        state.r2Objects.set(r2Key, {
          key: r2Key,
          stash: row.stash,
          hash,
          size: bytes.byteLength,
          createdAt: version.createdAt,
        });
      }
      const blob: FakeBlobRow = {
        stash: row.stash,
        hash,
        body: text,
        bytes: bytes.slice(),
        r2Key,
        size: bytes.byteLength,
        createdAt: version.createdAt,
      };
      nested(state.blobs, row.stash).set(hash, blob);
      finalizeCommit(version.commitId, {
        author,
        message,
        meta,
        createdBy: principalName(row.principal),
      });
      row.result = {
        commitId: version.commitId,
        version: version.version,
        hash,
        size: bytes.byteLength,
        representation: row.representation,
        contentType: row.contentType,
        changeId: version.changeId,
        createdAt: iso(version.createdAt),
      };
    }
    row.state = "committed";
    row.completeKey = key;
    const status = row.result !== null && "unchanged" in row.result ? 200 : 201;
    return json(resume ? uploadRecord(row) : row.result, resume ? 200 : status);
  };

  const handleRaw = (
    request: Request,
    stash: string,
    path: string,
    requestedVersion?: number,
  ): Response => {
    const file = getFile(stash, path);
    if (file === undefined)
      return fail(
        requestedVersion === undefined ? "not-found" : "version-not-found",
        "File not found.",
      );
    const version =
      requestedVersion === undefined
        ? getHeadVersion(file)
        : getVersion(stash, path, requestedVersion);
    if (version === undefined) return fail("version-not-found", "Version not found.");
    if (version.kind === "delete") return fail("file-deleted", "The file version is deleted.");
    const all = bytesFor(version);
    const etag = `"${version.hash ?? ""}"`;
    if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag))
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "X-Stash-Version": String(version.version) },
      });
    let start = 0;
    let end = all.byteLength - 1;
    let partial = false;
    const range = request.headers.get("Range");
    const ifRange = request.headers.get("If-Range");
    if (range !== null && (ifRange === null || ifRange === etag)) {
      const matched = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (matched === null || (matched[1] === "" && matched[2] === ""))
        return json(
          {
            error: { code: "range-not-satisfiable", message: "The byte range is not satisfiable." },
          },
          416,
          { "Content-Range": `bytes */${all.byteLength}` },
        );
      if (matched[1] === "") {
        const suffix = BigInt(matched[2] ?? "0");
        if (suffix < 1n)
          return json(
            {
              error: {
                code: "range-not-satisfiable",
                message: "The byte range is not satisfiable.",
              },
            },
            416,
            { "Content-Range": `bytes */${all.byteLength}` },
          );
        start = suffix >= BigInt(all.byteLength) ? 0 : all.byteLength - Number(suffix);
      } else {
        start = Number(matched[1]);
        end = matched[2] === "" ? end : Math.min(Number(matched[2]), end);
      }
      if (start > end || start >= all.byteLength)
        return json(
          {
            error: { code: "range-not-satisfiable", message: "The byte range is not satisfiable." },
          },
          416,
          { "Content-Range": `bytes */${all.byteLength}` },
        );
      partial = true;
    }
    const bytes = all.slice(start, end + 1);
    const responseHeaders: Record<string, string> = {
      ETag: etag,
      "X-Stash-Version": String(version.version),
      "Content-Type": version.contentType,
      "Content-Length": String(bytes.byteLength),
      "Accept-Ranges": "bytes",
    };
    if (partial) responseHeaders["Content-Range"] = `bytes ${start}-${end}/${all.byteLength}`;
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: partial ? 206 : 200,
      headers: responseHeaders,
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
      side: {
        version: version.version,
        hash: version.hash,
        deleted: version.kind === "delete",
        representation: version.representation ?? "text",
        contentAccess: version.kind === "delete" ? "deleted" : (version.contentAccess ?? "inline"),
        contentType: version.contentType,
        byteSize: version.size,
        etag: version.kind === "delete" ? null : version.hash,
      },
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
    if (
      (!from.side.deleted && from.side.representation === "binary") ||
      (!to.side.deleted && to.side.representation === "binary")
    ) {
      return json({ state: "binary", from: from.side, to: to.side });
    }
    if (from.side.hash === to.side.hash) {
      return json({ state: "same", from: from.side, to: to.side });
    }
    if (
      from.row.size > capabilities.limits.diffMaxBytesPerSide ||
      to.row.size > capabilities.limits.diffMaxBytesPerSide
    ) {
      return json({
        state: "oversized",
        reason: "bytes",
        from: from.side,
        to: to.side,
      });
    }
    return json({
      ...computeDiff({
        fromText: from.side.deleted ? "" : bodyFor(from.row),
        toText: to.side.deleted ? "" : bodyFor(to.row),
        fromLabel: `a/${path}@v${from.row.version}`,
        toLabel: `b/${path}@v${to.row.version}`,
        context: parsed.data.context,
        maxBytes: capabilities.limits.diffMaxBytesPerSide,
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
    if (!from.side.deleted && from.side.representation === "binary") {
      return json({ state: "binary" });
    }
    const candidateSize = utf8ByteLength(parsed.data.body);
    if (
      from.row.size > capabilities.limits.diffMaxBytesPerSide ||
      candidateSize > capabilities.limits.diffMaxBytesPerSide
    ) {
      return json({ state: "oversized", reason: "bytes" });
    }
    return json(
      computeDiff({
        fromText: from.side.deleted ? "" : bodyFor(from.row),
        toText: parsed.data.body,
        fromLabel: `a/${path}@v${from.row.version}`,
        toLabel: `b/${path}@candidate`,
        context: parsed.data.context,
        maxBytes: capabilities.limits.diffMaxBytesPerSide,
      }),
    );
  };

  const principalName = (
    principal: { kind: "admin" } | { kind: "stash"; tokenId: string },
  ): string => (principal.kind === "admin" ? "admin" : principal.tokenId);

  const currentForPath = (stash: string, path: string): Current | null => {
    const file = getFile(stash, path);
    return file === undefined ? null : current(file, getHeadVersion(file));
  };

  const latestChangeId = (stash: string): number =>
    state.versions.reduce(
      (latest, version) => (version.stash === stash ? Math.max(latest, version.changeId) : latest),
      0,
    );

  const encodeBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  const commitPublic = (commit: FakeCommitRow): CommitResult => ({
    id: commit.id,
    stash: commit.stash,
    source: commit.source,
    sourceId: commit.sourceId,
    author: commit.author,
    message: commit.message,
    meta: cloneMeta(commit.meta),
    entryCount: commit.entryCount,
    firstChangeId: commit.firstChangeId,
    lastChangeId: commit.lastChangeId,
    revertsCommitId: commit.revertsCommitId,
    createdBy: commit.createdBy,
    createdAt: commit.createdAt,
    entries: commit.entries.map((entry) => ({
      ...entry,
      ...(entry.copiedFrom === undefined ? {} : { copiedFrom: { ...entry.copiedFrom } }),
    })),
  });

  const emitCommit = (commit: FakeCommitRow, origin: string | null): void => {
    for (const entry of commit.entries) {
      const version = getVersion(commit.stash, entry.path, entry.version);
      if (version !== undefined) broadcastEvent(commit.stash, changeEvent(version, origin));
    }
    broadcastEvent(commit.stash, {
      type: "commit",
      commitId: commit.id,
      stash: commit.stash,
      entryCount: commit.entryCount,
      firstChangeId: commit.firstChangeId,
      lastChangeId: commit.lastChangeId,
      origin,
    });
  };

  const commitEntryConflicts = (
    stash: string,
    entries: readonly CommitEntryInput[],
  ): CommitConflict[] => {
    const conflicts: CommitConflict[] = [];
    for (const entry of entries) {
      const file = getFile(stash, entry.path);
      const head = file === undefined ? undefined : getHeadVersion(file);
      const present = file === undefined ? null : current(file, head!);
      let refused =
        entry.expectedVersion === null
          ? file !== undefined
          : file === undefined || file.headVersion !== entry.expectedVersion;
      if (entry.op === "delete" && file?.deleted === true) refused = true;
      if (entry.op === "rollback" || entry.op === "copy") {
        const sourcePath = entry.op === "copy" ? entry.from.path : entry.path;
        const sourceVersion = entry.op === "copy" ? entry.from.version : entry.toVersion;
        const source = getVersion(stash, sourcePath, sourceVersion);
        if (
          source === undefined ||
          source.hash === null ||
          state.blobs.get(stash)?.get(source.hash) === undefined
        ) {
          refused = true;
        }
      }
      if (refused) {
        conflicts.push({
          path: entry.path,
          expectedVersion: entry.expectedVersion,
          current: present,
        });
      }
    }
    return conflicts;
  };

  const throwCommitConflicts = (conflicts: CommitConflict[], notFoundOnNull = true): never => {
    const first = conflicts[0];
    if (conflicts.length === 1 && first?.current === null && notFoundOnNull) {
      throw new FakeHttpError(
        "not-found",
        `File not found: ${first?.path ?? ""}`,
        undefined,
        undefined,
        conflicts,
      );
    }
    throw new FakeHttpError(
      "commit-conflict",
      "One or more commit entries conflict",
      undefined,
      undefined,
      conflicts,
    );
  };

  type PreparedCommitEntry = {
    path: string;
    requestedOp: CommitEntryRecord["op"];
    input: Omit<
      FakeVersionRow,
      "changeId" | "stash" | "path" | "version" | "createdAt" | "commitId"
    >;
    textBody?: string;
    binaryBody?: Uint8Array;
  };

  const stageCommitEntry = async (
    stash: string,
    entry: CommitEntryInput,
    createdAt: number,
    author: string,
    message: string,
    meta: Record<string, JsonValue>,
  ): Promise<PreparedCommitEntry> => {
    const common = {
      author,
      message,
      meta: cloneMeta(meta),
      rollbackOf: null,
    };
    if (entry.op === "delete") {
      const head = getHeadVersion(getFile(stash, entry.path) as FakeFileRow);
      return {
        path: entry.path,
        requestedOp: "delete",
        input: {
          ...common,
          kind: "delete",
          hash: null,
          size: 0,
          contentType: head.contentType,
          representation: head.representation,
          contentAccess: "deleted",
        },
      };
    }
    const source =
      entry.op === "copy"
        ? getVersion(stash, entry.from.path, entry.from.version)
        : entry.op === "rollback"
          ? getVersion(stash, entry.path, entry.toVersion)
          : undefined;
    if (entry.op !== "put" && (source === undefined || source.hash === null)) {
      return fail("internal", "The fake commit source is unavailable.");
    }
    if (entry.op === "put") {
      if ("bytesBase64" in entry) {
        const bytes = decodeCanonicalBase64(entry.bytesBase64);
        const hash = await sha256Hex(bytes.slice().buffer);
        return {
          path: entry.path,
          requestedOp: "put",
          binaryBody: bytes,
          input: {
            ...common,
            kind: "put",
            hash,
            size: bytes.byteLength,
            contentType: entry.contentType,
            representation: "binary",
            contentAccess: "raw",
          },
        };
      }
      const hash = await sha256Hex(entry.body);
      const size = utf8ByteLength(entry.body);
      return {
        path: entry.path,
        requestedOp: "put",
        textBody: entry.body,
        input: {
          ...common,
          kind: "put",
          hash,
          size,
          contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE,
          representation: "text",
          contentAccess: size <= capabilities.limits.jsonInlineMaxBytes ? "inline" : "raw",
        },
      };
    }
    const sourceRow = source as FakeVersionRow;
    return {
      path: entry.path,
      requestedOp: entry.op,
      input: {
        ...common,
        kind: entry.op === "rollback" ? "rollback" : "put",
        hash: sourceRow.hash,
        size: sourceRow.size,
        contentType: sourceRow.contentType,
        representation: sourceRow.representation,
        contentAccess: sourceRow.contentAccess,
        rollbackOf: entry.op === "rollback" ? sourceRow.version : null,
        ...(entry.op === "copy"
          ? { copiedFrom: { path: entry.from.path, version: entry.from.version } }
          : {}),
      },
    };
  };

  type ApplyCommitOptions = {
    stash: string;
    entries: CommitEntryInput[];
    author: string;
    message: string;
    meta: Record<string, JsonValue>;
    expectedLastChangeId?: number;
    expectedLastChangePrefix?: string;
    expectedLastChangeErrorCode?: "stale" | "commit-conflict";
    idempotencyKey?: string;
    requestHash: string;
    createdBy: string;
    source?: string;
    sourceId?: string | null;
    revertsCommitId?: string | null;
    origin?: string | null;
    publish?: boolean;
  };

  const applyCommit = async (options: ApplyCommitOptions): Promise<FakeCommitRow> => {
    const prefixResult = pathPrefixRange(options.expectedLastChangePrefix);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const prefixRange = prefixResult.range;
    const newestExpectedChangeId = (): number =>
      prefixRange === null
        ? latestChangeId(options.stash)
        : state.versions.reduce(
            (latest, version) =>
              version.stash === options.stash &&
              version.path >= prefixRange.lo &&
              version.path < prefixRange.hi
                ? Math.max(latest, version.changeId)
                : latest,
            0,
          );
    const expectedChangeIsStale = (): boolean => {
      if (options.expectedLastChangeId === undefined) return false;
      const newest = newestExpectedChangeId();
      return prefixRange === null
        ? newest !== options.expectedLastChangeId
        : newest > options.expectedLastChangeId;
    };
    const expectedChangeMessage = (): string => {
      const prefix =
        options.expectedLastChangePrefix === undefined
          ? ""
          : ` for prefix "${options.expectedLastChangePrefix}"`;
      return `Expected last change ${options.expectedLastChangeId}${prefix}, newest change is ${newestExpectedChangeId()}`;
    };
    const expectedChangeErrorCode = options.expectedLastChangeErrorCode ?? "stale";
    if (expectedChangeIsStale()) {
      fail(expectedChangeErrorCode, expectedChangeMessage());
    }
    const conflicts = commitEntryConflicts(options.stash, options.entries);
    if (conflicts.length > 0) throwCommitConflicts(conflicts);
    const createdAt = now();
    const commitId = `cmt_fake_${String(nextChangeId).padStart(8, "0")}`;
    const stampedMeta = { ...options.meta, commitId };
    if (utf8ByteLength(canonicalJson(stampedMeta)) > MAX_META_BYTES) {
      fail("validation", "Stamped commit meta is too large.");
    }
    // Prepare hashes and source references before mutating the in-memory tables. Once this
    // promise settles, the append loop is synchronous, so another request cannot observe a
    // partially applied multi-entry commit.
    const staged = await Promise.all(
      options.entries.map((entry) =>
        stageCommitEntry(
          options.stash,
          entry,
          createdAt,
          options.author,
          options.message,
          stampedMeta,
        ),
      ),
    );
    if (expectedChangeIsStale()) {
      fail(expectedChangeErrorCode, expectedChangeMessage());
    }
    const finalConflicts = commitEntryConflicts(options.stash, options.entries);
    if (finalConflicts.length > 0) throwCommitConflicts(finalConflicts);
    for (const entry of staged) {
      const version = append(options.stash, entry.path, entry.input, {
        commitId,
        createdAt,
        publish: false,
        requestedOp: entry.requestedOp,
      });
      if (entry.textBody !== undefined)
        storeBlob(options.stash, version.hash!, entry.textBody, createdAt);
      if (entry.binaryBody !== undefined)
        storeBinary(options.stash, version.hash!, entry.binaryBody, createdAt);
    }
    const commit = finalizeCommit(commitId, {
      source: options.source ?? "commit",
      sourceId: options.sourceId ?? null,
      author: options.author,
      message: options.message,
      meta: stampedMeta,
      createdBy: options.createdBy,
      revertsCommitId: options.revertsCommitId ?? null,
      requestHash: options.requestHash,
      idempotencyKey: options.idempotencyKey ?? null,
    });
    if (options.publish !== false) emitCommit(commit, options.origin ?? null);
    return commit;
  };

  const commitRequestHash = async (input: CreateCommitBodyType): Promise<string> => {
    const entries = await Promise.all(
      input.entries.map(async (entry) => {
        if (entry.op !== "put") return entry;
        if ("bytesBase64" in entry) {
          const bytes = decodeCanonicalBase64(entry.bytesBase64);
          const { bytesBase64: _bytesBase64, ...rest } = entry;
          return { ...rest, bytesHash: await sha256Hex(bytes.slice().buffer) };
        }
        const { body: _body, ...rest } = entry;
        return { ...rest, bodyHash: await sha256Hex(entry.body) };
      }),
    );
    return sha256Hex(
      canonicalJson({
        entries,
        author: input.author ?? "",
        message: input.message ?? "",
        meta: input.meta ?? {},
        expectedLastChangeId: input.expectedLastChangeId ?? null,
        expectedLastChangePrefix: input.expectedLastChangePrefix ?? null,
      }),
    );
  };

  const findCommitByKey = (stash: string, key: string | undefined): FakeCommitRow | undefined =>
    key === undefined
      ? undefined
      : [...state.commits.values()].find(
          (commit) => commit.stash === stash && commit.idempotencyKey === key,
        );

  const checkCommitReplay = (
    commit: FakeCommitRow | undefined,
    requestHash: string,
  ): Response | undefined => {
    if (commit === undefined) return undefined;
    if (commit.requestHash !== requestHash) {
      return errorResponse(
        new FakeHttpError("idempotency-key-reused", "Idempotency key was used for another request"),
      );
    }
    return json(commitPublic(commit), 201, { "Idempotent-Replayed": "true" });
  };

  const handleCreateCommit = async (
    request: Request,
    stash: string,
    principal: Principal,
  ): Promise<Response> => {
    const candidate = await requestJson(request);
    if (isRecord(candidate) && Array.isArray(candidate.entries)) {
      let inlineBytes = 0;
      for (const entry of candidate.entries) {
        if (!isRecord(entry) || entry.op !== "put") continue;
        if (typeof entry.bytesBase64 === "string") {
          try {
            inlineBytes += decodeCanonicalBase64(entry.bytesBase64).byteLength;
          } catch {
            return fail("validation", "Invalid binary commit body.");
          }
        } else if (typeof entry.body === "string") {
          if (!isWellFormedString(entry.body)) {
            return fail("body-not-well-formed", "Body is not well-formed Unicode.");
          }
          inlineBytes += utf8ByteLength(entry.body);
        }
      }
      if (inlineBytes > MAX_COMMIT_INLINE_BYTES) {
        return fail("payload-too-large", "Commit bodies are too large.");
      }
    }
    const parsed = CreateCommitBody.safeParse(candidate);
    if (!parsed.success) return fail("validation", "Invalid commit input.");
    const prefixResult = pathPrefixRange(parsed.data.expectedLastChangePrefix);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const key = idempotencyKey(request);
    const requestHash = await commitRequestHash(parsed.data);
    const replayed = checkCommitReplay(findCommitByKey(stash, key), requestHash);
    if (replayed !== undefined) return replayed;
    const commit = await applyCommit({
      stash,
      entries: parsed.data.entries,
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? "",
      meta: parsed.data.meta ?? {},
      expectedLastChangeId: parsed.data.expectedLastChangeId,
      expectedLastChangePrefix: parsed.data.expectedLastChangePrefix,
      idempotencyKey: key,
      requestHash,
      createdBy: principalName(principal),
      origin: requestOrigin(request),
    });
    return json(commitPublic(commit), 201);
  };

  const requireCommit = (stash: string, id: string): FakeCommitRow => {
    const commit = state.commits.get(id);
    if (commit === undefined || commit.stash !== stash)
      return fail("not-found", "Commit not found.");
    return commit;
  };

  const handleGetCommit = (stash: string, id: string): Response =>
    json(commitPublic(requireCommit(stash, id)));

  const decodeCursor = (value: string): { createdAt: number; id: string } => {
    let decoded: string;
    try {
      decoded = atob(value);
    } catch {
      return fail("validation", "Invalid commit cursor.");
    }
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (separator < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0 || id.length === 0) {
      return fail("validation", "Invalid commit cursor.");
    }
    return { createdAt, id };
  };

  const decodeChangeSetCursor = (value: string): { createdAt: number; id: string } => {
    let decoded: string;
    try {
      decoded = atob(value);
      if (btoa(decoded) !== value) return fail("validation", "Invalid change-set cursor.");
    } catch {
      return fail("validation", "Invalid change-set cursor.");
    }
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (
      separator < 1 ||
      !Number.isSafeInteger(createdAt) ||
      !CHANGE_SET_ID.test(id) ||
      Number(id.slice(4, 17)) !== createdAt
    ) {
      return fail("validation", "Invalid change-set cursor.");
    }
    return { createdAt, id };
  };

  const handleListCommits = (stash: string, url: URL): Response => {
    const parsed = ListCommitsQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid commit list query.");
    const cursor = parsed.data.after === undefined ? undefined : decodeCursor(parsed.data.after);
    const matching = [...state.commits.values()]
      .filter((commit) => commit.stash === stash)
      .filter(
        (commit) =>
          parsed.data.path === undefined ||
          commit.entries.some((entry) => entry.path === parsed.data.path),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
      )
      .filter((commit) => {
        if (cursor === undefined) return true;
        const createdAt = Date.parse(commit.createdAt);
        return (
          createdAt < cursor.createdAt || (createdAt === cursor.createdAt && commit.id < cursor.id)
        );
      });
    const total = [...state.commits.values()]
      .filter((commit) => commit.stash === stash)
      .filter(
        (commit) =>
          parsed.data.path === undefined ||
          commit.entries.some((entry) => entry.path === parsed.data.path),
      ).length;
    const hasMore = matching.length > parsed.data.limit;
    const page = matching.slice(0, parsed.data.limit);
    return json({
      commits: page.map((commit) => {
        const { entries: _entries, ...summary } = commitPublic(commit);
        return summary;
      }),
      nextAfter:
        hasMore && page.at(-1) !== undefined
          ? btoa(`${Date.parse(page.at(-1)!.createdAt)}:${page.at(-1)!.id}`)
          : null,
      total,
    });
  };

  const handleCommitDiff = (stash: string, id: string, url: URL): Response => {
    const parsed = CommitDiffQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid commit diff query.");
    const commit = requireCommit(stash, id);
    const prefixResult = pathPrefixRange(parsed.data.prefix);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const prefixRange = prefixResult.range;
    const matchesPrefix = (path: string): boolean =>
      prefixRange === null || (path >= prefixRange.lo && path < prefixRange.hi);
    const diffEntry = (
      path: string,
      op: CommitEntryRecord["op"],
      to: FakeVersionRow,
      previous: FakeVersionRow | undefined,
    ): CommitDiffResult["entries"][number] => {
      const from =
        previous === undefined ? null : { version: previous.version, hash: previous.hash };
      let diff: CommitDiffResult["entries"][number]["diff"];
      if (
        (previous?.hash !== null && (previous?.representation ?? "text") === "binary") ||
        (to.hash !== null && (to.representation ?? "text") === "binary")
      ) {
        diff = { state: "binary" };
      } else if (
        (previous?.size ?? 0) > capabilities.limits.diffMaxBytesPerSide ||
        to.size > capabilities.limits.diffMaxBytesPerSide
      ) {
        diff = { state: "oversized" };
      } else {
        diff = computeDiff({
          fromText: previous === undefined || previous.kind === "delete" ? "" : bodyFor(previous),
          toText: to.kind === "delete" ? "" : bodyFor(to),
          fromLabel: `a/${path}@v${String(previous?.version ?? 0)}`,
          toLabel: `b/${path}@v${String(to.version)}`,
          context: parsed.data.context,
          maxBytes: capabilities.limits.diffMaxBytesPerSide,
        });
        if (diff.state === "binary") return fail("internal", "Unexpected binary commit diff.");
      }
      return {
        path,
        op,
        from,
        to: { version: to.version, hash: to.hash },
        diff,
      };
    };

    if (parsed.data.from === undefined) {
      const sourceEntries = commit.entries
        .filter((entry) => parsed.data.path === undefined || entry.path === parsed.data.path)
        .filter((entry) => matchesPrefix(entry.path));
      const truncated =
        parsed.data.path === undefined && sourceEntries.length > COMMIT_DIFF_INLINE_ENTRIES;
      const entries = sourceEntries.slice(0, COMMIT_DIFF_INLINE_ENTRIES).map((entry) => {
        const to = getVersion(stash, entry.path, entry.version);
        if (to === undefined) return fail("internal", "Stored commit content is unavailable.");
        const previous =
          entry.version > 1 ? getVersion(stash, entry.path, entry.version - 1) : undefined;
        return diffEntry(entry.path, entry.op, to, previous);
      });
      return json({ entries, truncated });
    }

    const fromCommit = requireCommit(stash, parsed.data.from.slice("commit:".length));
    const fromChangeId = fromCommit.lastChangeId;
    const toChangeId = commit.lastChangeId;
    if (fromChangeId > toChangeId) {
      return fail("validation", "from must not be newer than the target commit.");
    }
    if (fromChangeId === toChangeId) return json({ entries: [], truncated: false });

    const toByPath = new Map<string, FakeVersionRow>();
    for (const version of state.versions) {
      if (
        version.stash !== stash ||
        version.changeId <= fromChangeId ||
        version.changeId > toChangeId ||
        !matchesPrefix(version.path) ||
        (parsed.data.path !== undefined && version.path !== parsed.data.path)
      ) {
        continue;
      }
      const current = toByPath.get(version.path);
      if (current === undefined || current.changeId < version.changeId) {
        toByPath.set(version.path, version);
      }
    }

    const fromByPath = new Map<string, FakeVersionRow>();
    for (const version of state.versions) {
      if (version.stash !== stash || version.changeId > fromChangeId) continue;
      const current = fromByPath.get(version.path);
      if (current === undefined || current.changeId < version.changeId) {
        fromByPath.set(version.path, version);
      }
    }
    const sourceVersions = [...toByPath.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const truncated =
      parsed.data.path === undefined && sourceVersions.length > COMMIT_DIFF_INLINE_ENTRIES;
    const entries = sourceVersions
      .slice(0, COMMIT_DIFF_INLINE_ENTRIES)
      .map((to) => diffEntry(to.path, operationFor(to), to, fromByPath.get(to.path)));
    return json({ entries, truncated });
  };

  const revertRequestHash = async (id: string, input: ParsedRevertCommitBody): Promise<string> =>
    sha256Hex(
      canonicalJson({
        commitId: id,
        author: input.author ?? "",
        message: input.message ?? `Revert ${id}`,
        meta: input.meta ?? {},
        onto: input.onto,
      }),
    );

  const handleRevertCommit = async (
    request: Request,
    stash: string,
    id: string,
    principal: Principal,
  ): Promise<Response> => {
    const parsed = RevertCommitBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid revert input.");
    const target = requireCommit(stash, id);
    const key = idempotencyKey(request);
    const requestHash = await revertRequestHash(id, parsed.data);
    const prior = findCommitByKey(stash, key);
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        return fail("idempotency-key-reused", "Idempotency key was used for another request.");
      }
      const revertedPaths = new Set(prior.entries.map((entry) => entry.path));
      const skipped = target.entries
        .filter((entry) => !revertedPaths.has(entry.path))
        .map((entry) => ({ path: entry.path, reason: "already-deleted" }));
      return json(
        {
          ...commitPublic(prior),
          ...(skipped.length === 0 ? {} : { skipped }),
        },
        201,
        { "Idempotent-Replayed": "true" },
      );
    }
    const entries: CommitEntryInput[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const entry of target.entries) {
      const file = getFile(stash, entry.path);
      const head = file === undefined ? undefined : getHeadVersion(file);
      const previous =
        entry.version > 1 ? getVersion(stash, entry.path, entry.version - 1) : undefined;
      const shouldDelete = entry.version === 1 || previous?.hash === null || previous === undefined;
      const expectedVersion =
        parsed.data.onto === "head" && head !== undefined ? head.version : entry.version;
      const alreadyDeleted =
        shouldDelete &&
        file?.deleted === true &&
        (parsed.data.onto === "head" || file.headVersion === entry.version);
      if (alreadyDeleted) {
        skipped.push({ path: entry.path, reason: "already-deleted" });
      } else if (shouldDelete) {
        entries.push({ op: "delete", path: entry.path, expectedVersion });
      } else {
        entries.push({
          op: "rollback",
          path: entry.path,
          expectedVersion,
          toVersion: entry.version - 1,
        });
      }
    }
    if (entries.length === 0) return fail("validation", "nothing to revert");
    const commit = await applyCommit({
      stash,
      entries,
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? `Revert ${id}`,
      meta: parsed.data.meta ?? {},
      idempotencyKey: key,
      requestHash,
      createdBy: principalName(principal),
      source: "revert",
      revertsCommitId: id,
      origin: requestOrigin(request),
    });
    return json(
      {
        ...commitPublic(commit),
        ...(skipped.length === 0 ? {} : { skipped }),
      },
      201,
    );
  };

  const changeSetStatus = (row: FakeChangeSetRow): FakeChangeSetRow["status"] =>
    row.status === "open" && row.expiresAt <= now() ? "expired" : row.status;

  const canonicalChangeSetEntries = (
    entries: readonly FakeChangeSetEntryRow[],
  ): FakeChangeSetEntryRow[] =>
    [...entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

  const changeSetRecord = (row: FakeChangeSetRow): ChangeSetRecord => ({
    id: row.id,
    stash: row.stash,
    status: changeSetStatus(row),
    author: row.author,
    message: row.message,
    meta: cloneMeta(row.meta),
    expiresAt: iso(row.expiresAt),
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    commitId: row.commitId,
    entries: canonicalChangeSetEntries(row.entries).map((entry) => ({
      path: entry.path,
      op: entry.op,
      baseVersion: entry.baseVersion,
      current: currentForPath(row.stash, entry.path),
      stale: (getFile(row.stash, entry.path)?.headVersion ?? null) !== entry.baseVersion,
    })),
  });

  const stageChangeSetEntry = (
    stash: string,
    entry: ChangeSetEntryInput,
  ): FakeChangeSetEntryRow => {
    const file = getFile(stash, entry.path);
    if (entry.baseVersion === null) {
      if (file !== undefined)
        return fail(
          "validation",
          `Invalid change-set entry ${entry.path}: the path already exists.`,
        );
    } else {
      if (file === undefined)
        return fail(
          "validation",
          `Invalid change-set entry ${entry.path}: the base path does not exist.`,
        );
      if (getVersion(stash, entry.path, entry.baseVersion) === undefined) {
        return fail(
          "validation",
          `Invalid change-set entry ${entry.path}: the base version does not exist.`,
        );
      }
    }
    if (entry.op === "delete") {
      if (file === undefined || file.deleted) {
        return fail("validation", `Invalid change-set entry ${entry.path}: the path is not live.`);
      }
      return { path: entry.path, op: entry.op, baseVersion: entry.baseVersion };
    }
    if (entry.op === "put") {
      if ("bytesBase64" in entry) {
        const bytes = decodeCanonicalBase64(entry.bytesBase64);
        return {
          path: entry.path,
          op: entry.op,
          baseVersion: entry.baseVersion,
          bytes,
          hash: "",
          size: bytes.byteLength,
          representation: "binary",
          contentType: entry.contentType,
          contentAccess: "raw",
        };
      }
      return {
        path: entry.path,
        op: entry.op,
        baseVersion: entry.baseVersion,
        body: entry.body,
        hash: "",
        size: utf8ByteLength(entry.body),
        representation: "text",
        contentType: entry.contentType ?? DEFAULT_CONTENT_TYPE,
        contentAccess:
          utf8ByteLength(entry.body) <= capabilities.limits.jsonInlineMaxBytes ? "inline" : "raw",
      };
    }
    const sourcePath = entry.op === "copy" ? entry.from.path : entry.path;
    const sourceVersion = entry.op === "copy" ? entry.from.version : entry.toVersion;
    const source = getVersion(stash, sourcePath, sourceVersion);
    if (
      source === undefined ||
      source.hash === null ||
      state.blobs.get(stash)?.get(source.hash) === undefined
    ) {
      return fail(
        "validation",
        `Invalid change-set entry ${entry.path}: source has no content blob.`,
      );
    }
    return {
      path: entry.path,
      op: entry.op,
      baseVersion: entry.baseVersion,
      hash: source.hash,
      size: source.size,
      representation: source.representation,
      contentType: source.contentType,
      contentAccess: source.contentAccess,
      ...(entry.op === "copy"
        ? { copiedFrom: { path: entry.from.path, version: entry.from.version } }
        : { toVersion: entry.toVersion }),
    };
  };

  const changeSetRequestHash = async (input: CreateChangeSetBodyType): Promise<string> =>
    sha256Hex(canonicalJson(input));

  const handleCreateChangeSet = async (
    request: Request,
    stash: string,
    principal: Principal,
  ): Promise<Response> => {
    const candidate = await requestJson(request);
    if (isRecord(candidate) && Array.isArray(candidate.entries)) {
      let inlineBytes = 0;
      for (const entry of candidate.entries) {
        if (!isRecord(entry) || entry.op !== "put") continue;
        if (typeof entry.bytesBase64 === "string") {
          try {
            inlineBytes += decodeCanonicalBase64(entry.bytesBase64).byteLength;
          } catch {
            return fail("validation", "Invalid binary body.");
          }
        } else if (typeof entry.body === "string") {
          if (!isWellFormedString(entry.body))
            return fail("body-not-well-formed", "Body is not well-formed Unicode.");
          inlineBytes += utf8ByteLength(entry.body);
        }
      }
      if (inlineBytes > MAX_COMMIT_INLINE_BYTES)
        return fail("payload-too-large", "Change-set bodies are too large.");
    }
    const parsed = CreateChangeSetBody.safeParse(candidate);
    if (!parsed.success) return fail("validation", "Invalid change-set input.");
    const prefixResult = pathPrefixRange(parsed.data.expectedLastChangePrefix);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const prefixRange = prefixResult.range;
    const newestExpectedChangeId = (): number =>
      prefixRange === null
        ? latestChangeId(stash)
        : state.versions.reduce(
            (latest, version) =>
              version.stash === stash &&
              version.path >= prefixRange.lo &&
              version.path < prefixRange.hi
                ? Math.max(latest, version.changeId)
                : latest,
            0,
          );
    const expectedChangeIsStale = (): boolean => {
      if (parsed.data.expectedLastChangeId === undefined) return false;
      const newest = newestExpectedChangeId();
      return prefixRange === null
        ? newest !== parsed.data.expectedLastChangeId
        : newest > parsed.data.expectedLastChangeId;
    };
    const key = idempotencyKey(request);
    const requestHash = await changeSetRequestHash(parsed.data);
    const prior =
      key === undefined
        ? undefined
        : [...state.changeSets.values()].find(
            (row) => row.stash === stash && row.idempotencyKey === key,
          );
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash)
        return fail(
          "idempotency-key-reused",
          "Idempotency key was already used for a different change set.",
        );
      return json(changeSetRecord(prior), 201, { "Idempotent-Replayed": "true" });
    }
    if (expectedChangeIsStale()) {
      return fail("commit-conflict", "Expected last change is stale.");
    }
    const createdAt = now();
    const expiresAt =
      parsed.data.expiresAt === undefined
        ? createdAt + 14 * 86_400_000
        : Date.parse(parsed.data.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt)
      return fail("validation", "expiresAt must be in the future.");
    const id = `chs_${String(createdAt).padStart(13, "0")}${(nextChangeSetId++).toString(16).padStart(8, "0")}`;
    const meta = { ...(parsed.data.meta ?? {}), changeSetId: id };
    if (utf8ByteLength(canonicalJson(meta)) > MAX_META_BYTES) {
      return fail("validation", "Stamped change-set meta is too large.");
    }
    // Hash and validate every candidate before publishing any blob or change-set row. This keeps
    // create atomic from a consumer's perspective and matches the Worker's staged batch: an
    // invalid later entry must not leave an earlier candidate blob behind.
    const entries = canonicalChangeSetEntries(
      await Promise.all(
        parsed.data.entries.map(async (entry): Promise<FakeChangeSetEntryRow> => {
          const staged = stageChangeSetEntry(stash, entry);
          if (staged.op === "put") {
            if (staged.body !== undefined) staged.hash = await sha256Hex(staged.body);
            else if (staged.bytes !== undefined) {
              staged.hash = await sha256Hex(staged.bytes.slice().buffer);
            }
          }
          return staged;
        }),
      ),
    );
    if (expectedChangeIsStale()) {
      return fail("commit-conflict", "Expected last change is stale.");
    }
    for (const entry of entries) {
      const hash = entry.hash;
      if (entry.op !== "put" || hash === undefined || hash === null || hash === "") continue;
      if (entry.body !== undefined) storeBlob(stash, hash, entry.body, createdAt);
      else if (entry.bytes !== undefined) storeBinary(stash, hash, entry.bytes, createdAt);
    }
    const row: FakeChangeSetRow = {
      id,
      stash,
      status: "open",
      author: parsed.data.author ?? "",
      message: parsed.data.message ?? "",
      meta,
      expiresAt,
      createdBy: principalName(principal),
      createdAt,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      commitId: null,
      expectedLastChangeId: parsed.data.expectedLastChangeId ?? null,
      expectedLastChangePrefix: parsed.data.expectedLastChangePrefix ?? null,
      idempotencyKey: key ?? null,
      requestHash: key === undefined ? null : requestHash,
      entries,
    };
    state.changeSets.set(id, row);
    broadcastEvent(stash, {
      type: "change-set",
      changeSetId: id,
      stash,
      status: "open",
      paths: entries.map((entry) => entry.path),
      origin: requestOrigin(request),
    });
    return json(changeSetRecord(row), 201);
  };

  const handleListChangeSets = (stash: string, url: URL): Response => {
    const parsed = ListChangeSetsQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid change-set query.");
    const status = parsed.data.status;
    const cursor =
      parsed.data.after === undefined ? undefined : decodeChangeSetCursor(parsed.data.after);
    const matchesStatus = (row: FakeChangeSetRow): boolean => {
      const computed = changeSetStatus(row);
      return status === "all" || computed === status;
    };
    const matchesPath = (row: FakeChangeSetRow): boolean =>
      parsed.data.path === undefined ||
      row.entries.some((entry) => entry.path === parsed.data.path);
    const all = [...state.changeSets.values()]
      .filter((row) => row.stash === stash && matchesStatus(row) && matchesPath(row))
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
      )
      .filter((row) => {
        if (cursor === undefined) return true;
        return (
          row.createdAt < cursor.createdAt ||
          (row.createdAt === cursor.createdAt && row.id < cursor.id)
        );
      });
    const total = [...state.changeSets.values()].filter(
      (row) => row.stash === stash && matchesStatus(row) && matchesPath(row),
    ).length;
    const hasMore = all.length > parsed.data.limit;
    const page = all.slice(0, parsed.data.limit);
    return json({
      changeSets: page.map(changeSetRecord),
      nextAfter:
        hasMore && page.at(-1) !== undefined
          ? btoa(`${page.at(-1)!.createdAt}:${page.at(-1)!.id}`)
          : null,
      total,
    });
  };

  const requireChangeSet = (stash: string, id: string): FakeChangeSetRow => {
    if (!CHANGE_SET_ID.test(id)) return fail("validation", "Invalid change-set id.");
    const row = state.changeSets.get(id);
    if (row === undefined || row.stash !== stash) return fail("not-found", "Change set not found.");
    return row;
  };

  const candidateVersion = (
    row: FakeChangeSetRow,
    entry: FakeChangeSetEntryRow,
  ): {
    hash: string | null;
    size: number;
    representation: "text" | "binary";
    body: string | null;
  } => {
    if (entry.op === "delete") return { hash: null, size: 0, representation: "text", body: null };
    if (entry.body !== undefined) {
      return {
        hash: entry.hash ?? null,
        size: entry.size ?? utf8ByteLength(entry.body),
        representation: "text",
        body: entry.body,
      };
    }
    const sourcePath =
      entry.op === "copy"
        ? entry.copiedFrom?.path
        : row.entries.includes(entry)
          ? entry.path
          : undefined;
    const sourceVersion = entry.op === "copy" ? entry.copiedFrom?.version : entry.toVersion;
    const source =
      sourcePath === undefined || sourceVersion === undefined
        ? undefined
        : getVersion(row.stash, sourcePath, sourceVersion);
    const hash = entry.hash ?? source?.hash ?? null;
    const blob = hash === null ? undefined : state.blobs.get(row.stash)?.get(hash);
    return {
      hash,
      size: entry.size ?? source?.size ?? 0,
      representation: entry.representation ?? source?.representation ?? "binary",
      body: blob?.body ?? null,
    };
  };

  const handleGetChangeSet = (stash: string, id: string): Response =>
    json(changeSetRecord(requireChangeSet(stash, id)));

  const handleChangeSetDiff = (stash: string, id: string, url: URL): Response => {
    const parsed = ChangeSetDiffQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid change-set diff query.");
    const row = requireChangeSet(stash, id);
    let sourceEntries = canonicalChangeSetEntries(row.entries);
    if (parsed.data.path !== undefined) {
      sourceEntries = sourceEntries.filter((entry) => entry.path === parsed.data.path);
      if (sourceEntries.length === 0) return fail("not-found", "Change-set entry not found.");
    }
    const aggregateStale = sourceEntries.some(
      (entry) => (getFile(stash, entry.path)?.headVersion ?? null) !== entry.baseVersion,
    );
    const truncated =
      parsed.data.path === undefined && sourceEntries.length > COMMIT_DIFF_INLINE_ENTRIES;
    const entries = sourceEntries.slice(0, COMMIT_DIFF_INLINE_ENTRIES).map((entry) => {
      const baseRow =
        entry.baseVersion === null ? undefined : getVersion(stash, entry.path, entry.baseVersion);
      const headFile = getFile(stash, entry.path);
      const head = headFile === undefined ? null : getHeadVersion(headFile);
      const candidate = candidateVersion(row, entry);
      const candidateCurrent =
        entry.op === "delete"
          ? null
          : {
              version: (entry.baseVersion ?? 0) + 1,
              hash: candidate.hash,
              deleted: false,
              kind: entry.op === "rollback" ? ("rollback" as const) : ("put" as const),
              author: row.author,
              createdAt: iso(row.createdAt),
            };
      let diff: ChangeSetDiffResult["entries"][number]["diff"];
      if (candidate.representation === "binary" || baseRow?.representation === "binary") {
        diff = {
          state: "binary",
          base:
            baseRow?.hash === null || baseRow === undefined
              ? null
              : { hash: baseRow.hash, size: baseRow.size },
          candidate:
            candidate.hash === null ? null : { hash: candidate.hash, size: candidate.size },
        };
      } else if (
        (baseRow?.size ?? 0) > capabilities.limits.diffMaxBytesPerSide ||
        candidate.size > capabilities.limits.diffMaxBytesPerSide
      ) {
        diff = { state: "oversized" };
      } else {
        const candidateText = candidate.body ?? "";
        const computed = computeDiff({
          fromText: baseRow === undefined || baseRow.kind === "delete" ? "" : bodyFor(baseRow),
          toText: candidateText,
          fromLabel:
            entry.baseVersion === null
              ? `a/${entry.path}@empty`
              : `a/${entry.path}@v${entry.baseVersion}`,
          toLabel: `b/${entry.path}@${id}`,
          context: parsed.data.context,
          maxBytes: capabilities.limits.diffMaxBytesPerSide,
        });
        if (computed.state === "binary")
          return fail("internal", "Unexpected binary change-set diff.");
        diff = computed;
      }
      return {
        path: entry.path,
        op: entry.op,
        base:
          baseRow === undefined
            ? null
            : {
                version: baseRow.version,
                hash: baseRow.hash,
                deleted: baseRow.kind === "delete",
                kind: baseRow.kind,
                author: baseRow.author,
                createdAt: iso(baseRow.createdAt),
              },
        candidate: candidateCurrent,
        current: headFile === undefined ? null : current(headFile, head!),
        stale: (headFile?.headVersion ?? null) !== entry.baseVersion,
        diff,
      };
    });
    return json({ entries, stale: aggregateStale, status: changeSetStatus(row), truncated });
  };

  const changeSetApprovalConflicts = (stash: string, row: FakeChangeSetRow): CommitConflict[] => {
    const conflicts: CommitConflict[] = [];
    for (const entry of row.entries) {
      const file = getFile(stash, entry.path);
      const head = file === undefined ? undefined : getHeadVersion(file);
      const present = file === undefined ? null : current(file, head!);
      let refused =
        entry.baseVersion === null
          ? file !== undefined
          : file === undefined || file.headVersion !== entry.baseVersion;
      if (entry.op === "delete" && file?.deleted) refused = true;
      if (entry.op === "put") {
        const blob =
          entry.hash === undefined || entry.hash === null
            ? undefined
            : state.blobs.get(row.stash)?.get(entry.hash);
        if (
          entry.hash === undefined ||
          entry.hash === null ||
          blob === undefined ||
          blob.size !== entry.size
        )
          refused = true;
      } else if (entry.op === "copy" || entry.op === "rollback") {
        const sourcePath = entry.op === "copy" ? entry.copiedFrom?.path : entry.path;
        const sourceVersion = entry.op === "copy" ? entry.copiedFrom?.version : entry.toVersion;
        const source =
          sourcePath === undefined || sourceVersion === undefined
            ? undefined
            : getVersion(row.stash, sourcePath, sourceVersion);
        if (
          source === undefined ||
          source.hash === null ||
          state.blobs.get(row.stash)?.get(source.hash) === undefined
        )
          refused = true;
      }
      if (refused)
        conflicts.push({ path: entry.path, expectedVersion: entry.baseVersion, current: present });
    }
    return conflicts;
  };

  const toCommitInput = (row: FakeChangeSetRow): CommitEntryInput[] =>
    row.entries.map((entry) => {
      if (entry.op === "delete")
        return { op: "delete", path: entry.path, expectedVersion: entry.baseVersion as number };
      if (entry.op === "copy")
        return {
          op: "copy",
          path: entry.path,
          expectedVersion: entry.baseVersion,
          from: entry.copiedFrom!,
        };
      if (entry.op === "rollback")
        return {
          op: "rollback",
          path: entry.path,
          expectedVersion: entry.baseVersion as number,
          toVersion: entry.toVersion!,
        };
      if (entry.representation === "binary") {
        const blob =
          entry.hash === undefined || entry.hash === null
            ? undefined
            : state.blobs.get(row.stash)?.get(entry.hash);
        const bytes = entry.bytes ?? blob?.bytes;
        if (bytes === undefined)
          return fail("internal", "The fake binary candidate is unavailable.");
        return {
          op: "put",
          path: entry.path,
          expectedVersion: entry.baseVersion,
          representation: "binary",
          contentType: entry.contentType!,
          bytesBase64: encodeBase64(bytes),
        };
      }
      const blob =
        entry.hash === undefined || entry.hash === null
          ? undefined
          : state.blobs.get(row.stash)?.get(entry.hash);
      const body = entry.body ?? blob?.body;
      if (body === undefined || body === null) {
        return fail("internal", "The fake text candidate is unavailable.");
      }
      return {
        op: "put",
        path: entry.path,
        expectedVersion: entry.baseVersion,
        body,
        contentType: entry.contentType,
      };
    });

  const handleApproveChangeSet = async (
    request: Request,
    stash: string,
    id: string,
    principal: Principal,
  ): Promise<Response> => {
    const parsed = ApproveChangeSetBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid change-set approval input.");
    const row = requireChangeSet(stash, id);
    if (row.status === "applied" && row.commitId !== null) {
      return json({ status: "applied", commit: commitPublic(requireCommit(stash, row.commitId)) });
    }
    if (row.status !== "open") return fail("change-set-closed", "Change set is already closed.");
    if (row.expiresAt <= now()) return fail("change-set-expired", "Change set has expired.");
    const prefixResult = pathPrefixRange(row.expectedLastChangePrefix ?? undefined);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const prefixRange = prefixResult.range;
    const newestExpectedChangeId = (): number =>
      prefixRange === null
        ? latestChangeId(stash)
        : state.versions.reduce(
            (latest, version) =>
              version.stash === stash &&
              version.path >= prefixRange.lo &&
              version.path < prefixRange.hi
                ? Math.max(latest, version.changeId)
                : latest,
            0,
          );
    const expectedChangeIsStale = (): boolean => {
      if (row.expectedLastChangeId === null) return false;
      const newest = newestExpectedChangeId();
      return prefixRange === null
        ? newest !== row.expectedLastChangeId
        : newest > row.expectedLastChangeId;
    };
    const conflicts = changeSetApprovalConflicts(stash, row);
    if (conflicts.length > 0) {
      const missingDelete =
        conflicts.length === 1 &&
        row.entries.find((entry) => entry.path === conflicts[0]?.path)?.op === "delete";
      throwCommitConflicts(conflicts, missingDelete);
    }
    if (expectedChangeIsStale()) {
      return fail("commit-conflict", "Expected last change is stale.");
    }
    const commit = await applyCommit({
      stash,
      entries: toCommitInput(row),
      author: parsed.data.author ?? row.author,
      message: parsed.data.message ?? row.message,
      meta: row.meta,
      expectedLastChangeId: row.expectedLastChangeId ?? undefined,
      expectedLastChangePrefix: row.expectedLastChangePrefix ?? undefined,
      expectedLastChangeErrorCode: "commit-conflict",
      requestHash: "",
      createdBy: principalName(principal),
      source: "change-set",
      sourceId: id,
      origin: requestOrigin(request),
      publish: false,
    });
    row.status = "applied";
    row.decidedAt = now();
    row.decidedBy = principalName(principal);
    row.decisionReason = null;
    row.commitId = commit.id;
    emitCommit(commit, requestOrigin(request));
    broadcastEvent(stash, {
      type: "change-set",
      changeSetId: id,
      stash,
      status: "applied",
      paths: commit.entries.map((entry) => entry.path),
      origin: requestOrigin(request),
    });
    return json({ status: "applied", commit: commitPublic(commit) });
  };

  const handleRejectChangeSet = async (
    request: Request,
    stash: string,
    id: string,
    principal: Principal,
  ): Promise<Response> => {
    const parsed = RejectChangeSetBody.safeParse(await requestJson(request));
    if (!parsed.success) return fail("validation", "Invalid change-set rejection input.");
    const row = requireChangeSet(stash, id);
    if (row.status !== "open") return fail("change-set-closed", "Change set is already closed.");
    row.status = "rejected";
    row.decidedAt = now();
    row.decidedBy = principalName(principal);
    row.decisionReason = parsed.data.reason ?? null;
    broadcastEvent(stash, {
      type: "change-set",
      changeSetId: id,
      stash,
      status: "rejected",
      paths: row.entries.map((entry) => entry.path),
      origin: requestOrigin(request),
    });
    return json(changeSetRecord(row));
  };

  const handleSnapshot = (stash: string, url: URL): Response => {
    const parsed = SnapshotQuery.safeParse(queryObject(url));
    if (!parsed.success) return fail("validation", "Invalid snapshot query.");
    const selector = parseSnapshotSelector(parsed.data.at);
    if (selector === null) return fail("validation", "Invalid snapshot query.");
    const commit =
      selector.kind === "commit"
        ? requireCommit(stash, selector.commitId)
        : ([...state.commits.values()]
            .filter(
              (candidate) =>
                candidate.stash === stash && candidate.lastChangeId <= selector.changeId,
            )
            .sort((left, right) => right.lastChangeId - left.lastChangeId)[0] ??
          requireCommit(stash, ""));
    const prefixResult = pathPrefixRange(parsed.data.prefix);
    if (!prefixResult.ok) return fail(prefixResult.error, prefixResult.message);
    const prefixRange = prefixResult.range;
    const normalizedPrefix = prefixRange === null ? undefined : prefixRange.lo.slice(0, -1);
    if (parsed.data.delimiter !== undefined && parsed.data.delimiter !== "/")
      return fail("validation", "delimiter must be '/'.");
    const candidatePaths = [
      ...new Set(
        state.versions
          .filter((version) => version.stash === stash && version.changeId <= commit.lastChangeId)
          .map((version) => version.path),
      ),
    ]
      .map((path) => {
        const versions = versionsFor(stash, path).filter(
          (version) => version.changeId <= commit.lastChangeId,
        );
        return versions.sort((left, right) => right.changeId - left.changeId)[0];
      })
      .filter((version): version is FakeVersionRow => version !== undefined)
      .filter((version) => parsed.data.includeDeleted || version.kind !== "delete")
      .filter(
        (version) =>
          prefixRange === null || (version.path >= prefixRange.lo && version.path < prefixRange.hi),
      );
    const values = candidatePaths.map((version) => {
      const relative =
        normalizedPrefix === undefined
          ? version.path
          : version.path.slice(`${normalizedPrefix}/`.length);
      const separator = parsed.data.delimiter === undefined ? -1 : relative.indexOf("/");
      if (separator < 0) return { path: version.path, version };
      return {
        path: `${normalizedPrefix === undefined ? "" : `${normalizedPrefix}/`}${relative.slice(0, separator + 1)}`,
        version: undefined,
      };
    });
    const deduped = [...new Map(values.map((value) => [value.path, value])).values()]
      .filter((value) => parsed.data.after === undefined || value.path > parsed.data.after)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const hasMore = deduped.length > parsed.data.limit;
    const page = deduped.slice(0, parsed.data.limit);
    return json({
      at: { commitId: commit.id, changeId: commit.lastChangeId },
      files: page.flatMap(({ version }) => {
        if (version === undefined) return [];
        return [
          {
            path: version.path,
            headVersion: version.version,
            hash: version.hash,
            size: version.size,
            deleted: version.kind === "delete",
            updatedAt: iso(version.createdAt),
            representation: version.representation ?? "text",
            contentAccess:
              version.kind === "delete" ? "deleted" : (version.contentAccess ?? "inline"),
            contentType: version.contentType,
            byteSize: version.size,
            etag: version.kind === "delete" ? null : version.hash,
          },
        ];
      }),
      ...(parsed.data.delimiter === undefined
        ? {}
        : {
            commonPrefixes: page.flatMap(({ path, version }) =>
              version === undefined ? [path] : [],
            ),
          }),
      nextAfter: hasMore ? (page.at(-1)?.path ?? null) : null,
    });
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
      const principal: Principal =
        match.routeId === "getCapabilities" ? { kind: "admin" } : await authenticate(request);
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
        case "getCapabilities":
          return json(capabilities);
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
        case "createCommit":
          return await handleCreateCommit(request, stash ?? "", principal);
        case "getCommit":
          return handleGetCommit(stash ?? "", match.id ?? "");
        case "listCommits":
          return handleListCommits(stash ?? "", url);
        case "getCommitDiff":
          return handleCommitDiff(stash ?? "", match.id ?? "", url);
        case "revertCommit":
          return await handleRevertCommit(request, stash ?? "", match.id ?? "", principal);
        case "getSnapshot":
          return handleSnapshot(stash ?? "", url);
        case "createChangeSet":
          return await handleCreateChangeSet(request, stash ?? "", principal);
        case "listChangeSets":
          return handleListChangeSets(stash ?? "", url);
        case "getChangeSet":
          return handleGetChangeSet(stash ?? "", match.id ?? "");
        case "getChangeSetDiff":
          return handleChangeSetDiff(stash ?? "", match.id ?? "", url);
        case "approveChangeSet":
          return await handleApproveChangeSet(request, stash ?? "", match.id ?? "", principal);
        case "rejectChangeSet":
          return await handleRejectChangeSet(request, stash ?? "", match.id ?? "", principal);
        case "stashEvents":
          return handleEvents(request, stash ?? "", url);
        case "getRawFile":
        case "headRawFile":
          return handleRaw(request, stash ?? "", path ?? "");
        case "getRawVersion":
        case "headRawVersion":
          return handleRaw(request, stash ?? "", path ?? "", match.version);
        case "createUploadSession":
          return await handleCreateUpload(request, stash ?? "", path ?? "", principal);
        case "getUploadSession": {
          const session = requireUpload(stash ?? "", match.sessionId ?? "", principal);
          return json({ ...uploadRecord(session), parts: sessionParts(session) });
        }
        case "uploadSingleContent":
          return await handleUploadBytes(
            request,
            requireUpload(stash ?? "", match.sessionId ?? "", principal),
          );
        case "uploadPart":
          return await handleUploadBytes(
            request,
            requireUpload(stash ?? "", match.sessionId ?? "", principal),
            match.partNumber,
          );
        case "completeUploadSession":
          return await handleCompleteUpload(
            request,
            requireUpload(stash ?? "", match.sessionId ?? "", principal),
          );
        case "resumeUploadSession":
          return await handleCompleteUpload(
            request,
            requireUpload(stash ?? "", match.sessionId ?? "", principal),
            true,
          );
        case "abortUploadSession": {
          const session = requireUpload(stash ?? "", match.sessionId ?? "", principal);
          const key = idempotencyKey(request) ?? null;
          const parsed = AbortUploadSessionBody.safeParse(await requestJson(request));
          if (!parsed.success || parsed.data.generation !== session.attemptGeneration)
            return fail("validation", "Invalid upload abort input.");
          if (session.state === "aborted" && session.abortKey === key)
            return json({ id: session.id, state: "aborted" }, 200, {
              "Idempotent-Replayed": "true",
            });
          if (session.state === "committed" || session.state === "aborted")
            return fail("upload-session-not-open", "Upload session cannot be aborted.");
          session.state = "aborted";
          session.abortKey = key;
          return json({ id: session.id, state: "aborted" });
        }
        case "listFiles":
          return handleListFiles(stash ?? "", url);
        case "getFile":
          return handleGetFile(request, stash ?? "", path ?? "", url);
        case "putFile":
          return await handlePut(request, stash ?? "", path ?? "", principal);
        case "deleteFile":
          return await handleDelete(request, stash ?? "", path ?? "", principal);
        case "rollbackFile":
          return await handleRollback(request, stash ?? "", path ?? "", principal);
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
      state.stashes.clear();
      state.tokens.clear();
      state.blobs.clear();
      state.r2Objects.clear();
      state.files.clear();
      state.versions.length = 0;
      state.commits.clear();
      state.changeSets.clear();
      state.idempotency.clear();
      state.gcRuns.length = 0;
      state.uploadSessions.clear();
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
      nextChangeSetId = 1;
      nextR2ObjectSerial = 1;
      nextGcRun = 1;
      nextGcCursorSerial = 1;
      nextUploadSession = 1;
    },
  };
}

/** The exact route subset modelled by the fake, exported for coverage assertions. */
export const FAKE_SUPPORTED_ROUTE_IDS = [...SUPPORTED_ROUTE_IDS] as readonly RouteId[];
