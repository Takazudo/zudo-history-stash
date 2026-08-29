import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ROUTES,
  StashHttpError,
  createStashClient,
  isCommitConflict,
  validatePath,
} from "./index.js";
import { createRpcSend } from "./transport.js";
import type { StashFetch, StashRpcBinding } from "./index.js";
import {
  ROUTES as coreRoutes,
  validatePath as coreValidatePath,
} from "@takazudo/zudo-history-stash-core";

const mock = vi.fn<StashFetch>();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function client() {
  return createStashClient({
    baseUrl: "https://stash.example",
    token: "admin-token",
    idempotencyKey: () => "minted-key",
  });
}

function requestAt(index: number): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

beforeEach(() => {
  vi.stubGlobal("fetch", mock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mock.mockReset();
});

describe("route and validator pins", () => {
  it("uses only core routes and re-exports the identical validator function", () => {
    expect(CLIENT_ROUTES.map(({ method, template }) => [method, template])).toEqual(
      coreRoutes.map(({ method, template }) => [method, template]),
    );
    expect(validatePath).toBe(coreValidatePath);
  });
});

describe("transport options", () => {
  it("keeps explicit fetch transport options on the existing fetch path", async () => {
    mock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const c = createStashClient({
      baseUrl: "https://stash.example",
      token: "admin-token",
      fetch: mock,
      transport: { kind: "fetch" },
    });

    await expect(c.health()).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(mock).toHaveBeenCalledOnce();
  });

  it("rejects an rpc transport without a non-empty token", () => {
    const binding = { request: vi.fn(async () => new Response(null, { status: 204 })) };
    expect(() =>
      createStashClient({
        transport: { kind: "rpc", binding },
      } as unknown as Parameters<typeof createStashClient>[0]),
    ).toThrow("rpc transport requires a non-empty token");
    expect(() =>
      createStashClient({
        transport: { kind: "rpc", binding, token: "   " },
      }),
    ).toThrow("rpc transport requires a non-empty token");
  });

  it("rejects an rpc transport without a request-capable binding", () => {
    expect(() =>
      createStashClient({
        transport: { kind: "rpc", binding: {}, token: "rpc-token" },
      } as unknown as Parameters<typeof createStashClient>[0]),
    ).toThrow("rpc transport requires a binding with a request function");
  });

  it("rejects fetch-only fields on the rpc branch", () => {
    const binding = { request: vi.fn(async () => new Response(null, { status: 204 })) };
    expect(() =>
      createStashClient({
        baseUrl: "https://stash.example",
        transport: { kind: "rpc", binding, token: "rpc-token" },
      } as unknown as Parameters<typeof createStashClient>[0]),
    ).toThrow("rpc transport does not accept baseUrl or fetch");
    expect(() =>
      createStashClient({
        fetch: mock,
        transport: { kind: "rpc", binding, token: "rpc-token" },
      } as unknown as Parameters<typeof createStashClient>[0]),
    ).toThrow("rpc transport does not accept baseUrl or fetch");
  });

  it("uses rpc without touching global fetch and sends the transport token separately", async () => {
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async () => jsonResponse({ ok: true })),
    };
    const c = createStashClient({ transport: { kind: "rpc", binding, token: "rpc-token" } });

    await expect(c.health()).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(mock).not.toHaveBeenCalled();
    expect(binding.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/health",
      token: "rpc-token",
    });
  });

  it("ignores caller-supplied Authorization headers in favor of the rpc token", async () => {
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async () => new Response(null, { status: 204 })),
    };
    const send = createRpcSend(binding, "rpc-token");

    await send(
      "GET",
      "/v1/me",
      undefined,
      { Authorization: "Bearer caller-token", authorization: "Bearer second", "X-Test": "kept" },
      undefined,
    );

    expect(binding.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/me",
      headers: { "X-Test": "kept" },
      token: "rpc-token",
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("preserves local validation boundaries before rpc dispatch", async () => {
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async () => jsonResponse({ ok: true })),
    };
    const c = createStashClient({ transport: { kind: "rpc", binding, token: "rpc-token" } });

    await expect(c.files("demo").get("bad path")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-path" },
    });
    await expect(c.changes({ since: 1, before: 2 })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(binding.request).not.toHaveBeenCalled();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("live transport and client identity", () => {
  it("validates clientId once when constructing either transport", () => {
    const binding = { request: vi.fn(async () => new Response(null, { status: 204 })) };
    for (const clientId of [
      "",
      "x".repeat(65),
      " leading",
      "trailing ",
      "internal\ttab",
      "line\nbreak",
      "nul\0byte",
      "delete\u007f",
      "emoji🙂",
    ]) {
      expect(() => createStashClient({ baseUrl: "https://stash.example", clientId })).toThrow(
        "clientId must contain between 1 and 64 characters",
      );
    }
    expect(() =>
      createStashClient({
        transport: { kind: "rpc", binding, token: "rpc-token" },
        clientId: "x".repeat(65),
      }),
    ).toThrow("clientId must contain between 1 and 64 characters");
    expect(() =>
      createStashClient({ baseUrl: "https://stash.example", clientId: "tab A!~" }),
    ).not.toThrow();
    expect(binding.request).not.toHaveBeenCalled();
  });

  it("adds the stable identity to every fetch mutation route and no read route", async () => {
    const boundaryRequests: Request[] = [];
    mock.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      boundaryRequests.push(request);
      if (String(input).includes("/events")) {
        return new Response(
          `event: ready\ndata: ${JSON.stringify({
            type: "ready",
            head: 7,
            checkpoint: 7,
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return jsonResponse({});
    });
    const clientOptions = {
      baseUrl: "https://stash.example/",
      token: "read-token",
      clientId: "tab A!~",
      fetch: mock,
      idempotencyKey: () => "key",
    };
    const c = createStashClient(clientOptions);
    clientOptions.clientId = "changed-after-construction";
    clientOptions.baseUrl = "https://changed.invalid";
    clientOptions.token = "changed-token";
    const tokens = c.stashes.tokens("demo");
    const files = c.files("demo");

    await c.stashes.create({ name: "new-stash" });
    await c.stashes.delete("demo");
    await c.stashes.restore("demo");
    await tokens.create({ label: "ci", scope: "write" });
    await tokens.rotate("tok_old", {});
    await tokens.revoke("tok_old");
    await c.stashes.import("demo", {
      path: "a.md",
      expectedVersion: null,
      versions: [{ kind: "put", body: "a", createdAt: 0 }],
    });
    await c.admin.gc.run({ kind: "ledger", dryRun: true });
    await files.put("a.md", { body: "a", expectedVersion: null });
    await files.delete("a.md", { expectedVersion: 1 });
    await files.rollback("a.md", { toVersion: 1, expectedVersion: 2 });

    expect(mock).toHaveBeenCalledTimes(11);
    for (const request of boundaryRequests) {
      expect(request.headers.get("X-Stash-Client-Id")).toBe("tab A!~");
    }

    mock.mockClear();
    boundaryRequests.length = 0;
    await c.health();
    await c.me();
    await c.stashes.list();
    await c.stashes.get("demo");
    await tokens.list();
    await c.changes();
    await c.admin.gc.runs();
    await files.list();
    await files.get("a.md");
    await files.history("a.md");
    await files.diff("a.md", { from: 1, to: "head" });
    await files.diffCandidate("a.md", { from: "head", body: "candidate" });
    await files.changes();
    const events = files.events({ since: 7 });
    await expect(events[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: "ready", checkpoint: 7 },
    });
    events.close();

    expect(mock).toHaveBeenCalledTimes(14);
    for (const request of boundaryRequests) {
      expect(request.headers.has("X-Stash-Client-Id")).toBe(false);
    }
    expect(requestAt(11)).toMatchObject({
      init: { method: "POST", headers: { "Content-Type": "application/json" } },
    });
    expect(requestAt(13)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/events?since=7",
      init: {
        method: "GET",
        headers: { Authorization: "Bearer read-token" },
        signal: expect.any(AbortSignal),
      },
    });
  });

  it("passes mutation identity through generic RPC but rejects events before dispatch", async () => {
    const boundaryRequests: Request[] = [];
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async (init) => {
        boundaryRequests.push(
          new Request(`https://stash.example${init.path}`, {
            method: init.method,
            headers: init.headers,
          }),
        );
        return jsonResponse({});
      }),
    };
    const c = createStashClient({
      transport: { kind: "rpc", binding, token: "rpc-token" },
      clientId: "worker A!~",
    });

    await c.stashes.delete("demo");
    await c.files("demo").put("a.md", { body: "a", expectedVersion: null });
    await c.files("demo").diffCandidate("a.md", { from: "head", body: "candidate" });

    expect(binding.request.mock.calls[0]?.[0]).toMatchObject({
      method: "DELETE",
      headers: { "X-Stash-Client-Id": "worker A!~" },
    });
    expect(binding.request.mock.calls[1]?.[0]).toMatchObject({
      method: "PUT",
      headers: { "X-Stash-Client-Id": "worker A!~" },
    });
    expect(binding.request.mock.calls[2]?.[0].headers).not.toHaveProperty("X-Stash-Client-Id");
    expect(boundaryRequests[0]?.headers.get("X-Stash-Client-Id")).toBe("worker A!~");
    expect(boundaryRequests[1]?.headers.get("X-Stash-Client-Id")).toBe("worker A!~");
    expect(boundaryRequests[2]?.headers.has("X-Stash-Client-Id")).toBe(false);
    expect(() => c.files("demo").events()).toThrow(
      new TypeError("unsupported-transport: events are fetch-only"),
    );
    expect(binding.request).toHaveBeenCalledTimes(3);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("golden requests", () => {
  it("covers every public route with exact URL, method, headers, and body", async () => {
    const c = client();
    const f = c.files("demo");
    const file = {
      path: "docs/readme.md",
      version: 2,
      hash: "sha256-hash",
      size: 5,
      kind: "put" as const,
      author: "a",
      message: "m",
      meta: {},
      createdAt: "2026-08-25T00:00:00.000Z",
      deleted: false,
      body: "hello",
    };
    mock.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await c.health();
    await c.me();
    await c.stashes.list({ limit: 2, after: "demo" });
    await c.stashes.create({ name: "new-stash", description: "desc", meta: { a: 1 } });
    await c.stashes.get("demo");
    await c.stashes.tokens("demo").create({
      label: "ci",
      scope: "write",
      ttlSeconds: 86_400,
    });
    await c.stashes.tokens("demo").list();
    await c.stashes.tokens("demo").revoke("tok_123");
    await c.stashes.import("demo", {
      path: "docs/readme.md",
      expectedVersion: null,
      versions: [{ kind: "put", body: "hello", createdAt: 0 }],
    });
    await c.changes({ since: 10, limit: 2 });
    await f.list({ includeDeleted: true, limit: 2, after: "docs/readme.md" });
    mock.mockResolvedValueOnce(jsonResponse(file, 200, { ETag: '"v2-sha256-hash"' }));
    await f.get("docs/readme.md", { version: 2, ifNoneMatch: '"v1-old"' });
    await f.put(
      "docs/readme.md",
      { body: "hello", expectedVersion: 2, author: "a", message: "m", meta: { a: 1 } },
      { idempotencyKey: "put-key" },
    );
    await f.delete("docs/readme.md", { expectedVersion: 2 }, { idempotencyKey: "delete-key" });
    await f.rollback(
      "docs/readme.md",
      { toVersion: 1, expectedVersion: 2 },
      { idempotencyKey: "rollback-key" },
    );
    await f.history("docs/readme.md", { limit: 2, before: 3 });
    await f.diff("docs/readme.md", { from: 1, to: "head", context: 2, maxUnifiedBytes: 100 });
    await f.diffCandidate("docs/readme.md", { from: "head", body: "candidate", context: 1 });
    await f.changes({ before: 4, limit: 2 });
    await c.stashes.tokens("demo").rotate("tok_123", {
      graceSeconds: 60,
      expiresAt: "2026-08-26T00:00:00.000Z",
    });

    expect(mock).toHaveBeenCalledTimes(20);
    expect(requestAt(0)).toMatchObject({
      url: "https://stash.example/v1/health",
      init: { method: "GET", headers: { Authorization: "Bearer admin-token" } },
    });
    expect(requestAt(1).url).toBe("https://stash.example/v1/me");
    expect(requestAt(2).url).toBe("https://stash.example/v1/stashes?limit=2&after=demo");
    expect(requestAt(3)).toMatchObject({
      url: "https://stash.example/v1/stashes",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-stash", description: "desc", meta: { a: 1 } }),
      },
    });
    expect(requestAt(4).url).toBe("https://stash.example/v1/stashes/demo");
    expect(requestAt(5).url).toBe("https://stash.example/v1/stashes/demo/tokens");
    expect(requestAt(5).init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "ci", scope: "write", ttlSeconds: 86_400 }),
    });
    expect(requestAt(6).url).toBe("https://stash.example/v1/stashes/demo/tokens");
    expect(requestAt(7)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/tokens/tok_123",
      init: { method: "DELETE" },
    });
    expect(requestAt(8).url).toBe("https://stash.example/v1/stashes/demo/import");
    expect(requestAt(8).init).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        path: "docs/readme.md",
        expectedVersion: null,
        versions: [{ kind: "put", body: "hello", createdAt: 0 }],
      }),
    });
    expect(requestAt(9).url).toBe("https://stash.example/v1/changes?since=10&limit=2");
    expect(requestAt(10).url).toBe(
      "https://stash.example/v1/stashes/demo/files?includeDeleted=true&limit=2&after=docs%2Freadme.md",
    );
    expect(requestAt(11)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/files/docs/readme.md?version=2",
      init: { method: "GET", headers: { "If-None-Match": '"v1-old"' } },
    });
    expect(requestAt(12)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/files/docs/readme.md",
      init: {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "put-key" },
      },
    });
    expect(requestAt(12).init.body).toBe(
      JSON.stringify({
        body: "hello",
        expectedVersion: 2,
        author: "a",
        message: "m",
        meta: { a: 1 },
      }),
    );
    expect(requestAt(13)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/delete/docs/readme.md",
      init: { method: "POST", headers: { "Idempotency-Key": "delete-key" } },
    });
    expect(requestAt(14)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/rollback/docs/readme.md",
      init: { method: "POST", headers: { "Idempotency-Key": "rollback-key" } },
    });
    expect(requestAt(15).url).toBe(
      "https://stash.example/v1/stashes/demo/history/docs/readme.md?limit=2&before=3",
    );
    expect(requestAt(16).url).toBe(
      "https://stash.example/v1/stashes/demo/diff/docs/readme.md?from=1&to=head&context=2&maxUnifiedBytes=100",
    );
    expect(requestAt(17)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/diff/docs/readme.md",
      init: {
        method: "POST",
        body: JSON.stringify({ from: "head", body: "candidate", context: 1 }),
      },
    });
    expect(requestAt(18).url).toBe(
      "https://stash.example/v1/stashes/demo/changes?before=4&limit=2",
    );
    expect(requestAt(19)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/tokens/tok_123/rotate",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graceSeconds: 60, expiresAt: "2026-08-26T00:00:00.000Z" }),
      },
    });
  });
});

