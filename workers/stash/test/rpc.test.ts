import {
  BODY_LIMIT_BYTES,
  MAX_BODY_BYTES,
  sha256Hex as contentSha256Hex,
  type RpcRequest,
} from "@takazudo/zudo-history-stash-core";
import { createStashClient } from "@takazudo/zudo-history-stash";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { createStashStore } from "../src/d1/store.js";
import type { Env } from "../src/env.js";
import { StashRpc } from "../src/rpc.js";
import { resetDatabase } from "./helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "./helpers/env.js";
import {
  RPC_FIXED_NOW,
  RPC_FOREIGN_TOKEN,
  RPC_READ_TOKEN,
  RPC_STASH,
  RPC_WRITE_TOKEN,
  RPC_WRITE_TOKEN_ID,
  seedRpcFixture,
} from "./helpers/rpc.js";

const PARITY_HEADERS = [
  "etag",
  "x-stash-version",
  "idempotent-replayed",
  "content-type",
  "retry-after",
] as const;

const RPC_EXPIRED_TOKEN = `zhs_${"E".repeat(43)}`;
const RPC_EXPIRED_TOKEN_ID = `tok_${"e".repeat(32)}`;
const RPC_MAX_FILE_PATH = "docs/rpc-max.txt";
const RPC_AGGREGATE_FILE_PATH = "docs/rpc-aggregate.txt";

interface ResponseSnapshot {
  status: number;
  body: string;
  headers: Record<(typeof PARITY_HEADERS)[number], string | null>;
}

interface ScenarioState {
  etag?: string;
}

interface ParityScenario {
  name: string;
  expectedStatus: number;
  expectedBody?: string;
  expectedBodyIncludes?: string;
  expectedHeaders?: Partial<ResponseSnapshot["headers"]>;
  seed?: () => Promise<ScenarioState | void>;
  init: RpcRequest | ((state: ScenarioState) => RpcRequest);
  bindings?: () => Env;
}

function acceptsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function requestUrl(init: RpcRequest): string {
  const query = new URLSearchParams(init.query).toString();
  return `https://stash.internal${init.path}${query === "" ? "" : `?${query}`}`;
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  const headers = Object.fromEntries(
    PARITY_HEADERS.map((name) => [name, response.headers.get(name)]),
  ) as ResponseSnapshot["headers"];
  return { status: response.status, body: await response.text(), headers };
}

async function dispatchHttp(init: RpcRequest, bindings: Env): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.set("Authorization", `Bearer ${init.token}`);
  const ctx = createExecutionContext();
  const response = await app.request(
    requestUrl(init),
    {
      method: init.method,
      headers,
      body: acceptsBody(init.method) ? init.body : undefined,
    },
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function dispatchRpc(init: RpcRequest, bindings: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await new StashRpc(ctx, bindings).request(init);
  await waitOnExecutionContext(ctx);
  return response;
}

async function dispatchTransport(
  transport: "http" | "rpc",
  init: RpcRequest,
  bindings: Env,
): Promise<Response> {
  return transport === "http" ? dispatchHttp(init, bindings) : dispatchRpc(init, bindings);
}

async function storageCounts(bindings: Env): Promise<{
  blobs: number;
  files: number;
  objects: number;
  versions: number;
}> {
  const [files, versions, blobs, objects] = await Promise.all([
    bindings.DB.prepare("SELECT COUNT(*) AS count FROM files").first<{ count: number }>(),
    bindings.DB.prepare("SELECT COUNT(*) AS count FROM versions").first<{ count: number }>(),
    bindings.DB.prepare("SELECT COUNT(*) AS count FROM blobs").first<{ count: number }>(),
    bindings.BLOBS.list({ prefix: `v2/${RPC_STASH}/` }),
  ]);
  return {
    files: files?.count ?? -1,
    versions: versions?.count ?? -1,
    blobs: blobs?.count ?? -1,
    objects: objects.objects.length,
  };
}

function aggregateImportBody(): string {
  const escapedBodyPrefix = "\\u0001".repeat(800_000);
  const entries: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    entries.push(
      `{"kind":"put","body":"${escapedBodyPrefix}${String(index)}","createdAt":${String(
        1_000 + index,
      )}}`,
    );
  }
  const body = `{"path":"${RPC_AGGREGATE_FILE_PATH}","expectedVersion":null,"versions":[${entries.join(
    ",",
  )}]}`;
  if (body.length <= BODY_LIMIT_BYTES) throw new Error("Aggregate RPC fixture is not oversized");
  return body;
}

