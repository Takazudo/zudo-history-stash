import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StashHttpError, createStashClient } from "../../src/index.js";
import type { StashClient, StashFetch, StashRpcBinding } from "../../src/index.js";
import type { RpcRequest } from "@takazudo/zudo-history-stash-core";
import { createFakeStash } from "../../src/testing/index.js";
import { GOLDEN_NOW, GOLDEN_RESPONSES } from "./fixtures/golden-responses.js";

const globalFetch = vi.fn<StashFetch>();

beforeEach(() => {
  globalFetch.mockImplementation(async () => {
    throw new Error("rpc transport touched global fetch");
  });
  vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalFetch.mockReset();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type TransportOutcome =
  | { settled: "fulfilled"; value: unknown }
  | {
      settled: "rejected";
      error: {
        name: string;
        status: number;
        code: unknown;
        body: unknown;
        cause: unknown;
      };
    };

async function captureTransportOutcome(promise: Promise<unknown>): Promise<TransportOutcome> {
  try {
    return { settled: "fulfilled", value: await promise };
  } catch (error) {
    expect(error).toBeInstanceOf(StashHttpError);
    const httpError = error as StashHttpError;
    const cause = httpError.cause;
    return {
      settled: "rejected",
      error: {
        name: httpError.name,
        status: httpError.status,
        code: httpError.code,
        body: httpError.body,
        cause: cause instanceof Error ? cause.message : cause,
      },
    };
  }
}

type TransportMatrixCase = {
  name: string;
  dispatch: () => Promise<Response>;
  invoke: (client: StashClient) => Promise<unknown>;
  expected: TransportOutcome;
  expectedFetchUrl?: string;
  expectedRpcQuery?: Record<string, string>;
};

const goldenFileBody = {
  path: GOLDEN_RESPONSES.file.path,
  version: GOLDEN_RESPONSES.file.version,
  hash: GOLDEN_RESPONSES.file.hash,
  size: GOLDEN_RESPONSES.file.size,
  kind: GOLDEN_RESPONSES.file.kind,
  author: GOLDEN_RESPONSES.file.author,
  message: GOLDEN_RESPONSES.file.message,
  meta: GOLDEN_RESPONSES.file.meta,
  createdAt: GOLDEN_RESPONSES.file.createdAt,
  deleted: GOLDEN_RESPONSES.file.deleted,
  body: GOLDEN_RESPONSES.file.body,
};

const rollbackResult = {
  version: 3,
  hash: GOLDEN_RESPONSES.file.hash,
  rollbackOf: 1,
  identicalToHead: false,
  changeId: 3,
  createdAt: GOLDEN_RESPONSES.file.createdAt,
};

const transportMatrix: TransportMatrixCase[] = [
  {
    name: "get 200 with ETag",
    dispatch: async () => jsonResponse(goldenFileBody, 200, { ETag: GOLDEN_RESPONSES.file.etag }),
    invoke: (client) => client.files("golden").get("docs/readme.md"),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: GOLDEN_RESPONSES.file },
    },
  },
  {
    name: "get 304 with an empty body",
    dispatch: async () =>
      new Response(null, {
        status: 304,
        headers: { ETag: GOLDEN_RESPONSES.file.etag, "Idempotent-Replayed": "true" },
      }),
    invoke: (client) =>
      client.files("golden").get("docs/readme.md", {
        ifNoneMatch: GOLDEN_RESPONSES.file.etag,
      }),
    expected: { settled: "fulfilled", value: { ok: true, notModified: true } },
  },
  {
    name: "put 201",
    dispatch: async () => jsonResponse(GOLDEN_RESPONSES.put, 201),
    invoke: (client) =>
      client
        .files("golden")
        .put("docs/readme.md", { body: "hello", expectedVersion: null }, { idempotencyKey: "put" }),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: GOLDEN_RESPONSES.put },
    },
  },
  {
    name: "put 200 unchanged",
    dispatch: async () => jsonResponse({ unchanged: true, version: 1 }, 200),
    invoke: (client) =>
      client
        .files("golden")
        .put(
          "docs/readme.md",
          { body: "hello", expectedVersion: 1, skipIfUnchanged: true },
          { idempotencyKey: "unchanged" },
        ),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: { unchanged: true, version: 1 } },
    },
  },
  {
    name: "put 201 replay",
    dispatch: async () =>
      jsonResponse(GOLDEN_RESPONSES.put, 201, { "Idempotent-Replayed": "true" }),
    invoke: (client) =>
      client
        .files("golden")
        .put(
          "docs/readme.md",
          { body: "hello", expectedVersion: null },
          { idempotencyKey: "replay" },
        ),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: GOLDEN_RESPONSES.put, replayed: true },
    },
  },
  {
    name: "422 reused idempotency key does not expose replay metadata",
    dispatch: async () =>
      jsonResponse(
        {
          error: {
            code: "idempotency-key-reused",
            message: "Idempotency key was used for another request",
          },
        },
        422,
        { "Idempotent-Replayed": "true" },
      ),
    invoke: (client) =>
      client
        .files("golden")
        .put(
          "docs/readme.md",
          { body: "changed", expectedVersion: 1 },
          { idempotencyKey: "reused" },
        ),
    expected: {
      settled: "fulfilled",
      value: {
        ok: false,
        error: {
          code: "idempotency-key-reused",
          message: "Idempotency key was used for another request",
          status: 422,
        },
      },
    },
  },
  {
    name: "delete 200",
    dispatch: async () => jsonResponse(GOLDEN_RESPONSES.deleted, 200),
    invoke: (client) =>
      client
        .files("golden")
        .delete("docs/readme.md", { expectedVersion: 1 }, { idempotencyKey: "delete" }),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: GOLDEN_RESPONSES.deleted },
    },
  },
  {
    name: "rollback 201",
    dispatch: async () => jsonResponse(rollbackResult, 201),
    invoke: (client) =>
      client
        .files("golden")
        .rollback(
          "docs/readme.md",
          { toVersion: 1, expectedVersion: 2 },
          { idempotencyKey: "rollback" },
        ),
    expected: { settled: "fulfilled", value: { ok: true, value: rollbackResult } },
  },
  {
    name: "revoke 204 returns undefined without replay metadata",
    dispatch: async () =>
      new Response(null, { status: 204, headers: { "Idempotent-Replayed": "true" } }),
    invoke: (client) => client.stashes.tokens("golden").revoke("tok_123"),
    expected: { settled: "fulfilled", value: { ok: true, value: undefined } },
  },
  {
    name: "rotate 201",
    dispatch: async () => jsonResponse(GOLDEN_RESPONSES.rotatedToken, 201),
    invoke: (client) => client.stashes.tokens("golden").rotate("tok_predecessor", {}),
    expected: {
      settled: "fulfilled",
      value: { ok: true, value: GOLDEN_RESPONSES.rotatedToken },
    },
    expectedFetchUrl: "https://stash.example/v1/stashes/golden/tokens/tok_predecessor/rotate",
  },
  {
    name: "stale 409 includes current",
    dispatch: async () =>
      jsonResponse(
        {
          error: {
            code: GOLDEN_RESPONSES.stale.error.code,
            message: GOLDEN_RESPONSES.stale.error.message,
          },
          current: GOLDEN_RESPONSES.stale.current,
        },
        409,
      ),
    invoke: (client) =>
      client
        .files("golden")
        .put(
          "docs/readme.md",
          { body: "changed", expectedVersion: 99 },
          { idempotencyKey: "stale" },
        ),
    expected: { settled: "fulfilled", value: GOLDEN_RESPONSES.stale },
  },
  {
    name: "already-rotated 409 includes successor id",
    dispatch: async () =>
      jsonResponse(
        {
          error: {
            code: GOLDEN_RESPONSES.alreadyRotated.error.code,
            message: GOLDEN_RESPONSES.alreadyRotated.error.message,
            successorId: GOLDEN_RESPONSES.alreadyRotated.error.successorId,
          },
        },
        409,
      ),
    invoke: (client) => client.stashes.tokens("golden").rotate("tok_predecessor", {}),
    expected: { settled: "fulfilled", value: GOLDEN_RESPONSES.alreadyRotated },
  },
  {
    name: "token-expired 409",
    dispatch: async () =>
      jsonResponse(
        {
          error: {
            code: GOLDEN_RESPONSES.tokenExpired.error.code,
            message: GOLDEN_RESPONSES.tokenExpired.error.message,
          },
        },
        409,
      ),
    invoke: (client) => client.stashes.tokens("golden").rotate("tok_expired", {}),
    expected: { settled: "fulfilled", value: GOLDEN_RESPONSES.tokenExpired },
  },
  {
    name: "401 is an ordinary client result",
    dispatch: async () =>
      jsonResponse(
        { error: { code: "unauthorized", message: "A valid bearer token is required." } },
        401,
      ),
    invoke: (client) => client.me(),
    expected: {
      settled: "fulfilled",
      value: {
        ok: false,
        error: {
          code: "unauthorized",
          message: "A valid bearer token is required.",
          status: 401,
        },
      },
    },
  },
  {
    name: "429 carries Retry-After seconds",
    dispatch: async () =>
      jsonResponse(
        {
          error: {
            code: GOLDEN_RESPONSES.rateLimited.error.code,
            message: GOLDEN_RESPONSES.rateLimited.error.message,
          },
        },
        429,
        { "Retry-After": String(GOLDEN_RESPONSES.rateLimited.retryAfter) },
      ),
    invoke: (client) => client.me(),
    expected: { settled: "fulfilled", value: GOLDEN_RESPONSES.rateLimited },
  },
  {
    name: "malformed request body validation 400",
    dispatch: async () =>
      jsonResponse(
        { error: { code: "validation", message: "Request body failed validation." } },
        400,
      ),
    invoke: (client) =>
      client.files("golden").put("docs/readme.md", { body: 1, expectedVersion: "bad" } as never, {
        idempotencyKey: "malformed-body",
      }),
    expected: {
      settled: "fulfilled",
      value: {
        ok: false,
        error: {
          code: "validation",
          message: "Request body failed validation.",
          status: 400,
        },
      },
    },
  },
  {
    name: "malformed query validation 400",
    dispatch: async () =>
      jsonResponse({ error: { code: "validation", message: "Invalid limit." } }, 400),
    invoke: (client) => client.files("golden").list({ limit: 0 }),
    expected: {
      settled: "fulfilled",
      value: {
        ok: false,
        error: { code: "validation", message: "Invalid limit.", status: 400 },
      },
    },
  },
  {
    name: "list files preserves limit and after query order",
    dispatch: async () =>
      jsonResponse({
        files: [
          {
            path: "docs/readme.md",
            headVersion: 1,
            hash: GOLDEN_RESPONSES.file.hash,
            size: 5,
            deleted: false,
            updatedAt: GOLDEN_RESPONSES.file.createdAt,
          },
        ],
        nextAfter: "docs/readme.md",
      }),
    invoke: (client) => client.files("golden").list({ limit: 2, after: "docs/readme.md" }),
    expected: {
      settled: "fulfilled",
      value: {
        ok: true,
        value: {
          files: [
            {
              path: "docs/readme.md",
              headVersion: 1,
              hash: GOLDEN_RESPONSES.file.hash,
              size: 5,
              deleted: false,
              updatedAt: GOLDEN_RESPONSES.file.createdAt,
            },
          ],
          nextAfter: "docs/readme.md",
        },
      },
    },
    expectedFetchUrl:
      "https://stash.example/v1/stashes/golden/files?limit=2&after=docs%2Freadme.md",
    expectedRpcQuery: { limit: "2", after: "docs/readme.md" },
  },
  {
    name: "500 throws StashHttpError",
    dispatch: async () => jsonResponse({ error: { code: "internal", message: "down" } }, 500),
    invoke: (client) => client.me(),
    expected: {
      settled: "rejected",
      error: {
        name: "StashHttpError",
        status: 500,
        code: "internal",
        body: { error: { code: "internal", message: "down" } },
        cause: undefined,
      },
    },
  },
  {
    name: "rejected transport becomes status zero with cause",
    dispatch: async () => {
      throw new TypeError("binding unavailable");
    },
    invoke: (client) => client.me(),
    expected: {
      settled: "rejected",
      error: {
        name: "StashHttpError",
        status: 0,
        code: undefined,
        body: undefined,
        cause: "binding unavailable",
      },
    },
  },
];