describe("lifecycle and GC golden requests", () => {
  it("pins lifecycle paths, includeDeleted, GC body, and nullable cursor query", async () => {
    mock.mockImplementation(async () => jsonResponse({ ok: true }));
    const c = client();

    await c.stashes.list({ limit: 2, after: "demo", includeDeleted: true });
    await c.stashes.delete("demo");
    await c.stashes.restore("demo");
    await c.admin.gc.run({ kind: "r2-orphans", dryRun: true, maxObjects: 1, cursor: "opaque" });
    await c.admin.gc.runs({ kind: "ledger", limit: 3 });

    expect(mock).toHaveBeenCalledTimes(5);
    expect(requestAt(0)).toMatchObject({
      url: "https://stash.example/v1/stashes?limit=2&after=demo&includeDeleted=true",
      init: { method: "GET", headers: { Authorization: "Bearer admin-token" } },
    });
    expect(requestAt(1)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo",
      init: { method: "DELETE", headers: { Authorization: "Bearer admin-token" } },
    });
    expect(requestAt(2)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/restore",
      init: { method: "POST", headers: { Authorization: "Bearer admin-token" } },
    });
    expect(requestAt(3)).toMatchObject({
      url: "https://stash.example/v1/admin/gc",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "r2-orphans", dryRun: true, maxObjects: 1, cursor: "opaque" }),
      },
    });
    expect(requestAt(4)).toMatchObject({
      url: "https://stash.example/v1/admin/gc/runs?kind=ledger&limit=3",
      init: { method: "GET", headers: { Authorization: "Bearer admin-token" } },
    });
  });
});

