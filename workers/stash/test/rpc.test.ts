import type { RpcRequest } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { createStashStore } from "../src/d1/store.js";
import type { Env } from "../src/env.js";
import { StashRpc } from "../src/rpc.js";
import { resetDatabase } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";
import {
  RPC_FIXED_NOW,
  RPC_FOREIGN_TOKEN,
  RPC_READ_TOKEN,
  RPC_STASH,
  RPC_WRITE_TOKEN,
  RPC_WRITE_TOKEN_ID,
  seedRpcFixture,
} from "./helpers/rpc.js";

const PARITY_HEADERS = ["etag", "x-stash-version", "idempotent-replayed", "content-type"] as const;

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
});