describe("client golden response parity", () => {
  it("returns deterministic stash and token administration contracts", async () => {
    const fake = createFakeStash({ adminToken: "golden-admin-token", now: () => GOLDEN_NOW });
    const admin = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "golden-admin-token",
      fetch: fake.fetch,
    });

    await expect(
      admin.stashes.create({
        name: "golden-admin",
        description: "Golden admin fixture",
        meta: { owner: "viewer" },
      }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.stash });
    await expect(admin.stashes.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.stashList,
    });
    await expect(admin.stashes.get("golden-admin")).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.stash,
    });

    const tokens = admin.stashes.tokens("golden-admin");
    await expect(tokens.create({ label: "Reader", scope: "read" })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.readToken,
    });
    await expect(tokens.create({ label: "Writer", scope: "write" })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.writeToken,
    });
    await expect(tokens.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tokenList,
    });

    const reader = createStashClient({
      baseUrl: "https://fake.invalid",
      token: GOLDEN_RESPONSES.readToken.token,
      fetch: fake.fetch,
    });
    const writer = createStashClient({
      baseUrl: "https://fake.invalid",
      token: GOLDEN_RESPONSES.writeToken.token,
      fetch: fake.fetch,
    });
    await expect(reader.me()).resolves.toEqual({
      ok: true,
      value: {
        principal: "stash",
        stash: "golden-admin",
        tokenId: GOLDEN_RESPONSES.readToken.id,
        scope: "read",
        expiresAt: null,
      },
    });
    await expect(writer.me()).resolves.toEqual({
      ok: true,
      value: {
        principal: "stash",
        stash: "golden-admin",
        tokenId: GOLDEN_RESPONSES.writeToken.id,
        scope: "write",
        expiresAt: null,
      },
    });
    await expect(tokens.revoke(GOLDEN_RESPONSES.readToken.id)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(reader.me()).resolves.toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "A valid bearer token is required.",
        status: 401,
      },
    });
    await expect(tokens.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tokenListAfterUseAndRevoke,
    });
  });

  it("returns the shared put, file, conflict, delete, and tombstone shapes", async () => {
    const fake = createFakeStash({ adminToken: "golden-admin", now: () => GOLDEN_NOW });
    fake.createStash("golden");
    let key = 0;
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "golden-admin",
      fetch: fake.fetch,
      idempotencyKey: () => `golden-${(key += 1)}`,
    });
    const files = client.files("golden");

    await expect(
      files.put("docs/readme.md", {
        body: "hello",
        expectedVersion: null,
        author: "fixture",
        message: "golden",
        meta: { nested: { b: 2, a: 1 } },
      }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.put });

    await expect(files.get("docs/readme.md")).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.file,
    });

    await expect(
      files.put("docs/readme.md", { body: "changed", expectedVersion: 99 }),
    ).resolves.toEqual(GOLDEN_RESPONSES.stale);

    await expect(
      files.delete("docs/readme.md", { expectedVersion: 1, message: "removed" }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.deleted });

    await expect(files.get("docs/readme.md", { version: 2 })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tombstone,
    });
  });
});

