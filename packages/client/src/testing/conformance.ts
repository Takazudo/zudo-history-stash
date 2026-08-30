import { DIFF_MAX_BYTES, canonicalJson } from "@takazudo/zudo-history-stash-core";
import type { JsonValue, RouteId } from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../transport.js";
import { parseStashEventStream } from "../sse.js";
import type { ConformanceOptions, ConformanceRateLimitTarget, ConformanceReport } from "./types.js";

export const CONFORMANCE_SUPPORTED_ROUTE_IDS = [
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
  "getCapabilities",
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
] as const satisfies readonly RouteId[];

type TraceToken =
  "admin" | "read" | "write" | "expiring" | "successor" | "predecessor" | "foreign" | "none";

interface TraceRequest {
  method: string;
  path: string;
  token?: TraceToken;
  body?: unknown;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
}

interface TraceContext {
  fetch: StashFetch;
  baseUrl: string;
  adminToken: string;
  readToken?: string;
  writeToken?: string;
  expiringToken?: string;
  predecessorToken?: string;
  successorToken?: string;
  foreignToken?: string;
  stash: string;
  foreignStash: string;
  laterStash: string;
  values: Map<string, unknown>;
  exercised: Set<RouteId>;
  advanceTime: ConformanceOptions["advanceTime"];
  configureRateLimit: ConformanceOptions["configureRateLimit"];
}

interface TraceStep {
  name: string;
  routeId: RouteId;
  before?: (context: TraceContext) => void | Promise<void>;
  request: (context: TraceContext) => TraceRequest;
  /** The verifier owns the original streaming body; the runner must never clone it. */
  streaming?: boolean;
  verify: (response: Response, body: unknown, context: TraceContext) => void | Promise<void>;
}

interface PublicTraceStep {
  name: string;
  routeId: RouteId;
}

function traceFailure(step: string, message: string): never {
  throw new Error(`Conformance step "${step}" failed: ${message}`);
}

function record(value: unknown, step: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return traceFailure(step, "expected a JSON object response");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, step: string): unknown[] {
  if (!Array.isArray(value)) return traceFailure(step, "expected a JSON array");
  return value;
}

function stringValue(context: TraceContext, key: string, step: string): string {
  const value = context.values.get(key);
  if (typeof value !== "string") return traceFailure(step, `missing string trace value ${key}`);
  return value;
}

function numberValue(context: TraceContext, key: string, step: string): number {
  const value = context.values.get(key);
  if (typeof value !== "number") return traceFailure(step, `missing numeric trace value ${key}`);
  return value;
}

function remember(context: TraceContext, key: string, value: unknown): void {
  context.values.set(key, value);
}

function assertStatus(step: string, response: Response, expected: number): void {
  if (response.status !== expected) {
    traceFailure(step, `expected status ${expected}, received ${response.status}`);
  }
}