async function putFixture(
  body: string,
  expectedVersion: number | null,
  idempotencyKey?: string,
): Promise<{ hash: string; version: number }> {
  const result = await createStashStore(createTestEnv().env).writes.put(
    RPC_STASH,
    "docs/rpc.txt",
    { body, expectedVersion },
    idempotencyKey === undefined ? undefined : { idempotencyKey },
  );
  if (!result.ok || "unchanged" in result.value) throw new Error("RPC fixture write failed");
  return { hash: result.value.hash, version: result.value.version };
}

async function seedFile(body = "first version\n"): Promise<ScenarioState> {
  const result = await putFixture(body, null);
  return { etag: `"v${result.version}-${result.hash}"` };
}

async function seedTwoVersions(): Promise<void> {
  await putFixture("first version\n", null);
  await putFixture("second version\n", 1);
}

async function seedExpiredTokenAtBoundary(): Promise<void> {
  await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO tokens
         (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
          expires_at, rotated_from, rotated_to)
       VALUES (?, ?, ?, 'fixed expired reader', 'read', ?, NULL, NULL, ?, NULL, NULL)`,
    )
    .bind(
      RPC_EXPIRED_TOKEN_ID,
      RPC_STASH,
      await sha256Hex(RPC_EXPIRED_TOKEN),
      RPC_FIXED_NOW - 1,
      RPC_FIXED_NOW,
    )
    .run();
}

function readLimitedBindings(): Env {
  return createTestEnv({
    env: {
      RL_READ: {
        limit: () => Promise.resolve({ success: false }),
      },
    },
  }).env;
}

function jsonRequest(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  token = "test-admin",
  headers: Record<string, string> = {},
): RpcRequest {
  return {
    method,
    path,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    token,
  };
}

function failingDatabase(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "withSession") {
        return () => {
          throw new Error("forced RPC parity database failure");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const scenarios: ParityScenario[] = [
  {
    name: "health",
    expectedStatus: 200,
    expectedBodyIncludes: '"ok":true',
    init: { method: "GET", path: "/v1/health", token: "unused" },
  },
  {
    name: "me admin",
    expectedStatus: 200,
    expectedBodyIncludes: '"principal":"admin"',
    init: { method: "GET", path: "/v1/me", token: "test-admin" },
  },
  {
    name: "me stash token",
    expectedStatus: 200,
    expectedBodyIncludes: `"stash":"${RPC_STASH}"`,
    init: { method: "GET", path: "/v1/me", token: RPC_WRITE_TOKEN },
  },
  {
    name: "me token expired at exact clock boundary",
    expectedStatus: 401,
    expectedBody: '{"error":{"code":"unauthorized","message":"A valid bearer token is required."}}',
    expectedHeaders: { "content-type": "application/json" },
    seed: seedExpiredTokenAtBoundary,
    init: { method: "GET", path: "/v1/me", token: RPC_EXPIRED_TOKEN },
  },
  {
    name: "me stash principal rate limited",
    expectedStatus: 429,
    expectedBody: '{"error":{"code":"rate-limited","message":"The request was rate limited."}}',
    expectedHeaders: { "content-type": "application/json", "retry-after": "60" },
    init: { method: "GET", path: "/v1/me", token: RPC_READ_TOKEN },
    bindings: readLimitedBindings,
  },
  {
    name: "list stashes with limit and after",
    expectedStatus: 200,
    expectedBodyIncludes: `"name":"${RPC_STASH}"`,
    init: {
      method: "GET",
      path: "/v1/stashes",
      query: { limit: "1", after: "alpha" },
      token: "test-admin",
    },
  },
  {
    name: "create stash",
    expectedStatus: 201,
    expectedBodyIncludes: '"name":"rpc-created"',
    init: jsonRequest("POST", "/v1/stashes", {
      name: "rpc-created",
      description: "created through parity",
      meta: { source: "rpc" },
    }),
  },
  {
    name: "create token",
    expectedStatus: 201,
    expectedBodyIncludes: '"label":"parity token"',
    init: jsonRequest("POST", `/v1/stashes/${RPC_STASH}/tokens`, {
      label: "parity token",
      scope: "read",
    }),
  },
  {
    name: "list files",
    expectedStatus: 200,
    expectedBodyIncludes: '"path":"docs/rpc.txt"',
    seed: seedFile,
    init: { method: "GET", path: `/v1/stashes/${RPC_STASH}/files`, token: RPC_READ_TOKEN },
  },
  {
    name: "get file",
    expectedStatus: 200,
    expectedBodyIncludes: '"body":"first version\\n"',
    expectedHeaders: { "x-stash-version": "1" },
    seed: seedFile,
    init: {
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      token: RPC_READ_TOKEN,
    },
  },
  {
    name: "get file with If-None-Match",
    expectedStatus: 304,
    expectedBody: "",
    expectedHeaders: { "x-stash-version": "1" },
    seed: seedFile,
    init: (state) => ({
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      headers: { "If-None-Match": state.etag ?? "missing fixture etag" },
      token: RPC_READ_TOKEN,
    }),
  },
  {
    name: "put create-only",
    expectedStatus: 201,
    expectedBodyIncludes: '"version":1',
    init: jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      { body: "created over transport\n", expectedVersion: null },
      RPC_WRITE_TOKEN,
    ),
  },
  {
    name: "put stale conflict with current",
    expectedStatus: 409,
    expectedBodyIncludes: '"current":{"version":1',
    seed: seedFile,
    init: jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      { body: "stale write\n", expectedVersion: 2 },
      RPC_WRITE_TOKEN,
    ),
  },
  {
    name: "put idempotency replay",
    expectedStatus: 201,
    expectedBodyIncludes: '"version":1',
    expectedHeaders: { "idempotent-replayed": "true" },
    seed: async () => {
      await putFixture("replayed body\n", null, "rpc-replay");
    },
    init: jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      { body: "replayed body\n", expectedVersion: null },
      RPC_WRITE_TOKEN,
      { "Idempotency-Key": "rpc-replay" },
    ),
  },
  {
    name: "delete file",
    expectedStatus: 200,
    expectedBodyIncludes: '"version":2',
    seed: seedFile,
    init: jsonRequest(
      "POST",
      `/v1/stashes/${RPC_STASH}/delete/docs/rpc.txt`,
      { expectedVersion: 1 },
      RPC_WRITE_TOKEN,
    ),
  },
  {
    name: "revoke token with empty 204 body",
    expectedStatus: 204,
    expectedBody: "",
    init: {
      method: "DELETE",
      path: `/v1/stashes/${RPC_STASH}/tokens/${RPC_WRITE_TOKEN_ID}`,
      token: "test-admin",
    },
  },
  {
    name: "rollback file",
    expectedStatus: 201,
    expectedBodyIncludes: '"rollbackOf":1',
    seed: seedTwoVersions,
    init: jsonRequest(
      "POST",
      `/v1/stashes/${RPC_STASH}/rollback/docs/rpc.txt`,
      { expectedVersion: 2, toVersion: 1 },
      RPC_WRITE_TOKEN,
    ),
  },
  {
    name: "diff GET",
    expectedStatus: 200,
    expectedBodyIncludes: '"state":"ready"',
    seed: seedTwoVersions,
    init: {
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/diff/docs/rpc.txt`,
      query: { from: "1", to: "2", context: "1" },
      token: RPC_READ_TOKEN,
    },
  },
  {
    name: "candidate diff POST",
    expectedStatus: 200,
    expectedBodyIncludes: '"state":"ready"',
    seed: seedTwoVersions,
    init: jsonRequest(
      "POST",
      `/v1/stashes/${RPC_STASH}/diff/docs/rpc.txt`,
      { from: 1, body: "candidate version\n", context: 1 },
      RPC_READ_TOKEN,
    ),
  },
  {
    name: "foreign stash concealment",
    expectedStatus: 404,
    expectedBodyIncludes: '"code":"not-found"',
    init: {
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/files`,
      token: RPC_FOREIGN_TOKEN,
    },
  },
  {
    name: "read token on write route",
    expectedStatus: 403,
    expectedBodyIncludes: '"code":"scope"',
    init: jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/docs/denied.txt`,
      { body: "denied\n", expectedVersion: null },
      RPC_READ_TOKEN,
    ),
  },
  {
    name: "malformed body",
    expectedStatus: 400,
    expectedBodyIncludes: '"code":"validation"',
    init: {
      method: "PUT",
      path: `/v1/stashes/${RPC_STASH}/files/docs/malformed.txt`,
      headers: { "Content-Type": "application/json" },
      body: "{",
      token: RPC_WRITE_TOKEN,
    },
  },
  {
    name: "unexpected handler error",
    expectedStatus: 500,
    expectedBody: '{"error":{"code":"internal","message":"An internal error occurred."}}',
    init: { method: "GET", path: "/v1/stashes", token: "test-admin" },
    bindings: () => {
      const bindings = createTestEnv().env;
      return { ...bindings, DB: failingDatabase(bindings.DB) };
    },
  },
];

