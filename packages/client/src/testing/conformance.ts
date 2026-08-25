import { DIFF_MAX_BYTES, canonicalJson } from "@takazudo/zudo-history-stash-core";
import type { JsonValue, RouteId, TokenScope } from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../client.js";
import type { ConformanceOptions, ConformanceReport } from "./types.js";

export const CONFORMANCE_SUPPORTED_ROUTE_IDS = [
  "me",
  "createStash",
  "listFiles",
  "getFile",
  "putFile",
  "deleteFile",
  "rollbackFile",
  "getHistory",
  "getDiff",
  "diffCandidate",
  "getStashChanges",
] as const satisfies readonly RouteId[];

type TraceToken = "admin" | "read" | "none";

interface TraceRequest {
  method: string;
  path: string;
  token?: TraceToken;
  body?: unknown;
  headers?: Record<string, string>;
}

interface TraceContext {
  fetch: StashFetch;
  baseUrl: string;
  adminToken: string;
  readToken?: string;
  stash: string;
  foreignStash: string;
  values: Map<string, unknown>;
  exercised: Set<RouteId>;
}

interface TraceStep {
  name: string;
  routeId: RouteId;
  request: (context: TraceContext) => TraceRequest;
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
    "read token identity",
    "me",
    () => ({ method: "GET", path: "/v1/me", token: "read" }),
    200,
    (context) => ({ principal: "stash", stash: context.stash, scope: "read" }),
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
  return context.adminToken;
}

async function send(context: TraceContext, request: TraceRequest, step: string): Promise<Response> {
  const headers = new Headers(request.headers);
  const token = tokenFor(context, request.token, step);
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  return context.fetch(`${context.baseUrl}${request.path}`, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
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

async function mintReadToken(
  context: TraceContext,
  mintToken: ((stash: string, scope: TokenScope) => string | Promise<string>) | undefined,
): Promise<string> {
  if (mintToken !== undefined) return mintToken(context.stash, "read");
  const response = await context.fetch(`${context.baseUrl}/v1/stashes/${context.stash}/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "conformance-read", scope: "read" }),
  });
  const body = await readBody(response);
  assertStatus("mint read token setup", response, 201);
  const token = record(body, "mint read token setup").token;
  if (typeof token !== "string") return traceFailure("mint read token setup", "missing token");
  return token;
}

/**
 * Runs the same consumer-facing trace against either the fake or a real Worker. A fake supplies
 * `mintToken`; a real Worker needs only the documented `{ adminToken }` options object.
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
    values: new Map(),
    exercised: new Set(),
  };

  for (let index = 0; index < TRACE.length; index += 1) {
    if (index === 2) context.readToken = await mintReadToken(context, options.mintToken);
    const step = TRACE[index];
    if (step === undefined) return traceFailure("trace", `missing step ${index}`);
    const response = await send(context, step.request(context), step.name);
    const body = await readBody(response);
    await step.verify(response, body, context);
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