describe("response mapping and safety", () => {
  it("maps 409 current without throwing", async () => {
    const c = client();
    const current = {
      version: 3,
      hash: "sha256-current",
      deleted: false,
      kind: "put" as const,
      author: "other",
      createdAt: "2026-08-25T00:00:00.000Z",
    };
    mock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "stale", message: "head moved" }, current }, 409),
    );
    await expect(c.files("demo").put("a.txt", { body: "x", expectedVersion: 2 })).resolves.toEqual({
      ok: false,
      error: { code: "stale", message: "head moved", status: 409 },
      current,
    });
  });

  it("maps 304 to a distinct notModified result and sends the supplied ETag", async () => {
    const c = client();
    mock.mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"v2-hash"' } }));
    await expect(c.files("demo").get("a.txt", { ifNoneMatch: '"v2-hash"' })).resolves.toEqual({
      ok: true,
      notModified: true,
    });
    expect(requestAt(0).init.headers).toEqual({
      Authorization: "Bearer admin-token",
      "If-None-Match": '"v2-hash"',
    });
  });

  it("maps rate-limit retry metadata and already-rotated successor metadata", async () => {
    const c = client();
    mock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "rate-limited", message: "slow down" } }, 429, {
        "Retry-After": "60",
      }),
    );
    await expect(c.me()).resolves.toEqual({
      ok: false,
      error: { code: "rate-limited", message: "slow down", status: 429 },
      retryAfter: 60,
    });

    mock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "already-rotated",
            message: "already rotated",
            successorId: "tok_successor",
          },
        },
        409,
      ),
    );
    await expect(c.stashes.tokens("demo").rotate("tok_old", {})).resolves.toEqual({
      ok: false,
      error: {
        code: "already-rotated",
        message: "already rotated",
        status: 409,
        successorId: "tok_successor",
      },
    });
  });

  it.each(["-1", "1.5", "60oops", "9007199254740992"])(
    "omits malformed Retry-After delta-seconds %s",
    async (retryAfter) => {
      const c = client();
      mock.mockResolvedValueOnce(
        jsonResponse({ error: { code: "rate-limited", message: "slow down" } }, 429, {
          "Retry-After": retryAfter,
        }),
      );
      await expect(c.me()).resolves.toEqual({
        ok: false,
        error: { code: "rate-limited", message: "slow down", status: 429 },
      });
    },
  );

  it("does not attach response metadata to unrelated error codes or invalid fields", async () => {
    const c = client();
    mock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: { code: "validation", message: "bad", successorId: 123 },
        },
        400,
        { "Retry-After": "60" },
      ),
    );
    await expect(c.me()).resolves.toEqual({
      ok: false,
      error: { code: "validation", message: "bad", status: 400 },
    });

    mock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: { code: "already-rotated", message: "bad successor", successorId: 123 },
        },
        409,
      ),
    );
    await expect(c.stashes.tokens("demo").rotate("tok_old", {})).resolves.toEqual({
      ok: false,
      error: { code: "already-rotated", message: "bad successor", status: 409 },
    });
  });

  it("exposes the ETag and replay marker for either successful replay status", async () => {
    const c = client();
    mock.mockResolvedValueOnce(
      jsonResponse(
        {
          path: "a.txt",
          version: 2,
          hash: "sha256-hash",
          size: 1,
          kind: "put",
          author: "",
          message: "",
          meta: {},
          createdAt: "now",
          deleted: false,
          body: "x",
        },
        200,
        { ETag: '"v2-sha256-hash"' },
      ),
    );
    await expect(c.files("demo").get("a.txt")).resolves.toMatchObject({
      ok: true,
      value: { etag: '"v2-sha256-hash"' },
    });

    mock.mockResolvedValueOnce(
      jsonResponse(
        { version: 2, hash: "sha256-hash", size: 1, changeId: 7, createdAt: "now" },
        201,
        { "Idempotent-Replayed": "true" },
      ),
    );
    const result = await c.files("demo").put("a.txt", { body: "x", expectedVersion: 1 });
    expect(result).toEqual({
      ok: true,
      value: { version: 2, hash: "sha256-hash", size: 1, changeId: 7, createdAt: "now" },
      replayed: true,
    });

    mock.mockResolvedValueOnce(
      jsonResponse(
        { version: 2, hash: "sha256-hash", size: 1, changeId: 7, createdAt: "now" },
        200,
        {
          "Idempotent-Replayed": "true",
        },
      ),
    );
    await expect(
      c.files("demo").put("a.txt", { body: "x", expectedVersion: 1 }),
    ).resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("throws StashHttpError only for network and 5xx failures", async () => {
    const c = client();
    mock.mockResolvedValueOnce(jsonResponse({ error: { code: "internal", message: "down" } }, 503));
    await expect(c.me()).rejects.toMatchObject({
      name: "StashHttpError",
      status: 503,
      code: "internal",
      body: { error: { code: "internal", message: "down" } },
    });

    mock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(c.me()).rejects.toBeInstanceOf(StashHttpError);

    mock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      text: vi.fn().mockRejectedValue(new TypeError("response body disconnected")),
    } as unknown as Response);
    await expect(c.me()).rejects.toMatchObject({
      name: "StashHttpError",
      status: 0,
      cause: expect.objectContaining({ message: "response body disconnected" }),
    });
  });

  it("wraps request serialization failures before either transport dispatches", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const input = { body: "x", expectedVersion: null, meta: circular } as never;
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async () => jsonResponse({ ok: true })),
    };
    const rpcClient = createStashClient({
      transport: { kind: "rpc", binding, token: "rpc-token" },
    });

    await expect(
      client().files("demo").put("a.txt", input, { idempotencyKey: "fetch-circular" }),
    ).rejects.toMatchObject({
      name: "StashHttpError",
      status: 0,
      cause: expect.any(TypeError),
    });
    await expect(
      rpcClient.files("demo").put("a.txt", input, { idempotencyKey: "rpc-circular" }),
    ).rejects.toMatchObject({
      name: "StashHttpError",
      status: 0,
      cause: expect.any(TypeError),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(binding.request).not.toHaveBeenCalled();
  });

  it("validates paths before fetch and never percent-encodes route paths", async () => {
    const c = client();
    const result = await c.files("demo").get("bad path");
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-path" } });
    expect(mock).not.toHaveBeenCalled();

    mock.mockResolvedValueOnce(
      jsonResponse({ path: "a/b.txt", version: 1, hash: "h", deleted: false }),
    );
    await c.files("demo").get("a/b.txt");
    expect(requestAt(0).url).toContain("/files/a/b.txt");
    expect(requestAt(0).url).not.toContain("%2F");
  });
});