function fixedRandomValues<T extends ArrayBufferView | null>(value: T): T {
  if (value === null) return value;
  new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0x11);
  return value;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(RPC_FIXED_NOW);
  vi.spyOn(crypto, "getRandomValues").mockImplementation(fixedRandomValues);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
});

afterEach(() => vi.restoreAllMocks());

describe("StashRpc request construction", () => {
  it("dispatches the exact Request, Env, and context to the singleton app and returns its Response", async () => {
    const expected = new Response("same response", {
      status: 202,
      headers: { "X-Identity": "preserved" },
    });
    const fetchSpy = vi.spyOn(app, "fetch").mockResolvedValueOnce(expected);
    const bindings = createTestEnv().env;
    const ctx = createExecutionContext();
    const suppliedHeaders = {
      AUTHORIZATION: "Bearer ignored",
      "Content-Type": "application/json",
      "X-Probe": "kept",
    };
    const response = await new StashRpc(ctx, bindings).request({
      method: "POST",
      path: "/v1/stashes/rpc-fixture/diff/docs/nested.txt",
      query: { from: "head", label: "a b" },
      headers: suppliedHeaders,
      body: "exact body",
      token: "winner",
    });

    expect(response).toBe(expected);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [request, actualBindings, actualContext] = fetchSpy.mock.calls[0]!;
    expect(request.url).toBe(
      "https://stash.internal/v1/stashes/rpc-fixture/diff/docs/nested.txt?from=head&label=a+b",
    );
    expect(request.headers.get("authorization")).toBe("Bearer winner");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-probe")).toBe("kept");
    expect(await request.text()).toBe("exact body");
    expect(actualBindings).toBe(bindings);
    expect(actualContext).toBe(ctx);
    expect(suppliedHeaders.AUTHORIZATION).toBe("Bearer ignored");
  });

  it.each(["GET", "HEAD"])("omits a supplied body for %s", async (method) => {
    const fetchSpy = vi.spyOn(app, "fetch").mockResolvedValueOnce(new Response("ok"));
    await new StashRpc(createExecutionContext(), createTestEnv().env).request({
      method: method as RpcRequest["method"],
      path: "/v1/health",
      body: "must not be forwarded",
      token: "unused",
    });
    const [request] = fetchSpy.mock.calls[0]!;
    expect(request.body).toBeNull();
    expect(await request.text()).toBe("");
  });
});