function assertEqual(step: string, actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    traceFailure(
      step,
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertSubset(step: string, actual: unknown, expected: unknown, path = "body"): void {
  if (Array.isArray(expected)) {
    const actualArray = array(actual, step);
    assertEqual(step, actualArray.length, expected.length, `${path}.length`);
    expected.forEach((item, index) =>
      assertSubset(step, actualArray[index], item, `${path}[${index}]`),
    );
    return;
  }
  if (expected !== null && typeof expected === "object") {
    const actualRecord = record(actual, step);
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (!(key in actualRecord)) traceFailure(step, `${path}.${key} is missing`);
      assertSubset(step, actualRecord[key], value, `${path}.${key}`);
    }
    return;
  }
  assertEqual(step, actual, expected, path);
}

function assertJsonEqual(step: string, actual: unknown, expected: unknown): void {
  const actualCanonical = canonicalJson(actual as JsonValue);
  const expectedCanonical = canonicalJson(expected as JsonValue);
  assertEqual(step, actualCanonical, expectedCanonical, "JSON body");
}

function errorCode(step: string, body: unknown, expected: string): void {
  const error = record(record(body, step).error, step);
  assertEqual(step, error.code, expected, "error.code");
}

function responseStep(
  name: string,
  routeId: RouteId,
  request: (context: TraceContext) => TraceRequest,
  status: number,
  expected: (context: TraceContext) => unknown,
  after?: (body: unknown, response: Response, context: TraceContext) => void,
): TraceStep;
function responseStep(
  name: string,
  routeId: RouteId,
  request: (context: TraceContext) => TraceRequest,
  status: number,
  expected: unknown,
  after?: (body: unknown, response: Response, context: TraceContext) => void,
): TraceStep;
function responseStep(
  name: string,
  routeId: RouteId,
  request: (context: TraceContext) => TraceRequest,
  status: number,
  expected: unknown | ((context: TraceContext) => unknown),
  after?: (body: unknown, response: Response, context: TraceContext) => void,
): TraceStep {
  return {
    name,
    routeId,
    request,
    verify(response, body, context) {
      assertStatus(name, response, status);
      assertSubset(name, body, typeof expected === "function" ? expected(context) : expected);
      after?.(body, response, context);
    },
  };
}

function errorStep(
  name: string,
  routeId: RouteId,
  request: (context: TraceContext) => TraceRequest,
  status: number,
  code: string,
  expected?: (context: TraceContext) => unknown,
): TraceStep {
  return {
    name,
    routeId,
    request,
    verify(response, body, context) {
      assertStatus(name, response, status);
      errorCode(name, body, code);
      if (expected !== undefined) assertSubset(name, body, expected(context));
    },
  };
}

const path = "docs/conformance.txt";
const oversizedPath = "docs/oversized.txt";
const alpha = "alpha\n";
const beta = "beta\n";
const gamma = "gamma\n";

const TRACE: readonly TraceStep[] = [
  responseStep(
    "create primary stash",
    "createStash",
    (context) => ({ method: "POST", path: "/v1/stashes", body: { name: context.stash } }),
    201,
    (context) => ({
      name: context.stash,
      description: "",
      meta: {},
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
    }),
  ),
  errorStep(
    "duplicate stash is rejected",
    "createStash",
    (context) => ({ method: "POST", path: "/v1/stashes", body: { name: context.stash } }),
    409,
    "exists",
  ),
  responseStep(
    "create foreign stash",
    "createStash",
    (context) => ({
      method: "POST",
      path: "/v1/stashes",
      body: { name: context.foreignStash },
    }),
    201,
    (context) => ({ name: context.foreignStash }),
  ),
  responseStep(
    "create later stash for keyset pagination",
    "createStash",
    (context) => ({
      method: "POST",
      path: "/v1/stashes",
      body: { name: context.laterStash },
    }),
    201,
    (context) => ({ name: context.laterStash }),
  ),
  {
    name: "stash list exposes a keyset continuation",
    routeId: "listStashes",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes?limit=1&after=${context.stash}`,
    }),
    verify(response, body, context) {
      const step = "stash list exposes a keyset continuation";
      assertStatus(step, response, 200);
      const value = record(body, step);
      const stashes = array(value.stashes, step);
      assertEqual(step, stashes.length, 1, "stashes.length");
      const first = record(stashes[0], step);
      if (
        typeof first.name !== "string" ||
        first.name <= context.stash ||
        first.name > context.foreignStash
      ) {
        traceFailure(
          step,
          "first row must be after the supplied cursor and no later than the known foreign stash",
        );
      }
      // The trace creates both -foreign and -later after the primary name, so at least one row
      // necessarily remains even when unrelated persisted stashes interleave with them.
      assertEqual(step, value.nextAfter, first.name, "nextAfter");
      remember(context, "stashPaginationCursor", first.name);
    },
  },
  {
    name: "stash list continues after its keyset",
    routeId: "listStashes",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes?limit=1&after=${stringValue(
        context,
        "stashPaginationCursor",
        "stash list continues after its keyset",
      )}`,
    }),
    verify(response, body, context) {
      const step = "stash list continues after its keyset";
      assertStatus(step, response, 200);
      const value = record(body, step);
      const stashes = array(value.stashes, step);
      assertEqual(step, stashes.length, 1, "stashes.length");
      const row = record(stashes[0], step);
      const cursor = stringValue(context, "stashPaginationCursor", step);
      const upperBound = cursor < context.foreignStash ? context.foreignStash : context.laterStash;
      if (typeof row.name !== "string" || row.name <= cursor || row.name > upperBound) {
        traceFailure(
          step,
          "continued row must be after the cursor and no later than the next known trace stash",
        );
      }
      if (row.name < context.laterStash) {
        // The created -later row proves another page exists in this branch.
        assertEqual(step, value.nextAfter, row.name, "nextAfter");
      } else if (value.nextAfter !== null && value.nextAfter !== row.name) {
        traceFailure(step, "nextAfter must be null or the returned last row name");
      }
    },
  },
  responseStep(
    "get stash returns its aggregate",
    "getStash",
    (context) => ({ method: "GET", path: `/v1/stashes/${context.stash}` }),
    200,
    (context) => ({
      name: context.stash,
      description: "",
      meta: {},
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
    }),
  ),
  {
    name: "create read token returns its secret once",
    routeId: "createToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens`,
      body: { label: "conformance-read", scope: "read" },
    }),
    verify(response, body, context) {
      const step = "create read token returns its secret once";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, { label: "conformance-read", scope: "read" });
      if (typeof value.id !== "string") traceFailure(step, "missing token id");
      if (typeof value.token !== "string" || !/^zhs_[A-Za-z0-9_-]{43}$/.test(value.token)) {
        traceFailure(step, "missing or malformed token secret");
      }
      if (typeof value.createdAt !== "string") traceFailure(step, "missing createdAt");
      assertJsonEqual(step, value, {
        id: value.id,
        token: value.token,
        label: "conformance-read",
        scope: "read",
        createdAt: value.createdAt,
        expiresAt: null,
        rotatedFrom: null,
      });
      context.readToken = value.token;
      remember(context, "readToken", value.token);
      remember(context, "readTokenId", value.id);
      remember(context, "readTokenCreatedAt", value.createdAt);
    },
  },
  {
    name: "create write token returns its secret once",
    routeId: "createToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens`,
      body: { label: "conformance-write", scope: "write" },
    }),
    verify(response, body, context) {
      const step = "create write token returns its secret once";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, { label: "conformance-write", scope: "write" });
      if (typeof value.id !== "string") traceFailure(step, "missing token id");
      if (typeof value.token !== "string" || !/^zhs_[A-Za-z0-9_-]{43}$/.test(value.token)) {
        traceFailure(step, "missing or malformed token secret");
      }
      if (typeof value.createdAt !== "string") traceFailure(step, "missing createdAt");
      assertJsonEqual(step, value, {
        id: value.id,
        token: value.token,
        label: "conformance-write",
        scope: "write",
        createdAt: value.createdAt,
        expiresAt: null,
        rotatedFrom: null,
      });
      context.writeToken = value.token;
      remember(context, "writeToken", value.token);
      remember(context, "writeTokenId", value.id);
      remember(context, "writeTokenCreatedAt", value.createdAt);
    },
  },
  {
    name: "token list is newest first and omits secrets",
    routeId: "listTokens",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/tokens`,
    }),
    verify(response, body, context) {
      const step = "token list is newest first and omits secrets";
      assertStatus(step, response, 200);
      const tokens = array(record(body, step).tokens, step).map((value) => record(value, step));
      assertEqual(step, tokens.length, 2, "tokens.length");
      const expectedTokens = [
        {
          id: stringValue(context, "readTokenId", step),
          label: "conformance-read",
          scope: "read",
          createdAt: stringValue(context, "readTokenCreatedAt", step),
          expiresAt: null,
          rotatedFrom: null,
          rotatedTo: null,
          revokedAt: null,
          lastUsedAt: null,
        },
        {
          id: stringValue(context, "writeTokenId", step),
          label: "conformance-write",
          scope: "write",
          createdAt: stringValue(context, "writeTokenCreatedAt", step),
          expiresAt: null,
          rotatedFrom: null,
          rotatedTo: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
      assertJsonEqual(step, tokens, expectedTokens);
      const serialized = JSON.stringify(body);
      for (const token of tokens) {
        if ("token" in token || "tokenHash" in token) {
          traceFailure(step, "listed token exposed a secret or hash");
        }
      }
      if (
        serialized.includes(stringValue(context, "readToken", step)) ||
        serialized.includes(stringValue(context, "writeToken", step))
      ) {
        traceFailure(step, "listed token exposed a minted secret");
      }
    },
  },
  {
    name: "expiring token is usable before its boundary",
    routeId: "createToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens`,
      body: { label: "conformance-expiring", scope: "read", ttlSeconds: 3 },
    }),
    verify(response, body, context) {
      const step = "expiring token is usable before its boundary";
      assertStatus(step, response, 201);
      const value = record(body, step);
      if (typeof value.id !== "string") traceFailure(step, "missing token id");
      if (typeof value.token !== "string" || !/^zhs_[A-Za-z0-9_-]{43}$/.test(value.token)) {
        traceFailure(step, "missing or malformed token secret");
      }
      if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
        traceFailure(step, "missing or malformed expiresAt");
      }
      assertSubset(step, value, {
        label: "conformance-expiring",
        scope: "read",
        expiresAt: value.expiresAt,
        rotatedFrom: null,
      });
      context.expiringToken = value.token;
      remember(context, "expiringTokenExpiresAt", value.expiresAt);
    },
  },
  responseStep(
    "expiring token identity includes its boundary",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "expiring" }),
    200,
    (context) => ({
      principal: "stash",
      stash: context.stash,
      scope: "read",
      expiresAt: stringValue(context, "expiringTokenExpiresAt", "expiring token identity"),
    }),
  ),
  {
    name: "expired token is concealed as unauthorized",
    routeId: "me",
    before: (context) => context.advanceTime(3_100),
    request: () => ({ method: "GET", path: "/v1/me", token: "expiring" }),
    verify(response, body) {
      const step = "expired token is concealed as unauthorized";
      assertStatus(step, response, 401);
      errorCode(step, body, "unauthorized");
    },
  },
  {
    name: "create rotation predecessor with an inherited expiry",
    routeId: "createToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens`,
      body: { label: "conformance-rotate", scope: "read", ttlSeconds: 60 },
    }),
    verify(response, body, context) {
      const step = "create rotation predecessor with an inherited expiry";
      assertStatus(step, response, 201);
      const value = record(body, step);
      if (typeof value.id !== "string") traceFailure(step, "missing token id");
      if (typeof value.token !== "string" || !/^zhs_[A-Za-z0-9_-]{43}$/.test(value.token)) {
        traceFailure(step, "missing or malformed token secret");
      }
      if (typeof value.expiresAt !== "string") traceFailure(step, "missing expiresAt");
      context.predecessorToken = value.token;
      remember(context, "predecessorId", value.id);
      remember(context, "predecessorOriginalExpiry", value.expiresAt);
    },
  },
  {
    name: "rotation creates one successor and truncates predecessor grace",
    routeId: "rotateToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens/${stringValue(
        context,
        "predecessorId",
        "rotation creates one successor and truncates predecessor grace",
      )}/rotate`,
      body: { graceSeconds: 0 },
    }),
    verify(response, body, context) {
      const step = "rotation creates one successor and truncates predecessor grace";
      assertStatus(step, response, 201);
      const value = record(body, step);
      if (typeof value.id !== "string") traceFailure(step, "missing successor id");
      if (typeof value.token !== "string" || !/^zhs_[A-Za-z0-9_-]{43}$/.test(value.token)) {
        traceFailure(step, "missing or malformed successor secret");
      }
      const predecessor = record(value.predecessor, step);
      if (typeof predecessor.expiresAt !== "string") {
        traceFailure(step, "missing predecessor grace expiry");
      }
      assertSubset(step, value, {
        label: "conformance-rotate",
        scope: "read",
        expiresAt: stringValue(context, "predecessorOriginalExpiry", step),
        rotatedFrom: stringValue(context, "predecessorId", step),
        predecessor: {
          id: stringValue(context, "predecessorId", step),
          expiresAt: predecessor.expiresAt,
        },
      });
      context.successorToken = value.token;
      remember(context, "successorId", value.id);
    },
  },
  errorStep(
    "rotation retry names the one successor",
    "rotateToken",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/tokens/${stringValue(
        context,
        "predecessorId",
        "rotation retry names the one successor",
      )}/rotate`,
      body: {},
    }),
    409,
    "already-rotated",
    (context) => ({
      error: { successorId: stringValue(context, "successorId", "rotation retry") },
    }),
  ),
  errorStep(
    "zero-grace predecessor fails authentication",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "predecessor" }),
    401,
    "unauthorized",
  ),
  responseStep(
    "rotation successor authenticates with inherited expiry",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "successor" }),
    200,
    (context) => ({
      principal: "stash",
      stash: context.stash,
      tokenId: stringValue(context, "successorId", "rotation successor identity"),
      scope: "read",
      expiresAt: stringValue(context, "predecessorOriginalExpiry", "rotation successor identity"),
    }),
  ),
  errorStep(
    "token creation rejects a missing stash",
    "createToken",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash.slice(0, 50)}-missing/tokens`,
      body: { scope: "read" },
    }),
    404,
    "not-found",
  ),
  responseStep(
    "read token identity",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "read" }),
    200,
    (context) => ({ principal: "stash", stash: context.stash, scope: "read", expiresAt: null }),
  ),
  responseStep(
    "write token identity",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "write" }),
    200,
    (context) => ({ principal: "stash", stash: context.stash, scope: "write", expiresAt: null }),
  ),
  responseStep(
    "stash token may get its own stash",
    "getStash",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}`,
      token: "read",
    }),
    200,
    (context) => ({ name: context.stash }),
  ),
  errorStep(
    "stash token cannot reach admin setup",
    "createStash",
    () => ({
      method: "POST",
      path: "/v1/stashes",
      token: "read",
      body: { name: "must-stay-hidden" },
    }),
    404,
    "not-found",
  ),
  errorStep(
    "missing bearer token fails closed",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "none" }),
    401,
    "unauthorized",
  ),
  errorStep(
    "read scope cannot write",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/docs/scope.txt`,
      token: "read",
      body: { body: "denied", expectedVersion: null },
    }),
    403,
    "scope",
  ),
  errorStep(
    "foreign stash is concealed",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.foreignStash}/files`,
      token: "read",
    }),
    404,
    "not-found",
  ),
  responseStep(
    "create file",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      token: "write",
      body: {
        body: alpha,
        expectedVersion: null,
        author: "conformance",
        message: "first",
        meta: { z: 1, nested: { b: true, a: false } },
      },
      headers: { "Idempotency-Key": "put-create" },
    }),
    201,
    { version: 1, size: 6 },
    (body, _response, context) => {
      const value = record(body, "create file");
      remember(context, "firstHash", value.hash);
      remember(context, "firstChange", value.changeId);
      remember(context, "putCreateResponse", body);
    },
  ),
  {
    name: "events replay the committed change through ready",
    routeId: "stashEvents",
    streaming: true,
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/events?since=0`,
      token: "read",
    }),
    async verify(response, _body, context) {
      const step = "events replay the committed change through ready";
      assertStatus(step, response, 200);
      assertEqual(
        step,
        response.headers.get("Content-Type")?.split(";", 1)[0],
        "text/event-stream",
        "Content-Type",
      );
      const body = response.body;
      if (body === null) return traceFailure(step, "missing event stream body");
      const iterator = parseStashEventStream(body)[Symbol.asyncIterator]();
      try {
        const replayed = await iterator.next();
        const ready = await iterator.next();
        assertSubset(step, replayed.value, {
          id: String(numberValue(context, "firstChange", step)),
          event: {
            type: "change",
            changeId: numberValue(context, "firstChange", step),
            stash: context.stash,
            path,
            version: 1,
            kind: "put",
            origin: null,
          },
        });
        assertSubset(step, ready.value, {
          event: {
            type: "ready",
            head: numberValue(context, "firstChange", step),
            checkpoint: numberValue(context, "firstChange", step),
          },
        });
      } finally {
        await iterator.return?.();
      }
    },
  },
  {
    name: "replay preserves create status and body",
    routeId: "putFile",
    request: (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: {
        body: alpha,
        expectedVersion: null,
        author: "conformance",
        message: "first",
        meta: { nested: { a: false, b: true }, z: 1 },
      },
      headers: { "Idempotency-Key": "put-create" },
    }),
    verify(response, body, context) {
      assertStatus("replay preserves create status and body", response, 201);
      assertEqual(
        "replay preserves create status and body",
        response.headers.get("Idempotent-Replayed"),
        "true",
        "Idempotent-Replayed",
      );
      assertJsonEqual(
        "replay preserves create status and body",
        body,
        context.values.get("putCreateResponse"),
      );
    },
  },
  errorStep(
    "idempotency key reuse is rejected",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: "different", expectedVersion: null },
      headers: { "Idempotency-Key": "put-create" },
    }),
    422,
    "idempotency-key-reused",
  ),
  errorStep(
    "create-only detects an existing head",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: beta, expectedVersion: null },
    }),
    409,
    "exists",
    (context) => ({
      current: { version: 1, hash: stringValue(context, "firstHash", "existing head") },
    }),
  ),
  errorStep(
    "CAS precedes skip-if-unchanged",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: alpha, expectedVersion: 99, skipIfUnchanged: true },
    }),
    409,
    "stale",
    () => ({ current: { version: 1 } }),
  ),
  responseStep(
    "read live head with ETag",
    "getFile",
    (context) => ({ method: "GET", path: `/v1/stashes/${context.stash}/files/${path}` }),
    200,
    (context) => ({
      path,
      version: 1,
      hash: stringValue(context, "firstHash", "read live head"),
      size: 6,
      kind: "put",
      deleted: false,
      body: alpha,
      meta: { nested: { a: false, b: true }, z: 1 },
    }),
    (_body, response, context) => {
      const etag = response.headers.get("ETag");
      if (etag === null) traceFailure("read live head with ETag", "missing ETag header");
      remember(context, "etag", etag);
      assertEqual(
        "read live head with ETag",
        response.headers.get("X-Stash-Version"),
        "1",
        "X-Stash-Version",
      );
    },
  ),
  {
    name: "weak comma-list ETag returns 304",
    routeId: "getFile",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      headers: { "If-None-Match": `"other", W/${stringValue(context, "etag", "etag 304")}` },
    }),
    async verify(response) {
      assertStatus("weak comma-list ETag returns 304", response, 304);
      assertEqual("weak comma-list ETag returns 304", await response.text(), "", "body");
      assertEqual(
        "weak comma-list ETag returns 304",
        response.headers.get("X-Stash-Version"),
        "1",
        "X-Stash-Version",
      );
    },
  },
  responseStep(
    "list files",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files?limit=1`,
    }),
    200,
    { files: [{ path, headVersion: 1, size: 6, deleted: false }], nextAfter: null },
  ),
  responseStep(
    "update file",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: beta, expectedVersion: 1, author: "conformance" },
      headers: { "Idempotency-Key": "put-update" },
    }),
    201,
    { version: 2, size: 5 },
    (body, _response, context) => {
      const value = record(body, "update file");
      remember(context, "secondHash", value.hash);
      remember(context, "secondChange", value.changeId);
    },
  ),
  responseStep(
    "unchanged write does not append",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: beta, expectedVersion: 2, skipIfUnchanged: true },
      headers: { "Idempotency-Key": "unchanged-is-not-ledgered" },
    }),
    200,
    { unchanged: true, version: 2 },
  ),
  responseStep(
    "delete claims the key skipped by unchanged",
    "deleteFile",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/delete/${path}`,
      body: { expectedVersion: 2, author: "conformance", message: "remove" },
      headers: { "Idempotency-Key": "unchanged-is-not-ledgered" },
    }),
    200,
    { version: 3 },
    (body, _response, context) => {
      remember(context, "deleteResponse", body);
      remember(context, "deleteChange", record(body, "delete file").changeId);
    },
  ),
  {
    name: "delete replay preserves original 200 status",
    routeId: "deleteFile",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/delete/${path}`,
      body: { expectedVersion: 2, author: "conformance", message: "remove" },
      headers: { "Idempotency-Key": "unchanged-is-not-ledgered" },
    }),
    verify(response, body, context) {
      assertStatus("delete replay preserves original 200 status", response, 200);
      assertEqual(
        "delete replay preserves original 200 status",
        response.headers.get("Idempotent-Replayed"),
        "true",
        "Idempotent-Replayed",
      );
      assertJsonEqual(
        "delete replay preserves original 200 status",
        body,
        context.values.get("deleteResponse"),
      );
    },
  },
  errorStep(
    "deleted head is concealed as file-deleted",
    "getFile",
    (context) => ({ method: "GET", path: `/v1/stashes/${context.stash}/files/${path}` }),
    404,
    "file-deleted",
    () => ({ current: { version: 3, hash: null, deleted: true, kind: "delete" } }),
  ),
  errorStep(
    "create-only remains exists on a tombstoned path",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: gamma, expectedVersion: null },
    }),
    409,
    "exists",
    () => ({ current: { version: 3, hash: null, deleted: true } }),
  ),
  errorStep(
    "deleting a matching tombstone reports already-deleted",
    "deleteFile",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/delete/${path}`,
      body: { expectedVersion: 3 },
    }),
    409,
    "already-deleted",
    () => ({ current: { version: 3, hash: null, deleted: true } }),
  ),
  responseStep(
    "default file list hides tombstones",
    "listFiles",
    (context) => ({ method: "GET", path: `/v1/stashes/${context.stash}/files` }),
    200,
    { files: [], nextAfter: null },
  ),
  responseStep(
    "includeDeleted file list exposes tombstones",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files?includeDeleted=true`,
    }),
    200,
    { files: [{ path, headVersion: 3, hash: null, size: 0, deleted: true }] },
  ),
  responseStep(
    "tombstone representation remains readable by version",
    "getFile",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files/${path}?version=3`,
    }),
    200,
    { path, version: 3, hash: null, size: 0, kind: "delete", deleted: true, body: null },
  ),
  responseStep(
    "candidate diff treats a tombstoned head as empty",
    "diffCandidate",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/diff/${path}`,
      body: { from: "head", body: gamma },
    }),
    200,
    { state: "ready", stats: { added: 1, removed: 0 } },
  ),
  responseStep(
    "put resurrects a tombstoned head",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: { body: gamma, expectedVersion: 3, message: "resurrect" },
      headers: { "Idempotency-Key": "resurrect" },
    }),
    201,
    { version: 4, size: 6 },
    (body, _response, context) => {
      remember(context, "fourthChange", record(body, "resurrection").changeId);
    },
  ),
  responseStep(
    "stored diff treats a tombstone as empty",
    "getDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/diff/${path}?from=3&to=head`,
    }),
    200,
    {
      state: "ready",
      from: { version: 3, hash: null, deleted: true },
      to: { version: 4, deleted: false },
      stats: { added: 1, removed: 0 },
    },
  ),
  errorStep(
    "rollback to tombstone is rejected",
    "rollbackFile",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/rollback/${path}`,
      body: { toVersion: 3, expectedVersion: 4 },
    }),
    422,
    "rollback-target-tombstone",
  ),
  responseStep(
    "rollback appends a new version",
    "rollbackFile",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/rollback/${path}`,
      body: { toVersion: 1, expectedVersion: 4, author: "conformance" },
      headers: { "Idempotency-Key": "rollback" },
    }),
    201,
    (context) => ({
      version: 5,
      hash: stringValue(context, "firstHash", "rollback"),
      rollbackOf: 1,
      identicalToHead: false,
    }),
    (body, _response, context) => {
      remember(context, "rollbackResponse", body);
      remember(context, "fifthChange", record(body, "rollback").changeId);
    },
  ),
  {
    name: "rollback replay preserves original 201 status",
    routeId: "rollbackFile",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/rollback/${path}`,
      body: { toVersion: 1, expectedVersion: 4, author: "conformance" },
      headers: { "Idempotency-Key": "rollback" },
    }),
    verify(response, body, context) {
      assertStatus("rollback replay preserves original 201 status", response, 201);
      assertEqual(
        "rollback replay preserves original 201 status",
        response.headers.get("Idempotent-Replayed"),
        "true",
        "Idempotent-Replayed",
      );
      assertJsonEqual(
        "rollback replay preserves original 201 status",
        body,
        context.values.get("rollbackResponse"),
      );
    },
  },
  responseStep(
    "identical rollback still appends",
    "rollbackFile",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/rollback/${path}`,
      body: { toVersion: 1, expectedVersion: 5 },
    }),
    201,
    { version: 6, rollbackOf: 1, identicalToHead: true },
    (body, _response, context) => {
      remember(context, "sixthChange", record(body, "identical rollback").changeId);
    },
  ),
  {
    name: "old put replay wins after the head moved",
    routeId: "putFile",
    request: (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${path}`,
      body: {
        body: alpha,
        expectedVersion: null,
        author: "conformance",
        message: "first",
        meta: { nested: { b: true, a: false }, z: 1 },
      },
      headers: { "Idempotency-Key": "put-create" },
    }),
    verify(response, body, context) {
      assertStatus("old put replay wins after the head moved", response, 201);
      assertEqual(
        "old put replay wins after the head moved",
        response.headers.get("Idempotent-Replayed"),
        "true",
        "Idempotent-Replayed",
      );
      assertJsonEqual(
        "old put replay wins after the head moved",
        body,
        context.values.get("putCreateResponse"),
      );
    },
  },
  responseStep(
    "history is newest-first and paged",
    "getHistory",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/history/${path}?limit=2`,
    }),
    200,
    {
      path,
      headVersion: 6,
      deleted: false,
      total: 6,
      versions: [
        { version: 6, kind: "rollback", rollbackOf: 1 },
        { version: 5, kind: "rollback", rollbackOf: 1 },
      ],
      nextBefore: 5,
    },
  ),
  responseStep(
    "history keyset continues below before",
    "getHistory",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/history/${path}?limit=2&before=5`,
    }),
    200,
    { versions: [{ version: 4 }, { version: 3 }], nextBefore: 3 },
  ),
  responseStep(
    "changes since cursor is ascending",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?since=0&limit=2`,
    }),
    200,
    (context) => ({
      changes: [
        { changeId: numberValue(context, "firstChange", "changes since"), version: 1 },
        { changeId: numberValue(context, "secondChange", "changes since"), version: 2 },
      ],
      nextSince: numberValue(context, "secondChange", "changes since"),
      hasMore: true,
    }),
  ),
  responseStep(
    "changes since cursor continues forward",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?since=${numberValue(context, "secondChange", "changes continue")}&limit=10`,
    }),
    200,
    {
      changes: [{ version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }],
      nextSince: null,
      hasMore: false,
    },
  ),
  responseStep(
    "changes newest page is descending",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?limit=2`,
    }),
    200,
    (context) => ({
      changes: [
        { changeId: numberValue(context, "sixthChange", "changes newest"), version: 6 },
        { changeId: numberValue(context, "fifthChange", "changes newest"), version: 5 },
      ],
      nextBefore: numberValue(context, "fifthChange", "changes newest"),
      hasMore: true,
    }),
  ),
  responseStep(
    "changes before cursor continues backward",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?before=${numberValue(context, "fifthChange", "changes before")}&limit=2`,
    }),
    200,
    { changes: [{ version: 4 }, { version: 3 }], hasMore: true },
  ),
  responseStep(
    "stored diff reports same content across versions",
    "getDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/diff/${path}?from=1&to=5`,
    }),
    200,
    { state: "same", from: { version: 1, deleted: false }, to: { version: 5, deleted: false } },
  ),
  responseStep(
    "stored diff reports ready hunks",
    "getDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/diff/${path}?from=2&to=head&context=1`,
    }),
    200,
    { state: "ready", truncated: false, stats: { added: 1, removed: 1 } },
  ),
  responseStep(
    "stored diff truncates unified output at line boundaries",
    "getDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/diff/${path}?from=2&to=5&maxUnifiedBytes=1`,
    }),
    200,
    { state: "ready", unified: "", truncated: true },
  ),
  responseStep(
    "candidate diff reports same",
    "diffCandidate",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/diff/${path}`,
      body: { from: "head", body: alpha },
    }),
    200,
    { state: "same" },
  ),
  responseStep(
    "read token may call candidate POST capability",
    "diffCandidate",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/diff/${path}`,
      token: "read",
      body: { from: "head", body: alpha },
    }),
    200,
    { state: "same" },
  ),
  responseStep(
    "candidate diff reports ready",
    "diffCandidate",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/diff/${path}`,
      body: { from: "head", body: "delta\n", context: 0 },
    }),
    200,
    { state: "ready", truncated: false, stats: { added: 1, removed: 1 } },
  ),
  responseStep(
    "create diff-oversized fixture",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/${oversizedPath}`,
      body: { body: "x".repeat(DIFF_MAX_BYTES + 1), expectedVersion: null },
    }),
    201,
    { version: 1, size: DIFF_MAX_BYTES + 1 },
  ),
  responseStep(
    "candidate diff reports oversized bytes",
    "diffCandidate",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/diff/${oversizedPath}`,
      body: { from: "head", body: "small" },
    }),
    200,
    { state: "oversized", reason: "bytes" },
  ),
  responseStep(
    "file list keyset exposes a continuation",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files?limit=1`,
    }),
    200,
    { files: [{ path, headVersion: 6 }], nextAfter: path },
  ),
  {
    name: "multi-entry commit creates atomically",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-commit" },
      body: {
        entries: [
          { op: "put", path: "sdk/alpha.txt", expectedVersion: null, body: "alpha\n" },
          {
            op: "put",
            path: "sdk/beta.bin",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
        author: "conformance",
        message: "multi-entry",
        meta: { suite: "sdk" },
      },
    }),
    verify(response, body, context) {
      const step = "multi-entry commit creates atomically";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, { entryCount: 2, source: "commit" });
      const firstChangeId = value.firstChangeId;
      if (
        typeof firstChangeId !== "number" ||
        !Number.isSafeInteger(firstChangeId) ||
        firstChangeId < 1
      ) {
        traceFailure(step, "firstChangeId must be a positive safe integer");
      }
      if (typeof value.id !== "string") traceFailure(step, "missing commit id");
      remember(context, "sdkCommitId", value.id);
      const entries = array(value.entries, step);
      assertEqual(step, entries.length, 2, "entries.length");
      const firstEntry = record(entries[0], step);
      assertEqual(step, firstEntry.changeId, firstChangeId, "firstChangeId");
      assertSubset(step, entries[1], { path: "sdk/beta.bin", representation: "binary", size: 3 });
    },
  },
  {
    name: "commit replay preserves the atomic result",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-commit" },
      body: {
        entries: [
          { op: "put", path: "sdk/alpha.txt", expectedVersion: null, body: "alpha\n" },
          {
            op: "put",
            path: "sdk/beta.bin",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
        author: "conformance",
        message: "multi-entry",
        meta: { suite: "sdk" },
      },
    }),
    verify(response, body, context) {
      const step = "commit replay preserves the atomic result";
      assertStatus(step, response, 201);
      assertEqual(step, response.headers.get("Idempotent-Replayed"), "true", "replay header");
      assertEqual(
        step,
        record(body, step).id,
        stringValue(context, "sdkCommitId", step),
        "commit id",
      );
    },
  },
  {
    name: "commit conflict exposes per-entry conflicts",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-commit-conflict" },
      body: { entries: [{ op: "put", path: "sdk/alpha.txt", expectedVersion: null, body: "new" }] },
    }),
    verify(response, body) {
      const step = "commit conflict exposes per-entry conflicts";
      assertStatus(step, response, 409);
      errorCode(step, body, "commit-conflict");
      const conflicts = array(record(body, step).conflicts, step);
      assertEqual(step, conflicts.length, 1, "conflicts.length");
      assertSubset(step, conflicts[0], {
        path: "sdk/alpha.txt",
        expectedVersion: null,
        current: { version: 1 },
      });
    },
  },
  responseStep(
    "commit get returns the sealed record",
    "getCommit",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "sdkCommitId", "commit get")}`,
      token: "read",
    }),
    200,
    (context) => ({ id: stringValue(context, "sdkCommitId", "commit get"), entryCount: 2 }),
  ),
  responseStep(
    "commit list includes the multi-entry commit",
    "listCommits",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits?limit=1`,
      token: "read",
    }),
    200,
    (context) => ({
      commits: [{ id: stringValue(context, "sdkCommitId", "commit list") }],
      total: 8,
    }),
  ),
  responseStep(
    "commit diff reports binary and text entries",
    "getCommitDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "sdkCommitId", "commit diff")}/diff`,
      token: "read",
    }),
    200,
    {
      entries: [{ path: "sdk/alpha.txt" }, { path: "sdk/beta.bin", diff: { state: "binary" } }],
      truncated: false,
    },
  ),
  responseStep(
    "revert creates a compensating commit",
    "revertCommit",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "sdkCommitId", "revert")}/revert`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-revert" },
      body: { message: "undo sdk", meta: {} },
    }),
    201,
    (context) => ({
      source: "revert",
      revertsCommitId: stringValue(context, "sdkCommitId", "revert"),
    }),
    (body, _response, context) => remember(context, "sdkRevertId", record(body, "revert").id),
  ),
  {
    name: "create a commit for head-mode revert",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-revert-head-target" },
      body: {
        entries: [
          {
            op: "put",
            path: "sdk/revert-head.txt",
            expectedVersion: null,
            body: "target\n",
          },
        ],
      },
    }),
    verify(response, body, context) {
      const step = "create a commit for head-mode revert";
      assertStatus(step, response, 201);
      remember(context, "sdkHeadRevertTargetId", record(body, step).id);
    },
  },
  responseStep(
    "move the target path after its commit",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/sdk/revert-head.txt`,
      token: "write",
      body: { body: "interfering write\n", expectedVersion: 1 },
    }),
    201,
    { version: 2 },
  ),
  responseStep(
    "head-mode revert overwrites an interfering write",
    "revertCommit",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(
        context,
        "sdkHeadRevertTargetId",
        "head-mode revert",
      )}/revert`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-revert-head" },
      body: { onto: "head" },
    }),
    201,
    (context) => ({
      source: "revert",
      revertsCommitId: stringValue(context, "sdkHeadRevertTargetId", "head-mode revert"),
      entries: [{ path: "sdk/revert-head.txt", op: "delete", version: 3 }],
    }),
  ),
  responseStep(
    "open change set includes binary candidate",
    "createChangeSet",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/change-sets`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-change-set" },
      body: {
        entries: [
          { op: "put", path: "sdk/review.txt", baseVersion: null, body: "review\n" },
          {
            op: "put",
            path: "sdk/review.bin",
            baseVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
        message: "review",
        meta: { suite: "sdk" },
      },
    }),
    201,
    () => ({ status: "open", entries: [{ path: "sdk/review.bin" }, { path: "sdk/review.txt" }] }),
    (body, _response, context) =>
      remember(context, "sdkChangeSetId", record(body, "change set").id),
  ),
  responseStep(
    "change set diff reports candidate state",
    "getChangeSetDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/change-sets/${stringValue(context, "sdkChangeSetId", "change set diff")}/diff`,
      token: "read",
    }),
    200,
    {
      stale: false,
      status: "open",
      entries: [{ path: "sdk/review.bin", diff: { state: "binary" } }, { path: "sdk/review.txt" }],
    },
  ),
  responseStep(
    "change set list includes the open review",
    "listChangeSets",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/change-sets?limit=1`,
      token: "read",
    }),
    200,
    (context) => ({
      changeSets: [{ id: stringValue(context, "sdkChangeSetId", "change set list") }],
      total: 1,
    }),
  ),
  responseStep(
    "change set get returns the open review",
    "getChangeSet",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/change-sets/${stringValue(context, "sdkChangeSetId", "change set get")}`,
      token: "read",
    }),
    200,
    (context) => ({ id: stringValue(context, "sdkChangeSetId", "change set get"), status: "open" }),
  ),
  responseStep(
    "external write makes the change set stale",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/sdk/review.txt`,
      token: "write",
      body: { body: "external\n", expectedVersion: null },
    }),
    201,
    { version: 1 },
  ),
  responseStep(
    "stale change set diff reports staleness",
    "getChangeSetDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/change-sets/${stringValue(context, "sdkChangeSetId", "stale diff")}/diff`,
      token: "read",
    }),
    200,
    { stale: true, status: "open" },
  ),
  {
    name: "stale change set can be rejected",
    routeId: "rejectChangeSet",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/change-sets/${stringValue(context, "sdkChangeSetId", "reject stale")}/reject`,
      token: "write",
      body: { reason: "stale fixture" },
    }),
    verify(response, body) {
      const step = "stale change set can be rejected";
      assertStatus(step, response, 200);
      assertSubset(step, body, { status: "rejected" });
    },
  },
  responseStep(
    "fresh binary change set is approved",
    "createChangeSet",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/change-sets`,
      token: "write",
      body: {
        entries: [
          {
            op: "put",
            path: "sdk/final.bin",
            baseVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
        meta: { suite: "sdk-final" },
      },
    }),
    201,
    { status: "open" },
    (body, _response, context) =>
      remember(context, "sdkFinalChangeSetId", record(body, "fresh change set").id),
  ),
  responseStep(
    "approved change set returns its commit",
    "approveChangeSet",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/change-sets/${stringValue(context, "sdkFinalChangeSetId", "approve")}/approve`,
      token: "write",
      body: { author: "reviewer", message: "approved" },
    }),
    200,
    {
      status: "applied",
      commit: {
        source: "change-set",
        entryCount: 1,
        entries: [{ path: "sdk/final.bin", representation: "binary" }],
      },
    },
    (body, _response, context) => {
      const commit = record(record(body, "approve").commit, "approve commit");
      remember(context, "sdkFinalCommitId", commit.id);
      const entries = array(commit.entries, "approve commit");
      remember(context, "sdkFinalChangeId", record(entries[0], "approve entry").changeId);
    },
  ),
  responseStep(
    "approved commit is readable",
    "getCommit",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "sdkFinalCommitId", "approved commit")}`,
      token: "read",
    }),
    200,
    (context) => ({
      id: stringValue(context, "sdkFinalCommitId", "approved commit"),
      source: "change-set",
    }),
  ),
  responseStep(
    "history and changes carry commit ids",
    "getHistory",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/history/sdk/final.bin`,
      token: "read",
    }),
    200,
    (context) => ({
      versions: [{ commitId: stringValue(context, "sdkFinalCommitId", "history commit") }],
    }),
  ),
  responseStep(
    "change feed carries approved commit id",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?since=${numberValue(context, "sdkFinalChangeId", "change cursor") - 1}`,
      token: "read",
    }),
    200,
    (context) => ({
      changes: [{ commitId: stringValue(context, "sdkFinalCommitId", "change commit") }],
    }),
  ),
  {
    name: "snapshot resolves the approved commit under a prefix",
    routeId: "getSnapshot",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/snapshot?at=commit%3A${encodeURIComponent(stringValue(context, "sdkFinalCommitId", "snapshot"))}&prefix=sdk`,
      token: "read",
    }),
    verify(response, body, context) {
      const step = "snapshot resolves the approved commit under a prefix";
      assertStatus(step, response, 200);
      const value = record(body, step);
      assertSubset(step, value.at, { commitId: stringValue(context, "sdkFinalCommitId", step) });
      const files = array(value.files, step).map((entry) => record(entry, step));
      if (
        !files.some(
          (entry) =>
            entry.path === "sdk/final.bin" && entry.headVersion === 1 && entry.deleted === false,
        )
      ) {
        traceFailure(step, "approved commit snapshot omitted sdk/final.bin");
      }
    },
  },
  {
    name: "prefix fence creates an atomic multi-entry commit",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-fence-site-c1" },
      body: {
        entries: [
          {
            op: "put",
            path: "fence-site/alpha.txt",
            expectedVersion: null,
            body: "alpha-v1\n",
          },
          {
            op: "put",
            path: "fence-site/beta.txt",
            expectedVersion: null,
            body: "beta-v1\n",
          },
        ],
        author: "conformance",
        message: "fence site seed",
        meta: { suite: "fence" },
      },
    }),
    verify(response, body, context) {
      const step = "prefix fence creates an atomic multi-entry commit";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, {
        source: "commit",
        entryCount: 2,
        entries: [{ path: "fence-site/alpha.txt" }, { path: "fence-site/beta.txt" }],
      });
      if (typeof value.id !== "string") traceFailure(step, "missing commit id");
      const firstChangeId = value.firstChangeId;
      const lastChangeId = value.lastChangeId;
      if (
        typeof firstChangeId !== "number" ||
        !Number.isSafeInteger(firstChangeId) ||
        firstChangeId < 1
      ) {
        traceFailure(step, "firstChangeId must be a positive safe integer");
      }
      if (
        typeof lastChangeId !== "number" ||
        !Number.isSafeInteger(lastChangeId) ||
        lastChangeId <= firstChangeId
      ) {
        traceFailure(step, "lastChangeId must be a safe integer after firstChangeId");
      }
      const entries = array(value.entries, step).map((entry) => record(entry, step));
      assertEqual(step, entries.length, 2, "entries.length");
      assertEqual(step, entries[0]?.path, "fence-site/alpha.txt", "entries[0].path");
      assertEqual(step, entries[1]?.path, "fence-site/beta.txt", "entries[1].path");
      assertEqual(step, entries[0]?.changeId, firstChangeId, "entries[0].changeId");
      assertEqual(step, entries[1]?.changeId, lastChangeId, "entries[1].changeId");
      remember(context, "fenceSiteFirstCommitId", value.id);
      remember(context, "fenceSiteFirstChangeId", firstChangeId);
      remember(context, "fenceSiteFirstLastChangeId", lastChangeId);
    },
  },
  {
    name: "unrelated prefix advances the stash cursor",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-fence-docs-c2" },
      body: {
        entries: [
          {
            op: "put",
            path: "fence-docs/unrelated.txt",
            expectedVersion: null,
            body: "unrelated\n",
          },
        ],
        author: "conformance",
        message: "fence docs write",
        meta: { suite: "fence" },
      },
    }),
    verify(response, body, context) {
      const step = "unrelated prefix advances the stash cursor";
      assertStatus(step, response, 201);
      assertSubset(step, body, {
        source: "commit",
        entryCount: 1,
        entries: [{ path: "fence-docs/unrelated.txt" }],
      });
      const value = record(body, step);
      const lastChangeId = value.lastChangeId;
      if (typeof lastChangeId !== "number" || !Number.isSafeInteger(lastChangeId)) {
        traceFailure(step, "lastChangeId must be a safe integer");
      }
      if (lastChangeId <= numberValue(context, "fenceSiteFirstLastChangeId", step)) {
        traceFailure(step, "unrelated prefix did not advance the stash cursor");
      }
    },
  },
  {
    name: "prefix fence accepts an unrelated newer change",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-fence-site-c3" },
      body: {
        entries: [
          {
            op: "put",
            path: "fence-site/alpha.txt",
            expectedVersion: 1,
            body: "alpha-v2\n",
          },
          {
            op: "put",
            path: "fence-site/conditional.txt",
            expectedVersion: null,
            body: "conditional\n",
          },
        ],
        author: "conformance",
        message: "fence site conditional write",
        meta: { suite: "fence" },
        expectedLastChangeId: numberValue(
          context,
          "fenceSiteFirstLastChangeId",
          "prefix fence accepts an unrelated newer change",
        ),
        expectedLastChangePrefix: "fence-site",
      },
    }),
    verify(response, body, context) {
      const step = "prefix fence accepts an unrelated newer change";
      assertStatus(step, response, 201);
      assertSubset(step, body, {
        source: "commit",
        entryCount: 2,
        entries: [
          { path: "fence-site/alpha.txt", version: 2 },
          { path: "fence-site/conditional.txt", version: 1 },
        ],
      });
      const value = record(body, step);
      if (typeof value.id !== "string") traceFailure(step, "missing commit id");
      const lastChangeId = value.lastChangeId;
      if (typeof lastChangeId !== "number" || !Number.isSafeInteger(lastChangeId)) {
        traceFailure(step, "lastChangeId must be a safe integer");
      }
      if (lastChangeId <= numberValue(context, "fenceSiteFirstLastChangeId", step)) {
        traceFailure(step, "conditional write did not advance the site cursor");
      }
      remember(context, "fenceSiteNewestCommitId", value.id);
    },
  },
  {
    name: "prefix fence rejects a stale site cursor without conflicts",
    routeId: "createCommit",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-fence-site-stale" },
      body: {
        entries: [
          {
            op: "put",
            path: "fence-site/alpha.txt",
            expectedVersion: 1,
            body: "alpha-v2\n",
          },
          {
            op: "put",
            path: "fence-site/conditional.txt",
            expectedVersion: null,
            body: "conditional\n",
          },
        ],
        author: "conformance",
        message: "fence site conditional write",
        meta: { suite: "fence" },
        expectedLastChangeId: numberValue(
          context,
          "fenceSiteFirstLastChangeId",
          "prefix fence rejects a stale site cursor without conflicts",
        ),
        expectedLastChangePrefix: "fence-site",
      },
    }),
    verify(response, body) {
      const step = "prefix fence rejects a stale site cursor without conflicts";
      assertStatus(step, response, 409);
      errorCode(step, body, "stale");
      const value = record(body, step);
      if ("conflicts" in value)
        traceFailure(step, "stale response unexpectedly includes conflicts");
    },
  },
  errorStep(
    "prefix fence requires a cursor",
    "createCommit",
    (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/commits`,
      token: "write",
      headers: { "Idempotency-Key": "conformance-fence-prefix-validation" },
      body: {
        entries: [
          {
            op: "put",
            path: "fence-site/validation.txt",
            expectedVersion: null,
            body: "validation\n",
          },
        ],
        expectedLastChangePrefix: "fence-site",
      },
    }),
    400,
    "validation",
  ),
  responseStep(
    "commit diff reports a prefix-scoped range",
    "getCommitDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "fenceSiteNewestCommitId", "prefix range diff")}/diff?from=commit%3A${encodeURIComponent(stringValue(context, "fenceSiteFirstCommitId", "prefix range diff"))}&prefix=fence-site`,
      token: "read",
    }),
    200,
    {
      entries: [
        {
          path: "fence-site/alpha.txt",
          op: "put",
          from: { version: 1 },
          to: { version: 2 },
        },
        {
          path: "fence-site/conditional.txt",
          op: "put",
          from: null,
          to: { version: 1 },
        },
      ],
      truncated: false,
    },
  ),
  responseStep(
    "commit diff equal range is empty",
    "getCommitDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/commits/${stringValue(context, "fenceSiteNewestCommitId", "equal range diff")}/diff?from=commit%3A${encodeURIComponent(stringValue(context, "fenceSiteNewestCommitId", "equal range diff"))}`,
      token: "read",
    }),
    200,
    { entries: [], truncated: false },
  ),
  responseStep(
    "snapshot cursor resolves the previous commit",
    "getSnapshot",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/snapshot?at=change%3A${numberValue(context, "fenceSiteFirstChangeId", "snapshot cursor")}&prefix=fence-site`,
      token: "read",
    }),
    200,
    (context) => ({
      at: {
        commitId: stringValue(context, "sdkFinalCommitId", "snapshot cursor"),
        changeId: numberValue(context, "sdkFinalChangeId", "snapshot cursor"),
      },
      files: [],
    }),
  ),
  errorStep(
    "snapshot rejects a cursor below the first boundary",
    "getSnapshot",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/snapshot?at=change%3A0`,
      token: "read",
    }),
    404,
    "not-found",
  ),
  errorStep(
    "file list rejects an excessive limit",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files?limit=201`,
    }),
    400,
    "validation",
  ),
  errorStep(
    "history rejects an excessive limit",
    "getHistory",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/history/${path}?limit=201`,
    }),
    400,
    "validation",
  ),
  errorStep(
    "changes rejects both cursors",
    "getStashChanges",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/changes?since=0&before=2`,
    }),
    400,
    "validation",
  ),
  errorStep(
    "diff rejects excessive context",
    "getDiff",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/diff/${path}?from=1&to=head&context=11`,
    }),
    400,
    "validation",
  ),
  errorStep(
    "put rejects lone surrogate bodies",
    "putFile",
    (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/docs/surrogate.txt`,
      body: { body: "\ud800", expectedVersion: null },
    }),
    400,
    "body-not-well-formed",
  ),
  errorStep(
    "file route rejects invalid decoded paths",
    "getFile",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files/bad%20path`,
    }),
    400,
    "invalid-path",
  ),
  {
    name: "configured write-principal limit returns retry metadata",
    routeId: "putFile",
    before(context) {
      const target: ConformanceRateLimitTarget = {
        capability: "write",
        key: `p:${stringValue(context, "writeTokenId", "configure write rate limit")}`,
        routeId: "putFile",
        stash: context.stash,
        token: stringValue(context, "writeToken", "configure write rate limit"),
      };
      return context.configureRateLimit(target);
    },
    request: (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/files/docs/rate-limit-probe.txt`,
      token: "write",
      body: {},
    }),
    verify(response, body) {
      const step = "configured write-principal limit returns retry metadata";
      assertStatus(step, response, 429);
      assertEqual(step, response.headers.get("Retry-After"), "60", "Retry-After");
      errorCode(step, body, "rate-limited");
    },
  },
  errorStep(
    "token revocation reports an unknown id",
    "revokeToken",
    (context) => ({
      method: "DELETE",
      path: `/v1/stashes/${context.stash}/tokens/tok_missing`,
    }),
    404,
    "not-found",
  ),
  {
    name: "token revocation returns an empty 204",
    routeId: "revokeToken",
    request: (context) => ({
      method: "DELETE",
      path: `/v1/stashes/${context.stash}/tokens/${stringValue(
        context,
        "readTokenId",
        "token revocation returns an empty 204",
      )}`,
    }),
    async verify(response) {
      const step = "token revocation returns an empty 204";
      assertStatus(step, response, 204);
      assertEqual(step, await response.text(), "", "body");
    },
  },
  errorStep(
    "revoked token fails authentication",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "read" }),
    401,
    "unauthorized",
  ),
  {
    name: "token list reports revocation without exposing secrets",
    routeId: "listTokens",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/tokens`,
    }),
    verify(response, body, context) {
      const step = "token list reports revocation without exposing secrets";
      assertStatus(step, response, 200);
      const tokens = array(record(body, step).tokens, step).map((value) => record(value, step));
      const readId = stringValue(context, "readTokenId", step);
      const read = tokens.find((token) => token.id === readId);
      if (read === undefined) traceFailure(step, "revoked token is missing from the list");
      if (typeof read.revokedAt !== "string") traceFailure(step, "revokedAt is not populated");
      if (typeof read.lastUsedAt !== "string") traceFailure(step, "lastUsedAt is not populated");
      const serialized = JSON.stringify(body);
      if (
        serialized.includes(stringValue(context, "readToken", step)) ||
        serialized.includes(stringValue(context, "writeToken", step)) ||
        serialized.includes("tokenHash")
      ) {
        traceFailure(step, "listed tokens exposed credential material");
      }
    },
  },
  {
    name: "create foreign probe token",
    routeId: "createToken",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.foreignStash}/tokens`,
      body: { label: "conformance-foreign", scope: "read" },
    }),
    verify(response, body, context) {
      const step = "create foreign probe token";
      assertStatus(step, response, 201);
      const value = record(body, step);
      if (typeof value.token !== "string") traceFailure(step, "missing foreign token secret");
      context.foreignToken = value.token;
    },
  },
  {
    name: "delete conceals the live stash and revokes its tokens",
    routeId: "deleteStash",
    request: (context) => ({
      method: "DELETE",
      path: `/v1/stashes/${context.stash}`,
    }),
    verify(response, body, context) {
      const step = "delete conceals the live stash and revokes its tokens";
      assertStatus(step, response, 200);
      const value = record(body, step);
      assertSubset(step, value, { name: context.stash });
      if (typeof value.deletedAt !== "string" || typeof value.restoreUntil !== "string") {
        traceFailure(step, "delete response must include both lifecycle timestamps");
      }
      if (typeof value.revokedTokens !== "number" || value.revokedTokens < 1) {
        traceFailure(step, "delete response must report revoked tokens");
      }
      remember(context, "deletedAt", value.deletedAt);
      remember(context, "restoreUntil", value.restoreUntil);
    },
  },
  {
    name: "deleted stash remains visible only through explicit admin get",
    routeId: "getStash",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}`,
    }),
    verify(response, body, context) {
      const step = "deleted stash remains visible only through explicit admin get";
      assertStatus(step, response, 200);
      const value = record(body, step);
      assertSubset(step, value, {
        name: context.stash,
        deletedAt: stringValue(context, "deletedAt", step),
        restoreUntil: stringValue(context, "restoreUntil", step),
        restorable: true,
      });
    },
  },
  {
    name: "default stash list conceals a deleted stash",
    routeId: "listStashes",
    request: () => ({ method: "GET", path: "/v1/stashes" }),
    verify(response, body, context) {
      const step = "default stash list conceals a deleted stash";
      assertStatus(step, response, 200);
      const stashes = array(record(body, step).stashes, step);
      if (stashes.some((entry) => record(entry, step).name === context.stash)) {
        traceFailure(step, "deleted stash appeared without includeDeleted");
      }
    },
  },
  {
    name: "includeDeleted stash list exposes a deleted stash",
    routeId: "listStashes",
    request: () => ({ method: "GET", path: "/v1/stashes?includeDeleted=true" }),
    verify(response, body, context) {
      const step = "includeDeleted stash list exposes a deleted stash";
      assertStatus(step, response, 200);
      const stashes = array(record(body, step).stashes, step);
      const deleted = stashes.find((entry) => record(entry, step).name === context.stash);
      if (deleted === undefined) traceFailure(step, "deleted stash is missing with includeDeleted");
      assertSubset(step, deleted, {
        deletedAt: stringValue(context, "deletedAt", step),
        restoreUntil: stringValue(context, "restoreUntil", step),
        restorable: true,
      });
    },
  },
  errorStep(
    "deleted stash normal routes are concealed even for admin",
    "listFiles",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/files`,
    }),
    404,
    "not-found",
  ),
  errorStep(
    "former stash token is revoked after deletion",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "write" }),
    401,
    "unauthorized",
  ),
  errorStep(
    "foreign token probing a deleted stash is concealed",
    "getStash",
    (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}`,
      token: "foreign",
    }),
    404,
    "not-found",
  ),
  {
    name: "restore returns the original stash without its old tokens",
    routeId: "restoreStash",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/restore`,
    }),
    verify(response, body, context) {
      const step = "restore returns the original stash without its old tokens";
      assertStatus(step, response, 200);
      assertSubset(step, body, {
        name: context.stash,
        deletedAt: null,
        restoreUntil: null,
        restorable: false,
      });
    },
  },
  errorStep(
    "restored stash does not revive its former token",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "write" }),
    401,
    "unauthorized",
  ),
  errorStep(
    "restored stash name is never recycled",
    "createStash",
    (context) => ({ method: "POST", path: "/v1/stashes", body: { name: context.stash } }),
    409,
    "exists",
  ),
  {
    name: "GC dry run returns a private-safe page",
    routeId: "runGc",
    request: () => ({
      method: "POST",
      path: "/v1/admin/gc",
      body: { kind: "r2-orphans", dryRun: true, maxObjects: 1 },
    }),
    verify(response, body, context) {
      const step = "GC dry run returns a private-safe page";
      assertStatus(step, response, 200);
      const value = record(body, step);
      assertSubset(step, value, {
        jobId: "r2-orphans",
        kind: "r2-orphans",
        dryRun: true,
        deleted: 0,
        error: null,
      });
      if (typeof value.runId !== "string" || !/^[0-9a-f-]{36}$/.test(value.runId)) {
        traceFailure(step, "runId must be a UUID");
      }
      if (typeof value.scanned !== "number" || typeof value.eligible !== "number") {
        traceFailure(step, "GC counters are missing");
      }
      if (value.cursor !== null && typeof value.cursor !== "string") {
        traceFailure(step, "cursor must be nullable and opaque");
      }
      if (typeof value.startedAt !== "string") traceFailure(step, "startedAt is missing");
      remember(context, "gcRunId", value.runId);
    },
  },
  {
    name: "GC run history is newest first and never exposes R2 keys",
    routeId: "listGcRuns",
    request: () => ({ method: "GET", path: "/v1/admin/gc/runs?kind=r2-orphans&limit=10" }),
    verify(response, body, context) {
      const step = "GC run history is newest first and never exposes R2 keys";
      assertStatus(step, response, 200);
      const value = record(body, step);
      const runs = array(value.runs, step);
      const run = runs.find((entry) => record(entry, step).runId === context.values.get("gcRunId"));
      if (run === undefined) traceFailure(step, "the dry-run page is missing from history");
      assertSubset(step, run, { jobId: "r2-orphans", kind: "r2-orphans", dryRun: true });
      const serialized = JSON.stringify(body);
      for (const forbidden of ["r2_key", "r2Key", "v2/"]) {
        if (serialized.includes(forbidden)) traceFailure(step, `history leaked ${forbidden}`);
      }
    },
  },
  {
    name: "ledger GC dry run has its own stable job kind",
    routeId: "runGc",
    request: () => ({
      method: "POST",
      path: "/v1/admin/gc",
      body: { kind: "ledger", dryRun: true, maxObjects: 1 },
    }),
    verify(response, body) {
      const step = "ledger GC dry run has its own stable job kind";
      assertStatus(step, response, 200);
      assertSubset(step, body, { jobId: "ledger", kind: "ledger", dryRun: true, deleted: 0 });
    },
  },
  {
    name: "ledger GC history can be filtered by kind",
    routeId: "listGcRuns",
    request: () => ({ method: "GET", path: "/v1/admin/gc/runs?kind=ledger&limit=10" }),
    verify(response, body) {
      const step = "ledger GC history can be filtered by kind";
      assertStatus(step, response, 200);
      const runs = array(record(body, step).runs, step);
      if (runs.length < 1) traceFailure(step, "ledger dry run is missing from history");
      for (const run of runs) assertSubset(step, run, { jobId: "ledger", kind: "ledger" });
    },
  },
  {
    name: "binary capabilities expose configured transfer limits",
    routeId: "getCapabilities",
    request: () => ({ method: "GET", path: "/v1/capabilities", token: "none" }),
    verify(response, body, context) {
      const step = "binary capabilities expose configured transfer limits";
      assertStatus(step, response, 200);
      const value = record(body, step);
      const limits = record(value.limits, step);
      if (
        typeof limits.singleUploadMaxBytes !== "number" ||
        typeof limits.multipartPartBytes !== "number"
      ) {
        traceFailure(step, "capability limits are missing");
      }
      remember(context, "multipartPartBytes", limits.multipartPartBytes);
    },
  },
  {
    name: "single binary session is metadata-only",
    routeId: "createUploadSession",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/uploads/binary/conformance.bin`,
      headers: { "Idempotency-Key": "conformance-binary-create" },
      body: {
        expectedVersion: null,
        size: 6,
        representation: "binary",
        contentType: "application/octet-stream",
        author: "binary author",
        message: "binary upload",
        meta: { suite: "sdk", transfer: "single" },
        mode: "single",
      },
    }),
    verify(response, body, context) {
      const step = "single binary session is metadata-only";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, {
        state: "open",
        declaredSize: 6,
        representation: "binary",
        mode: "single",
        author: "binary author",
        message: "binary upload",
        meta: { suite: "sdk", transfer: "single" },
      });
      remember(context, "binarySession", value.id);
      remember(context, "binaryGeneration", value.attemptGeneration);
    },
  },
  {
    name: "single upload preserves arbitrary invalid UTF-8 bytes",
    routeId: "uploadSingleContent",
    request: (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("binarySession"))}/content`,
      headers: { "Idempotency-Key": "conformance-binary-content" },
      rawBody: new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]),
    }),
    verify(response, body) {
      assertStatus("single upload preserves arbitrary invalid UTF-8 bytes", response, 202);
      assertSubset("single upload preserves arbitrary invalid UTF-8 bytes", body, {
        state: "uploaded",
        uploadedSize: 6,
      });
    },
  },
  {
    name: "single completion commits exactly one binary version",
    routeId: "completeUploadSession",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("binarySession"))}/complete`,
      headers: { "Idempotency-Key": "conformance-binary-complete" },
      body: { generation: context.values.get("binaryGeneration") },
    }),
    verify(response, body, context) {
      const step = "single completion commits exactly one binary version";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, {
        size: 6,
        representation: "binary",
        contentType: "application/octet-stream",
      });
      remember(context, "binaryVersion", value.version);
    },
  },
  {
    name: "committed upload status remains inspectable",
    routeId: "getUploadSession",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("binarySession"))}`,
    }),
    verify(response, body) {
      assertStatus("committed upload status remains inspectable", response, 200);
      assertSubset("committed upload status remains inspectable", body, {
        state: "committed",
        declaredSize: 6,
      });
    },
  },
  {
    name: "completion resume is idempotent",
    routeId: "resumeUploadSession",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("binarySession"))}/resume`,
      headers: { "Idempotency-Key": "conformance-binary-complete" },
      body: { generation: context.values.get("binaryGeneration") },
    }),
    verify(response, body) {
      assertStatus("completion resume is idempotent", response, 200);
      assertSubset("completion resume is idempotent", body, { state: "committed" });
    },
  },
  {
    name: "raw current download streams exact bytes",
    routeId: "getRawFile",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/raw/binary/conformance.bin`,
    }),
    streaming: true,
    async verify(response) {
      const step = "raw current download streams exact bytes";
      assertStatus(step, response, 200);
      assertEqual(
        step,
        JSON.stringify([...new Uint8Array(await response.arrayBuffer())]),
        JSON.stringify([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]),
        "raw bytes",
      );
    },
  },
  {
    name: "raw HEAD exposes exact current metadata",
    routeId: "headRawFile",
    request: (context) => ({
      method: "HEAD",
      path: `/v1/stashes/${context.stash}/raw/binary/conformance.bin`,
    }),
    verify(response) {
      assertStatus("raw HEAD exposes exact current metadata", response, 200);
      assertEqual(
        "raw HEAD exposes exact current metadata",
        response.headers.get("Content-Length"),
        "6",
        "content length",
      );
    },
  },
  {
    name: "historical raw range is byte exact",
    routeId: "getRawVersion",
    request: (context) => ({
      method: "GET",
      path: `/v1/stashes/${context.stash}/versions/${String(context.values.get("binaryVersion"))}/raw/binary/conformance.bin`,
      headers: { Range: "bytes=1-3" },
    }),
    streaming: true,
    async verify(response) {
      assertStatus("historical raw range is byte exact", response, 206);
      assertEqual(
        "historical raw range is byte exact",
        JSON.stringify([...new Uint8Array(await response.arrayBuffer())]),
        JSON.stringify([0x50, 0x00, 0xff]),
        "range bytes",
      );
    },
  },
  {
    name: "historical raw HEAD exposes version metadata",
    routeId: "headRawVersion",
    request: (context) => ({
      method: "HEAD",
      path: `/v1/stashes/${context.stash}/versions/${String(context.values.get("binaryVersion"))}/raw/binary/conformance.bin`,
    }),
    verify(response, _body, context) {
      assertStatus("historical raw HEAD exposes version metadata", response, 200);
      assertEqual(
        "historical raw HEAD exposes version metadata",
        response.headers.get("X-Stash-Version"),
        String(context.values.get("binaryVersion")),
        "version header",
      );
    },
  },
  {
    name: "multipart session accepts durable replacement parts",
    routeId: "createUploadSession",
    request: (context) => ({
      method: "POST",
      path: `/v1/stashes/${context.stash}/uploads/binary/aborted.bin`,
      headers: { "Idempotency-Key": "conformance-multipart-create" },
      body: {
        expectedVersion: null,
        size: 4,
        representation: "binary",
        contentType: "application/zip",
        author: "multipart author",
        message: "multipart upload",
        meta: { suite: "sdk", transfer: "multipart" },
        mode: "multipart",
        resumable: true,
      },
    }),
    verify(response, body, context) {
      const step = "multipart session accepts durable replacement parts";
      assertStatus(step, response, 201);
      const value = record(body, step);
      assertSubset(step, value, {
        author: "multipart author",
        message: "multipart upload",
        meta: { suite: "sdk", transfer: "multipart" },
      });
      remember(context, "multipartSession", value.id);
      remember(context, "multipartGeneration", value.attemptGeneration);
    },
  },
  {
    name: "multipart part upload reports durable part state",
    routeId: "uploadPart",
    request: (context) => ({
      method: "PUT",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("multipartSession"))}/parts/1?generation=${String(context.values.get("multipartGeneration"))}`,
      rawBody: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    }),
    verify(response, body) {
      assertStatus("multipart part upload reports durable part state", response, 202);
      const parts = array(
        record(body, "multipart multipart part").parts,
        "multipart multipart part",
      );
      assertEqual(
        "multipart part upload reports durable part state",
        parts.length,
        1,
        "durable part count",
      );
    },
  },
  {
    name: "multipart session can be durably aborted",
    routeId: "abortUploadSession",
    request: (context) => ({
      method: "DELETE",
      path: `/v1/stashes/${context.stash}/uploads/${String(context.values.get("multipartSession"))}`,
      headers: { "Idempotency-Key": "conformance-multipart-abort" },
      body: { generation: context.values.get("multipartGeneration") },
    }),
    verify(response, body) {
      assertStatus("multipart session can be durably aborted", response, 200);
      assertSubset("multipart session can be durably aborted", body, { state: "aborted" });
    },
  },
];