describe("putLatest", () => {
  it("reads the head, retries stale once, and succeeds on the second put", async () => {
    const c = client();
    mock.mockResolvedValueOnce(
      jsonResponse({ path: "a.txt", version: 1, hash: "h1", deleted: false }),
    );
    mock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "stale", message: "moved" }, current: { version: 2 } }, 409),
    );
    mock.mockResolvedValueOnce(
      jsonResponse({ path: "a.txt", version: 2, hash: "h2", deleted: false }),
    );
    mock.mockResolvedValueOnce(jsonResponse({ version: 3, hash: "h3", size: 1, changeId: 3 }));

    await expect(c.putLatest("demo", "a.txt", "new")).resolves.toEqual({
      ok: true,
      value: { version: 3, hash: "h3", size: 1, changeId: 3 },
    });
    expect(mock).toHaveBeenCalledTimes(4);
    expect(requestAt(1).init.body as string).toContain('"expectedVersion":1');
    expect(requestAt(3).init.body as string).toContain('"expectedVersion":2');
  });

  it("returns the last stale union after the configured retry budget", async () => {
    const c = client();
    for (const version of [1, 2, 3]) {
      mock.mockResolvedValueOnce(
        jsonResponse({ path: "a.txt", version, hash: `h${version}`, deleted: false }),
      );
      mock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: { code: "stale", message: `stale-${version}` },
            current: { version: version + 1 },
          },
          409,
        ),
      );
    }
    await expect(c.putLatest("demo", "a.txt", "new", { retries: 2 })).resolves.toMatchObject({
      ok: false,
      error: { code: "stale", message: "stale-3" },
    });
    expect(mock).toHaveBeenCalledTimes(6);
  });

  it("does not retry a rate-limited put", async () => {
    const c = client();
    mock.mockResolvedValueOnce(
      jsonResponse({ path: "a.txt", version: 1, hash: "h1", deleted: false }),
    );
    mock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "rate-limited", message: "slow down" } }, 429, {
        "Retry-After": "60",
      }),
    );

    await expect(c.putLatest("demo", "a.txt", "new", { retries: 3 })).resolves.toEqual({
      ok: false,
      error: { code: "rate-limited", message: "slow down", status: 429 },
      retryAfter: 60,
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(requestAt(0).init.method).toBe("GET");
    expect(requestAt(1).init.method).toBe("PUT");
  });

  it("shares head reads and stale retries with the rpc transport", async () => {
    const responses = [
      jsonResponse({ path: "a.txt", version: 1, hash: "h1", deleted: false }),
      jsonResponse({ error: { code: "stale", message: "moved" }, current: { version: 2 } }, 409),
      jsonResponse({ path: "a.txt", version: 2, hash: "h2", deleted: false }),
      jsonResponse({ version: 3, hash: "h3", size: 1, changeId: 3 }),
    ];
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected rpc request");
        return response;
      }),
    };
    const c = createStashClient({ transport: { kind: "rpc", binding, token: "rpc-token" } });

    await expect(c.putLatest("demo", "a.txt", "new")).resolves.toEqual({
      ok: true,
      value: { version: 3, hash: "h3", size: 1, changeId: 3 },
    });
    expect(binding.request).toHaveBeenCalledTimes(4);
    expect(binding.request.mock.calls[1]?.[0].body).toContain('"expectedVersion":1');
    expect(binding.request.mock.calls[3]?.[0].body).toContain('"expectedVersion":2');
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("commit, change-set, and snapshot routes", () => {
  it("uses the reviewed route shapes and preserves typed commit conflicts", async () => {
    mock.mockImplementation(async () => jsonResponse({}));
    const c = client();
    const commitBody = {
      entries: [{ op: "put" as const, path: "docs/a.txt", expectedVersion: null, body: "a" }],
      author: "test",
      message: "commit",
      meta: { suite: "client" },
    };

    await c.commits("demo").create(commitBody, { idempotencyKey: "commit-key" });
    await c.commits("demo").get("cmt_1");
    await c.commits("demo").list({ limit: 2, after: "cursor", path: "docs/a.txt" });
    await c.commits("demo").diff("cmt_1", { context: 1, path: "docs/a.txt" });
    await c
      .commits("demo")
      .revert(
        "cmt_1",
        { author: "test", message: "undo", meta: {} },
        { idempotencyKey: "revert-key" },
      );

    const changeSetBody = {
      entries: [{ op: "put" as const, path: "docs/review.txt", baseVersion: null, body: "review" }],
      author: "test",
      message: "review",
      meta: {},
    };
    await c.changeSets("demo").create(changeSetBody, { idempotencyKey: "change-set-key" });
    await c
      .changeSets("demo")
      .list({ status: "all", path: "docs/review.txt", limit: 2, after: "cursor" });
    await c.changeSets("demo").get("chs_1");
    await c.changeSets("demo").diff("chs_1", { context: 1, path: "docs/review.txt" });
    await c.changeSets("demo").approve("chs_1", { author: "test", message: "approve" });
    await c.changeSets("demo").reject("chs_1", { reason: "no" });
    await c.files("demo").list({ prefix: "docs", delimiter: "/" });
    await c.files("demo").snapshot({ at: "commit:cmt_1", prefix: "docs", delimiter: "/" });

    expect(mock).toHaveBeenCalledTimes(13);
    expect(requestAt(0)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/commits",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "commit-key" },
        body: JSON.stringify(commitBody),
      },
    });
    expect(requestAt(1).url).toBe("https://stash.example/v1/stashes/demo/commits/cmt_1");
    expect(requestAt(2).url).toBe(
      "https://stash.example/v1/stashes/demo/commits?limit=2&after=cursor&path=docs%2Fa.txt",
    );
    expect(requestAt(3).url).toBe(
      "https://stash.example/v1/stashes/demo/commits/cmt_1/diff?context=1&path=docs%2Fa.txt",
    );
    expect(requestAt(4)).toMatchObject({
      url: "https://stash.example/v1/stashes/demo/commits/cmt_1/revert",
      init: { method: "POST", headers: { "Idempotency-Key": "revert-key" } },
    });
    expect(requestAt(5).url).toBe("https://stash.example/v1/stashes/demo/change-sets");
    expect(requestAt(6).url).toBe(
      "https://stash.example/v1/stashes/demo/change-sets?status=all&path=docs%2Freview.txt&limit=2&after=cursor",
    );
    expect(requestAt(7).url).toBe("https://stash.example/v1/stashes/demo/change-sets/chs_1");
    expect(requestAt(8).url).toBe(
      "https://stash.example/v1/stashes/demo/change-sets/chs_1/diff?context=1&path=docs%2Freview.txt",
    );
    expect(requestAt(9).url).toBe(
      "https://stash.example/v1/stashes/demo/change-sets/chs_1/approve",
    );
    expect(requestAt(10).url).toBe(
      "https://stash.example/v1/stashes/demo/change-sets/chs_1/reject",
    );
    expect(requestAt(11).url).toBe(
      "https://stash.example/v1/stashes/demo/files?prefix=docs&delimiter=%2F",
    );
    expect(requestAt(12).url).toBe(
      "https://stash.example/v1/stashes/demo/snapshot?at=commit%3Acmt_1&prefix=docs&delimiter=%2F",
    );

    mock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: { code: "commit-conflict", message: "conflict" },
          conflicts: [{ path: "docs/a.txt", expectedVersion: null, current: null }],
        },
        409,
      ),
    );
    const conflict = await c.commits("demo").create(commitBody, { idempotencyKey: "conflict-key" });
    expect(isCommitConflict(conflict)).toBe(true);
    if (!isCommitConflict(conflict)) throw new Error("commit conflict was not narrowed");
    expect(conflict.conflicts).toEqual([
      { path: "docs/a.txt", expectedVersion: null, current: null },
    ]);
  });
});