describe("HTTP and RPC parity", () => {
  it.each(scenarios)("matches $name byte-for-byte", async (scenario) => {
    const results: Partial<Record<"http" | "rpc", ResponseSnapshot>> = {};
    for (const transport of ["http", "rpc"] as const) {
      await resetDatabase();
      await seedRpcFixture();
      const state = (await scenario.seed?.()) ?? {};
      const init = typeof scenario.init === "function" ? scenario.init(state) : scenario.init;
      const bindings = scenario.bindings?.() ?? createTestEnv().env;
      const response =
        transport === "http"
          ? await dispatchHttp(init, bindings)
          : await dispatchRpc(init, bindings);
      results[transport] = await snapshot(response);
    }

    expect(results.rpc).toEqual(results.http);
    expect(results.rpc?.status).toBe(scenario.expectedStatus);
    if (scenario.expectedBody !== undefined) expect(results.rpc?.body).toBe(scenario.expectedBody);
    if (scenario.expectedBodyIncludes !== undefined) {
      expect(results.rpc?.body).toContain(scenario.expectedBodyIncludes);
    }
    if (scenario.expectedHeaders !== undefined) {
      expect(results.rpc?.headers).toMatchObject(scenario.expectedHeaders);
    }
  });
});

describe.sequential("large payload HTTP and RPC parity", () => {
  it("accepts and round-trips the exact 5,000,000-byte file boundary through R2", async () => {
    const body = "m".repeat(MAX_BODY_BYTES);
    const hash = await contentSha256Hex(body);
    const putInit = jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/${RPC_MAX_FILE_PATH}`,
      { body, expectedVersion: null },
      RPC_WRITE_TOKEN,
    );
    const getInit: RpcRequest = {
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/files/${RPC_MAX_FILE_PATH}`,
      token: RPC_READ_TOKEN,
    };
    const results: Partial<
      Record<
        "http" | "rpc",
        {
          calls: BlobCallCounts;
          get: ResponseSnapshot;
          put: ResponseSnapshot;
          storage: Awaited<ReturnType<typeof storageCounts>>;
        }
      >
    > = {};

    for (const transport of ["http", "rpc"] as const) {
      await resetDatabase();
      await seedRpcFixture();
      const calls: BlobCallCounts = { get: -1, put: -1 };
      const bindings = wrapBlobs(createTestEnv().env, { count: calls });
      const put = await snapshot(await dispatchTransport(transport, putInit, bindings));
      const get = await snapshot(await dispatchTransport(transport, getInit, bindings));
      results[transport] = {
        put,
        get,
        calls: { ...calls },
        storage: await storageCounts(bindings),
      };
    }

    expect(results.rpc).toEqual(results.http);
    expect(results.rpc?.put).toMatchObject({
      status: 201,
      headers: { "content-type": "application/json", "x-stash-version": null },
    });
    expect(results.rpc?.get).toMatchObject({
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: `"v1-${hash}"`,
        "x-stash-version": "1",
      },
    });
    const record = JSON.parse(results.rpc?.get.body ?? "null") as {
      body?: unknown;
      hash?: unknown;
      path?: unknown;
      size?: unknown;
      version?: unknown;
    };
    expect(record).toMatchObject({
      path: RPC_MAX_FILE_PATH,
      version: 1,
      hash,
      size: MAX_BODY_BYTES,
      body,
    });
    expect(results.rpc?.calls).toEqual({ get: 1, put: 1 });
    expect(results.rpc?.storage).toEqual({ files: 1, versions: 1, blobs: 1, objects: 1 });
  }, 60_000);

  it("rejects a 5,000,001-byte file body as the exact 413 contract without storage", async () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1);
    const init = jsonRequest(
      "PUT",
      `/v1/stashes/${RPC_STASH}/files/docs/rpc-too-large.txt`,
      { body, expectedVersion: null },
      RPC_WRITE_TOKEN,
    );
    const results: Partial<Record<"http" | "rpc", ResponseSnapshot>> = {};

    for (const transport of ["http", "rpc"] as const) {
      await resetDatabase();
      await seedRpcFixture();
      const calls: BlobCallCounts = { get: -1, put: -1 };
      const bindings = wrapBlobs(createTestEnv().env, { count: calls });
      results[transport] = await snapshot(await dispatchTransport(transport, init, bindings));
      expect(calls).toEqual({ get: 0, put: 0 });
      await expect(storageCounts(bindings)).resolves.toEqual({
        files: 0,
        versions: 0,
        blobs: 0,
        objects: 0,
      });
    }

    expect(results.rpc).toEqual(results.http);
    expect(results.rpc).toEqual({
      status: 413,
      body: '{"error":{"code":"payload-too-large","message":"The file body is too large."}}',
      headers: {
        etag: null,
        "x-stash-version": null,
        "idempotent-replayed": null,
        "content-type": "application/json",
        "retry-after": null,
      },
    });
  }, 60_000);

  it("rejects a valid aggregate import above 32 MiB as the exact 413 contract without storage", async () => {
    const body = aggregateImportBody();
    const init: RpcRequest = {
      method: "POST",
      path: `/v1/stashes/${RPC_STASH}/import`,
      headers: {
        "Content-Length": String(body.length),
        "Content-Type": "application/json",
      },
      body,
      token: "test-admin",
    };
    const results: Partial<Record<"http" | "rpc", ResponseSnapshot>> = {};

    for (const transport of ["http", "rpc"] as const) {
      await resetDatabase();
      await seedRpcFixture();
      const calls: BlobCallCounts = { get: -1, put: -1 };
      const bindings = wrapBlobs(createTestEnv().env, { count: calls });
      results[transport] = await snapshot(await dispatchTransport(transport, init, bindings));
      expect(calls).toEqual({ get: 0, put: 0 });
      await expect(storageCounts(bindings)).resolves.toEqual({
        files: 0,
        versions: 0,
        blobs: 0,
        objects: 0,
      });
    }

    expect(body.length).toBeGreaterThan(BODY_LIMIT_BYTES);
    expect(results.rpc).toEqual(results.http);
    expect(results.rpc).toEqual({
      status: 413,
      body: '{"error":{"code":"payload-too-large","message":"The request payload is too large."}}',
      headers: {
        etag: null,
        "x-stash-version": null,
        "idempotent-replayed": null,
        "content-type": "application/json",
        "retry-after": null,
      },
    });
  }, 60_000);
});

