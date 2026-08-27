import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import type { AppEnv, Principal } from "../src/context.js";
import type { Env, RateLimiter } from "../src/env.js";
import { RATE_LIMIT_BINDING_BY_ROUTE, rateLimit } from "../src/rate-limit.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

function createLimiter(
  implementation: RateLimiter["limit"] = () => Promise.resolve({ success: true }),
) {
  return { limit: vi.fn(implementation) } satisfies RateLimiter;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "rate-limited",
      message: "The request was rate limited.",
    },
  });
}

function middlewareApp(principal: Principal, onRequest: () => void): Hono<AppEnv> {
  const middleware = new Hono<AppEnv>();
  middleware.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  middleware.get("/", rateLimit("me"), (c) => {
    onRequest();
    return c.json({ ok: true });
  });
  return middleware;
}

const MUTATION_TABLES = ["files", "versions", "blobs", "idempotency"] as const;
type MutationTable = (typeof MUTATION_TABLES)[number];

async function mutationCounts(): Promise<Record<MutationTable, number>> {
  const result = {} as Record<MutationTable, number>;
  for (const table of MUTATION_TABLES) {
    const row = await createTestEnv()
      .env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

beforeEach(resetDatabase);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rate-limit route buckets", () => {
  it("keeps every route in its capability bucket", () => {
    expect(RATE_LIMIT_BINDING_BY_ROUTE).toEqual({
      health: null,
      me: "RL_READ",
      listStashes: null,
      createStash: null,
      getStash: "RL_READ",
      createToken: null,
      listTokens: null,
      rotateToken: null,
      revokeToken: null,
      importHistory: null,
      listChanges: null,
      listFiles: "RL_READ",
      getFile: "RL_READ",
      putFile: "RL_WRITE",
      deleteFile: "RL_WRITE",
      rollbackFile: "RL_WRITE",
      getHistory: "RL_READ",
      getDiff: "RL_DIFF",
      diffCandidate: "RL_DIFF",
      getStashChanges: "RL_READ",
    });
  });

  it("uses the diff bucket instead of the read bucket", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const read = createLimiter(() => Promise.reject(new Error("wrong bucket")));
    const diff = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_READ: read, RL_DIFF: diff } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha/diff/missing.txt",
      { headers: bearer(token.token) },
      bindings,
    );

    await expectRateLimited(response);
    expect(read.limit).not.toHaveBeenCalled();
    expect(diff.limit).toHaveBeenCalledOnce();
    expect(diff.limit).toHaveBeenCalledWith({ key: `p:${token.id}` });
  });

  it.each([
    { method: "GET", suffix: "", body: undefined },
    { method: "GET", suffix: "/", body: undefined },
    { method: "POST", suffix: "", body: { from: "head", body: "candidate" } },
    { method: "POST", suffix: "/", body: { from: "head", body: "candidate" } },
  ])(
    "limits $method /diff$suffix before empty-path validation",
    async ({ method, suffix, body }) => {
      await seedStash("alpha");
      const token = await mintToken("alpha", "read");
      const read = createLimiter(() => Promise.reject(new Error("wrong bucket")));
      const diff = createLimiter(() => Promise.resolve({ success: false }));
      const bindings = createTestEnv({ env: { RL_READ: read, RL_DIFF: diff } }).env;
      const headers = new Headers(bearer(token.token));
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const query = method === "GET" ? "?from=1&to=head" : "";

      const response = await request(
        app,
        `http://stash.test/v1/stashes/alpha/diff${suffix}${query}`,
        {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        bindings,
      );

      await expectRateLimited(response);
      expect(read.limit).not.toHaveBeenCalled();
      expect(diff.limit).toHaveBeenCalledOnce();
      expect(diff.limit).toHaveBeenCalledWith({ key: `p:${token.id}` });
    },
  );
});