describe("fetch and rpc transport golden response parity", () => {
  it.each(transportMatrix)("maps $name identically", async (scenario) => {
    const fetcher = vi.fn<StashFetch>(async () => scenario.dispatch());
    const rpcRequests: RpcRequest[] = [];
    const binding = {
      request: vi.fn<StashRpcBinding["request"]>(async (request) => {
        rpcRequests.push(request);
        return scenario.dispatch();
      }),
    };
    const fetchClient = createStashClient({
      baseUrl: "https://stash.example",
      token: "matrix-token",
      fetch: fetcher,
      idempotencyKey: () => "matrix-key",
    });
    const rpcClient = createStashClient({
      transport: { kind: "rpc", binding, token: "matrix-token" },
    });

    const fetchOutcome = await captureTransportOutcome(scenario.invoke(fetchClient));
    const rpcOutcome = await captureTransportOutcome(scenario.invoke(rpcClient));

    expect(fetchOutcome).toEqual(scenario.expected);
    expect(rpcOutcome).toEqual(fetchOutcome);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(binding.request).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();

    const [fetchInput, fetchInit] = fetcher.mock.calls[0] as [string, RequestInit];
    const fetchUrl = new URL(fetchInput);
    const rpcRequest = rpcRequests[0];
    expect(rpcRequest).toBeDefined();
    expect(rpcRequest?.method).toBe(fetchInit.method);
    expect(rpcRequest?.path).toBe(fetchUrl.pathname);
    expect(
      rpcRequest?.query === undefined ? "" : new URLSearchParams(rpcRequest.query).toString(),
    ).toBe(fetchUrl.search.slice(1));
    expect(rpcRequest?.body).toBe(fetchInit.body);
    expect(rpcRequest?.token).toBe("matrix-token");

    const fetchHeaders = Object.fromEntries(new Headers(fetchInit.headers).entries());
    delete fetchHeaders.authorization;
    const rpcHeaders = Object.fromEntries(new Headers(rpcRequest?.headers).entries());
    expect(rpcHeaders).toEqual(fetchHeaders);

    if (scenario.expectedFetchUrl !== undefined) {
      expect(fetchInput).toBe(scenario.expectedFetchUrl);
    }
    if (scenario.expectedRpcQuery !== undefined) {
      expect(rpcRequest?.query).toEqual(scenario.expectedRpcQuery);
    }
  });
});