/** Stable, serializable trace metadata for coverage and documentation checks. */
export const CONFORMANCE_TRACE: readonly PublicTraceStep[] = TRACE.map(({ name, routeId }) => ({
  name,
  routeId,
}));

function uniqueStashName(prefix: string | undefined): string {
  if (prefix !== undefined) return prefix;
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `conformance-${time}-${random}`;
}

function foreignName(primary: string): string {
  return `${primary.slice(0, 50)}-foreign`;
}

function laterName(primary: string): string {
  return `${primary.slice(0, 50)}-later`;
}

function tokenFor(
  context: TraceContext,
  token: TraceToken | undefined,
  step: string,
): string | undefined {
  if (token === "none") return undefined;
  if (token === "read") {
    if (context.readToken === undefined)
      return traceFailure(step, "read token was not initialized");
    return context.readToken;
  }
  if (token === "write") {
    if (context.writeToken === undefined) {
      return traceFailure(step, "write token was not initialized");
    }
    return context.writeToken;
  }
  if (token === "expiring") {
    if (context.expiringToken === undefined) {
      return traceFailure(step, "expiring token was not initialized");
    }
    return context.expiringToken;
  }
  if (token === "predecessor") {
    if (context.predecessorToken === undefined) {
      return traceFailure(step, "rotation predecessor was not initialized");
    }
    return context.predecessorToken;
  }
  if (token === "successor") {
    if (context.successorToken === undefined) {
      return traceFailure(step, "rotation successor was not initialized");
    }
    return context.successorToken;
  }
  if (token === "foreign") {
    if (context.foreignToken === undefined) {
      return traceFailure(step, "foreign token was not initialized");
    }
    return context.foreignToken;
  }
  return context.adminToken;
}