describe("rate-limit ordering and keys", () => {
  it("returns 401 before consulting a limiter for an unknown token", async () => {
    const read = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/me",
      { headers: bearer(`zhs_${"x".repeat(43)}`) },
      bindings,
    );

    await expectError(response, 401, "unauthorized");
    expect(read.limit).not.toHaveBeenCalled();
  });

  it("returns 404 before consulting a limiter for a foreign stash", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const read = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/beta/files",
      { headers: bearer(token.token) },
      bindings,
    );

    await expectError(response, 404, "not-found");
    expect(read.limit).not.toHaveBeenCalled();
  });

  it("returns 403 before consulting a write limiter for a read token", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const write = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_WRITE: write } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files/blocked.txt",
      { method: "PUT", headers: bearer(token.token) },
      bindings,
    );

    await expectError(response, 403, "scope");
    expect(write.limit).not.toHaveBeenCalled();
  });

  it("limits /v1/me by principal before consulting the stash key", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const read = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/me",
      { headers: bearer(token.token) },
      bindings,
    );

    await expectRateLimited(response);
    expect(read.limit).toHaveBeenCalledTimes(1);
    expect(read.limit).toHaveBeenCalledWith({ key: `p:${token.id}` });
  });

  it("uses the same binding for the principal and stash keys in order", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const read = createLimiter(({ key }) => Promise.resolve({ success: !key.startsWith("s:") }));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files",
      { headers: bearer(token.token) },
      bindings,
    );

    await expectRateLimited(response);
    expect(read.limit).toHaveBeenCalledTimes(2);
    expect(read.limit.mock.calls).toEqual([[{ key: `p:${token.id}` }], [{ key: "s:alpha" }]]);
  });

  it("charges /files once without also running the get-file limiter", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "read");
    const read = createLimiter();
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files",
      { headers: bearer(token.token) },
      bindings,
    );

    expect(response.status).toBe(200);
    expect(read.limit.mock.calls).toEqual([[{ key: `p:${token.id}` }], [{ key: "s:alpha" }]]);
  });

  it("shares the stash key across two tokens without sharing their principal keys", async () => {
    await seedStash("alpha");
    const firstToken = await mintToken("alpha", "read");
    const secondToken = await mintToken("alpha", "read");
    let stashCalls = 0;
    const read = createLimiter(({ key }) => {
      if (key === "s:alpha") {
        stashCalls += 1;
        return Promise.resolve({ success: stashCalls === 1 });
      }
      return Promise.resolve({ success: true });
    });
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const first = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files",
      { headers: bearer(firstToken.token) },
      bindings,
    );
    const second = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files",
      { headers: bearer(secondToken.token) },
      bindings,
    );

    expect(first.status).toBe(200);
    await expectRateLimited(second);
    expect(read.limit.mock.calls).toEqual([
      [{ key: `p:${firstToken.id}` }],
      [{ key: "s:alpha" }],
      [{ key: `p:${secondToken.id}` }],
      [{ key: "s:alpha" }],
    ]);
  });

  it("keeps read and write buckets independent", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "write");
    const read = createLimiter();
    const write = createLimiter(() => Promise.resolve({ success: false }));
    const diff = createLimiter();
    const bindings = createTestEnv({
      env: { RL_READ: read, RL_WRITE: write, RL_DIFF: diff },
    }).env;

    const readResponse = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files",
      { headers: bearer(token.token) },
      bindings,
    );
    const headers = new Headers(bearer(token.token));
    headers.set("Content-Type", "application/json");
    const writeResponse = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files/limited.txt",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ body: "must-not-write", expectedVersion: null }),
      },
      bindings,
    );

    expect(readResponse.status).toBe(200);
    await expectRateLimited(writeResponse);
    expect(read.limit.mock.calls).toEqual([[{ key: `p:${token.id}` }], [{ key: "s:alpha" }]]);
    expect(write.limit.mock.calls).toEqual([[{ key: `p:${token.id}` }]]);
    expect(diff.limit).not.toHaveBeenCalled();
  });
});

describe("rate-limit control flow", () => {
  it("does not run the downstream handler after a limiter denial", async () => {
    const downstream = vi.fn();
    const read = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;
    const directApp = middlewareApp(
      { kind: "stash", stash: "alpha", tokenId: "tok_alpha", scope: "read" },
      downstream,
    );

    const response = await request(directApp, "http://stash.test/", undefined, bindings);

    await expectRateLimited(response);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("bypasses mapped limiter bindings for the administrator before binding access", async () => {
    await seedStash("alpha");
    const base = createTestEnv().env;
    const bindings = new Proxy(base, {
      get(target, property, receiver) {
        if (typeof property === "string" && property.startsWith("RL_")) {
          throw new Error("administrator accessed a limiter binding");
        }
        return Reflect.get(target, property, receiver);
      },
    }) satisfies Env;

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha",
      { headers: bearer("test-admin") },
      bindings,
    );

    expect(response.status).toBe(200);
  });

  it("fails open once and logs a secret-free structured warning when a limiter throws", async () => {
    const stash = "sensitive-stash";
    await seedStash(stash);
    const token = await mintToken(stash, "read");
    const read = createLimiter(() =>
      Promise.reject(new Error(`do not log ${stash} ${token.token}`)),
    );
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await request(
      app,
      "http://stash.test/v1/me",
      { headers: bearer(token.token) },
      bindings,
    );

    expect(response.status).toBe(200);
    expect(read.limit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
    const warning = warn.mock.calls[0]?.[0];
    expect(warning).toBeTypeOf("string");
    expect(JSON.parse(String(warning))).toEqual({
      event: "rate_limit_binding_unavailable",
      routeId: "me",
      binding: "RL_READ",
      keyKind: "principal",
      action: "fail_open",
    });
    expect(String(warning)).not.toContain(stash);
    expect(String(warning)).not.toContain(token.id);
    expect(String(warning)).not.toContain(token.token);
  });

  it("leaves all four application mutation tables unchanged on 429", async () => {
    await seedStash("alpha");
    const token = await mintToken("alpha", "write");
    const write = createLimiter(() => Promise.resolve({ success: false }));
    const bindings = createTestEnv({ env: { RL_WRITE: write } }).env;
    const before = await mutationCounts();
    const headers = new Headers(bearer(token.token));
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", "rate-limit-no-mutation");

    const response = await request(
      app,
      "http://stash.test/v1/stashes/alpha/files/blocked.txt",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ body: "must-not-write", expectedVersion: null }),
      },
      bindings,
    );

    await expectRateLimited(response);
    expect(before).toEqual({ files: 0, versions: 0, blobs: 0, idempotency: 0 });
    expect(await mutationCounts()).toEqual(before);
  });

  it("leaves CORS preflight unauthenticated and limiter-free", async () => {
    const read = createLimiter(() => Promise.reject(new Error("must not be called")));
    const bindings = createTestEnv({ env: { RL_READ: read } }).env;

    const response = await request(
      app,
      "http://stash.test/v1/me",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "GET",
        },
      },
      bindings,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "ETag,X-Stash-Version,Idempotent-Replayed,Retry-After",
    );
    expect(read.limit).not.toHaveBeenCalled();
  });
});