describe("named-entrypoint RPC boundary", () => {
  it("round-trips a real Response with headers and lets token override Authorization", async () => {
    await resetDatabase();
    await seedRpcFixture();
    const { etag } = await seedFile("boundary body\n");

    const response = await env.STASH_RPC.request({
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/files/docs/rpc.txt`,
      headers: {
        Authorization: "Bearer definitely-wrong",
        "If-None-Match": '"not-the-current-etag"',
      },
      token: RPC_WRITE_TOKEN,
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("x-stash-version")).toBe("1");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toContain('"body":"boundary body\\n"');
  });

  it("keeps fetch-only events off the named method surface while generic request stays total", async () => {
    await resetDatabase();
    await seedRpcFixture();

    expect(Object.getOwnPropertyNames(StashRpc.prototype)).not.toContain("stashEvents");
    const response = await env.STASH_RPC.request({
      method: "GET",
      path: `/v1/stashes/${RPC_STASH}/events`,
      token: RPC_READ_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    try {
      let firstFrame = "";
      const decoder = new TextDecoder();
      for (let readCount = 0; readCount < 4 && !firstFrame.includes("\n\n"); readCount += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        firstFrame += decoder.decode(chunk.value, { stream: true });
      }
      expect(firstFrame).toContain(
        'event: ready\ndata: {"type":"ready","head":null,"checkpoint":null}',
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
});

interface ProposalLifecycleProjection {
  created: {
    id: string;
    status: string;
    hash: string;
    meta: Record<string, unknown>;
  };
  approved: {
    status: string;
    appliedVersion: number;
    appliedChangeId: number;
    hash: string;
  };
  history: {
    headVersion: number;
    total: number;
    applied: {
      version: number;
      kind: string;
      rollbackOf: number | null;
      hash: string | null;
      author: string;
      message: string;
      meta: Record<string, unknown>;
    };
  };
  rpcRequests: RpcRequest[];
}

async function proposalLifecycleThroughClient(
  transport: "fetch" | "rpc",
): Promise<ProposalLifecycleProjection> {
  await resetDatabase();
  await seedRpcFixture();
  await putFixture("generic proposal base\n", null);
  const bindings = createTestEnv().env;
  const rpc = new StashRpc(createExecutionContext(), bindings);
  const requestSpy = vi.spyOn(rpc, "request");
  const client =
    transport === "rpc"
      ? createStashClient({
          transport: { kind: "rpc", binding: rpc, token: RPC_WRITE_TOKEN },
        })
      : createStashClient({
          baseUrl: "https://stash.internal",
          token: RPC_WRITE_TOKEN,
          fetch: async (input, init) => {
            const ctx = createExecutionContext();
            const response = await app.fetch(new Request(input, init), bindings, ctx);
            await waitOnExecutionContext(ctx);
            return response;
          },
        });
  const proposals = client.proposals(RPC_STASH);
  const created = await proposals.create(
    {
      path: "docs/rpc.txt",
      body: "generic proposal candidate\n",
      baseVersion: 1,
      author: "rpc-client-bot",
      message: "Review generic RPC proposal",
      meta: { lane: "generic-client-parity" },
    },
    { idempotencyKey: "generic-rpc-proposal-create" },
  );
  if (!created.ok) {
    throw new Error(
      `proposal create failed over ${transport} (${created.error.status} ${created.error.code}): ${created.error.message}`,
    );
  }
  const approved = await proposals.approve(created.value.id, {
    author: "rpc-client-approver",
    message: "Approve generic RPC proposal",
  });
  if (!approved.ok) {
    throw new Error(
      `proposal approval failed over ${transport} (${approved.error.status} ${approved.error.code}): ${approved.error.message}`,
    );
  }
  const history = await client.files(RPC_STASH).history("docs/rpc.txt", { limit: 200 });
  if (!history.ok) {
    throw new Error(
      `proposal history failed over ${transport} (${history.error.status} ${history.error.code}): ${history.error.message}`,
    );
  }
  const applied = history.value.versions.find(({ version }) => version === 2);
  if (applied === undefined) throw new Error(`applied proposal version missing over ${transport}`);

  return {
    created: {
      id: created.value.id,
      status: created.value.status,
      hash: created.value.hash,
      meta: created.value.meta,
    },
    approved: {
      status: approved.value.status,
      appliedVersion: approved.value.appliedVersion,
      appliedChangeId: approved.value.appliedChangeId,
      hash: approved.value.hash,
    },
    history: {
      headVersion: history.value.headVersion,
      total: history.value.total,
      applied: {
        version: applied.version,
        kind: applied.kind,
        rollbackOf: applied.rollbackOf,
        hash: applied.hash,
        author: applied.author,
        message: applied.message,
        meta: applied.meta,
      },
    },
    rpcRequests: requestSpy.mock.calls.map(([init]) => init),
  };
}

describe.sequential("generic RPC proposal client parity", () => {
  it("matches fetch for create, approve, and stamped ordinary history", async () => {
    const fetched = await proposalLifecycleThroughClient("fetch");
    const rpc = await proposalLifecycleThroughClient("rpc");

    expect(rpc).toMatchObject({
      created: {
        id: expect.stringMatching(/^prp_\d{13}[0-9a-f]{8}$/u),
        status: "open",
        hash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
        meta: {
          lane: "generic-client-parity",
          proposalId: rpc.created.id,
        },
      },
      approved: {
        status: "applied",
        appliedVersion: 2,
        appliedChangeId: expect.any(Number),
        hash: rpc.created.hash,
      },
      history: {
        headVersion: 2,
        total: 2,
        applied: {
          version: 2,
          kind: "put",
          rollbackOf: null,
          hash: rpc.created.hash,
          author: "rpc-client-approver",
          message: "Approve generic RPC proposal",
          meta: {
            lane: "generic-client-parity",
            proposalId: rpc.created.id,
          },
        },
      },
    });
    expect({ ...rpc, rpcRequests: [] }).toEqual(fetched);
    expect(rpc.rpcRequests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/v1/stashes/${RPC_STASH}/proposals`,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "generic-rpc-proposal-create",
        },
        token: RPC_WRITE_TOKEN,
      }),
      expect.objectContaining({
        method: "POST",
        path: `/v1/stashes/${RPC_STASH}/proposals/${rpc.created.id}/approve`,
        token: RPC_WRITE_TOKEN,
      }),
      expect.objectContaining({
        method: "GET",
        path: `/v1/stashes/${RPC_STASH}/history/docs/rpc.txt`,
        query: { limit: "200" },
        token: RPC_WRITE_TOKEN,
      }),
    ]);
  });
});