async function send(context: TraceContext, request: TraceRequest, step: string): Promise<Response> {
  const headers = new Headers(request.headers);
  const token = tokenFor(context, request.token, step);
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  if (request.rawBody !== undefined) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(request.rawBody.byteLength));
  }
  return context.fetch(`${context.baseUrl}${request.path}`, {
    method: request.method,
    headers,
    ...(request.rawBody !== undefined
      ? { body: request.rawBody.slice().buffer }
      : request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
  });
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) return undefined;
  const text = await response.clone().text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Runs the same consumer-facing trace against either the fake or a real Worker. Administrative
 * setup and credential lifecycle checks go through the documented HTTP routes on both targets.
 */
export async function runConformance(
  fetcher: StashFetch,
  baseUrl: string,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const stash = uniqueStashName(options.stashName);
  const context: TraceContext = {
    fetch: fetcher,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    adminToken: options.adminToken,
    stash,
    foreignStash: foreignName(stash),
    laterStash: laterName(stash),
    values: new Map(),
    exercised: new Set(),
    advanceTime: options.advanceTime,
    configureRateLimit: options.configureRateLimit,
  };

  for (let index = 0; index < TRACE.length; index += 1) {
    const step = TRACE[index];
    if (step === undefined) return traceFailure("trace", `missing step ${index}`);
    await step.before?.(context);
    const response = await send(context, step.request(context), step.name);
    if (step.streaming) {
      try {
        await step.verify(response, undefined, context);
      } finally {
        if (response.body !== null && !response.body.locked) {
          try {
            await response.body.cancel();
          } catch {
            // The verifier may already have consumed, cancelled, or errored the original body.
          }
        }
      }
    } else {
      const body = await readBody(response);
      await step.verify(response, body, context);
    }
    context.exercised.add(step.routeId);
  }

  for (const routeId of CONFORMANCE_SUPPORTED_ROUTE_IDS) {
    if (!context.exercised.has(routeId)) {
      traceFailure("route coverage", `supported route ${routeId} was not exercised`);
    }
  }

  return {
    stash: context.stash,
    foreignStash: context.foreignStash,
    exercisedRouteIds: [...context.exercised],
    steps: TRACE.length,
  };
}
