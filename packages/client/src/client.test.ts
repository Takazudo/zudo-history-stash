import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ROUTES, StashHttpError, createStashClient, validatePath } from "./index.js";
import type { StashFetch } from "./index.js";
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
  const binding = { request: vi.fn(async () => new Response(null, { status: 204 })) };

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

  it("accepts valid rpc options up to the deliberate implementation placeholder", () => {
    expect(() =>
      createStashClient({ transport: { kind: "rpc", binding, token: "rpc-token" } }),
    ).toThrow("rpc transport is implemented in a later change");
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
    await c.stashes.tokens("demo").create({ label: "ci", scope: "write" });
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

    expect(mock).toHaveBeenCalledTimes(19);
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
      body: JSON.stringify({ label: "ci", scope: "write" }),
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
});