async function typedParity<T>(
  seed: (() => Promise<unknown>) | undefined,
  direct: (rpc: StashRpc) => Promise<T>,
  throughClient: (rpc: StashRpc) => Promise<T>,
): Promise<[direct: T, throughClient: T]> {
  const results: T[] = [];
  for (const invoke of [direct, throughClient]) {
    await resetDatabase();
    await seedRpcFixture();
    await seed?.();
    results.push(await invoke(new StashRpc(createExecutionContext(), createTestEnv().env)));
  }
  const [directResult, clientResult] = results;
  if (directResult === undefined || clientResult === undefined) {
    throw new Error("Typed RPC parity invocation did not return a result");
  }
  return [directResult, clientResult];
}

describe("typed StashRpc methods", () => {
  it("matches the rpc-transport client for putFile", async () => {
    const input = { body: "typed put\n", expectedVersion: null };
    const options = { idempotencyKey: "typed-put" };
    const [direct, client] = await typedParity(
      undefined,
      (rpc) => rpc.putFile(RPC_WRITE_TOKEN, RPC_STASH, "docs/typed.txt", input, options),
      (rpc) =>
        createStashClient({
          transport: { kind: "rpc", binding: rpc, token: RPC_WRITE_TOKEN },
        })
          .files(RPC_STASH)
          .put("docs/typed.txt", input, options),
    );
    expect(direct).toEqual(client);
  });

  it("matches the rpc-transport client for getFile", async () => {
    const [direct, client] = await typedParity(
      () => seedFile("typed get\n"),
      (rpc) => rpc.getFile(RPC_READ_TOKEN, RPC_STASH, "docs/rpc.txt"),
      (rpc) =>
        createStashClient({
          transport: { kind: "rpc", binding: rpc, token: RPC_READ_TOKEN },
        })
          .files(RPC_STASH)
          .get("docs/rpc.txt"),
    );
    expect(direct).toEqual(client);
  });

  it("matches the rpc-transport client for revokeToken", async () => {
    const [direct, client] = await typedParity(
      undefined,
      (rpc) => rpc.revokeToken("test-admin", RPC_STASH, RPC_WRITE_TOKEN_ID),
      (rpc) =>
        createStashClient({ transport: { kind: "rpc", binding: rpc, token: "test-admin" } })
          .stashes.tokens(RPC_STASH)
          .revoke(RPC_WRITE_TOKEN_ID),
    );
    expect(direct).toEqual(client);
  });

  it("matches the rpc-transport client for listFiles", async () => {
    const options = { includeDeleted: true, limit: 1 };
    const [direct, client] = await typedParity(
      () => seedFile("typed list\n"),
      (rpc) => rpc.listFiles(RPC_READ_TOKEN, RPC_STASH, options),
      (rpc) =>
        createStashClient({
          transport: { kind: "rpc", binding: rpc, token: RPC_READ_TOKEN },
        })
          .files(RPC_STASH)
          .list(options),
    );
    expect(direct).toEqual(client);
  });

  it("delegates lifecycle and GC methods through the typed client boundary", async () => {
    const rpc = new StashRpc(createExecutionContext(), createTestEnv().env);
    const requests: RpcRequest[] = [];
    vi.spyOn(rpc, "request").mockImplementation(async (init) => {
      requests.push(init);
      const body =
        init.path === "/v1/stashes/rpc-fixture"
          ? {
              name: RPC_STASH,
              deletedAt: "2026-08-26T00:00:00.000Z",
              revokedTokens: 1,
              restoreUntil: "2026-09-25T00:00:00.000Z",
            }
          : init.path === "/v1/stashes/rpc-fixture/restore"
            ? {
                name: RPC_STASH,
                description: "",
                meta: {},
                fileCount: 0,
                deletedFileCount: 0,
                lastChangeId: null,
                lastChangeAt: null,
                createdAt: "2026-08-26T00:00:00.000Z",
                deletedAt: null,
                restoreUntil: null,
                restorable: false,
              }
            : init.path === "/v1/stashes"
              ? { stashes: [], nextAfter: null }
              : init.path === "/v1/admin/gc"
                ? {
                    runId: "00000000-0000-4000-8000-000000000001",
                    jobId: "r2-orphans",
                    kind: "r2-orphans",
                    dryRun: true,
                    scanned: 0,
                    eligible: 0,
                    deleted: 0,
                    cursor: null,
                    startedAt: "2026-08-26T00:00:00.000Z",
                    finishedAt: "2026-08-26T00:00:00.000Z",
                    error: null,
                  }
                : { runs: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      rpc.listStashes("test-admin", { limit: 2, after: "alpha", includeDeleted: true }),
    ).resolves.toEqual({ ok: true, value: { stashes: [], nextAfter: null } });
    await expect(rpc.deleteStash("test-admin", RPC_STASH)).resolves.toMatchObject({
      ok: true,
      value: { name: RPC_STASH },
    });
    await expect(rpc.restoreStash("test-admin", RPC_STASH)).resolves.toMatchObject({
      ok: true,
      value: { name: RPC_STASH, deletedAt: null },
    });
    await expect(
      rpc.runGc("test-admin", {
        kind: "r2-orphans",
        dryRun: true,
        maxObjects: 1,
        cursor: "opaque",
      }),
    ).resolves.toMatchObject({ ok: true, value: { jobId: "r2-orphans" } });
    await expect(rpc.listGcRuns("test-admin", { kind: "ledger", limit: 3 })).resolves.toEqual({
      ok: true,
      value: { runs: [] },
    });

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v1/stashes",
        query: { limit: "2", after: "alpha", includeDeleted: "true" },
        token: "test-admin",
      },
      { method: "DELETE", path: `/v1/stashes/${RPC_STASH}`, token: "test-admin" },
      { method: "POST", path: `/v1/stashes/${RPC_STASH}/restore`, token: "test-admin" },
      {
        method: "POST",
        path: "/v1/admin/gc",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "r2-orphans",
          dryRun: true,
          maxObjects: 1,
          cursor: "opaque",
        }),
        token: "test-admin",
      },
      {
        method: "GET",
        path: "/v1/admin/gc/runs",
        query: { kind: "ledger", limit: "3" },
        token: "test-admin",
      },
    ]);
  });

  it("returns an internal Result when request rejects", async () => {
    const rpc = new StashRpc(createExecutionContext(), createTestEnv().env);
    vi.spyOn(rpc, "request").mockRejectedValueOnce(new Error("typed request failed"));

    await expect(rpc.listFiles(RPC_READ_TOKEN, RPC_STASH)).resolves.toEqual({
      ok: false,
      error: {
        code: "internal",
        status: 500,
        message: "History Stash request failed",
      },
    });
  });
});
