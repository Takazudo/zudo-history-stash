import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_STASH,
  BINARY_DEMO_PATH,
  handleRequest,
  type Env as ExampleEnv,
} from "../../example-rpc-consumer/src/index.js";
import {
  cleanupRpcSmokeResources,
  confirmRpcSmokeSessionTerminal,
} from "../../example-rpc-consumer/src/multipart-smoke.js";
import type { StashRpcEntrypoint, StashUploadSessionsClient } from "@takazudo/zudo-history-stash";
import { mintToken, resetDatabase, seedStash } from "./helpers/app.js";

const triggerToken = "rpc-smoke-trigger";

function exampleEnv(token: string, gated = true): ExampleEnv {
  return {
    STASH: {
      fetch: async () => {
        throw new Error("The example test must use the named RPC binding");
      },
      connect: () => {
        throw new Error("The example test must use the named RPC binding");
      },
    },
    // The test binding is declared with only request() because Miniflare's service-binding
    // helper does not expose the entrypoint's typed methods in its generated test Env.
    STASH_RPC: env.STASH_RPC as unknown as StashRpcEntrypoint,
    STASH_TOKEN: token,
    ...(gated ? { RPC_SMOKE_TRIGGER_TOKEN: triggerToken } : {}),
  };
}

function triggeredRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${triggerToken}`);
  return new Request(`https://example-consumer.test${path}`, { ...init, headers });
}

describe("example RPC consumer", () => {
  beforeEach(resetDatabase);

  it("runs its get, put, history, and rollback round trip through the named RPC binding", async () => {
    await seedStash(DEMO_STASH);
    const token = await mintToken(DEMO_STASH, "write");

    const response = await handleRequest(triggeredRequest("/demo"), exampleEnv(token.token));

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      get: { ok: boolean; error?: { code: string } };
      put: { ok: boolean; value?: { version: number } };
      history: { ok: boolean; value?: { versions: unknown[] } };
      rollback: { ok: boolean; value?: { rollbackOf: number } };
      commits: {
        list: { ok: boolean; value?: { commits: Array<{ id: string }> } };
        get: { ok: boolean; value?: { id: string } } | null;
        diff: { ok: boolean; value?: { entries: unknown[] } } | null;
      };
      snapshot: { ok: boolean; value?: { at: { commitId: string } } } | null;
      changeSets: {
        list: { ok: boolean; value?: { changeSets: unknown[] } };
        get: null;
        diff: null;
      };
    };
    expect(result.get).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(result.put).toMatchObject({ ok: true, value: { version: 1 } });
    expect(result.history).toMatchObject({ ok: true, value: { versions: [{ version: 1 }] } });
    expect(result.rollback).toMatchObject({ ok: true, value: { rollbackOf: 1 } });
    expect(result.commits.list.ok).toBe(true);
    expect(result.commits.list.value?.commits.length).toBeGreaterThan(0);
    expect(result.commits.get).toMatchObject({ ok: true, value: { id: expect.any(String) } });
    expect(result.commits.diff).toMatchObject({ ok: true, value: { entries: expect.any(Array) } });
    expect(result.snapshot).toMatchObject({
      ok: true,
      value: { at: { commitId: expect.any(String) } },
    });
    expect(result.changeSets.list).toMatchObject({ ok: true, value: { changeSets: [] } });
    expect(result.changeSets.get).toBeNull();
    expect(result.changeSets.diff).toBeNull();

    const second = await handleRequest(triggeredRequest("/demo"), exampleEnv(token.token));
    const secondResult = (await second.json()) as {
      get: { ok: boolean; value?: { version: number } };
      put: { ok: boolean };
      history: { ok: boolean };
      rollback: { ok: boolean };
    };
    expect(secondResult.get).toMatchObject({ ok: true, value: { version: 2 } });
    expect(secondResult.put.ok).toBe(true);
    expect(secondResult.history.ok).toBe(true);
    expect(secondResult.rollback.ok).toBe(true);
  });

  it("has deterministic route and method responses", async () => {
    const bindings = exampleEnv("unused");
    await expect(
      handleRequest(new Request("https://example-consumer.test/missing"), bindings),
    ).resolves.toMatchObject({ status: 404 });
    const response = await handleRequest(triggeredRequest("/demo", { method: "POST" }), bindings);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("keeps every executable example route disabled or bearer-gated before touching Stash", async () => {
    const disabled = exampleEnv("unused", false);
    for (const [path, method] of [
      ["/demo", "GET"],
      ["/binary-demo", "GET"],
      ["/multipart-smoke", "POST"],
    ] as const) {
      await expect(
        handleRequest(new Request(`https://example-consumer.test${path}`, { method }), disabled),
      ).resolves.toMatchObject({ status: 404 });
    }

    const enabled = {
      ...exampleEnv("unused"),
      MULTIPART_SMOKE_STASH: DEMO_STASH,
    };
    for (const [path, method] of [
      ["/demo", "GET"],
      ["/binary-demo", "GET"],
      ["/multipart-smoke", "POST"],
    ] as const) {
      await expect(
        handleRequest(
          new Request(`https://example-consumer.test${path}`, {
            method,
            headers: { Authorization: "Bearer wrong" },
          }),
          enabled,
        ),
      ).resolves.toMatchObject({ status: 401 });
    }
    const method = await handleRequest(triggeredRequest("/multipart-smoke"), enabled);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
  });

  it("deletes the smoke path only after every busy upload session becomes terminal", async () => {
    const events: string[] = [];
    const abortCalls = new Map<string, number>();
    let finalizingStatuses = 0;
    const uploads = {
      abort: vi.fn(async (id: string) => {
        const call = (abortCalls.get(id) ?? 0) + 1;
        abortCalls.set(id, call);
        events.push(`abort:${id}:${call}`);
        if (id === "open" && call === 2) {
          return { ok: true, value: { id, state: "aborted" } };
        }
        return {
          ok: false,
          error: { code: "upload-session-not-open", message: "busy", status: 409 },
        };
      }),
      status: vi.fn(async (id: string) => {
        const state =
          id === "finalizing" ? (finalizingStatuses++ === 0 ? "finalizing" : "committed") : "open";
        events.push(`status:${id}:${state}`);
        return { ok: true, value: { id, state } };
      }),
    } as unknown as Pick<StashUploadSessionsClient, "abort" | "status">;
    const sessions = [
      { id: "finalizing", generation: 0, key: "cleanup-finalizing" },
      { id: "open", generation: 0, key: "cleanup-open" },
    ];
    const failures = await cleanupRpcSmokeResources(
      sessions,
      (session) =>
        confirmRpcSmokeSessionTerminal(uploads, session, {
          attempts: 2,
          wait: async (attempt) => {
            events.push(`wait:${attempt}`);
          },
        }),
      async () => {
        events.push("delete-path");
      },
    );

    expect(failures).toEqual([]);
    expect(events).toEqual([
      "abort:finalizing:1",
      "status:finalizing:finalizing",
      "wait:0",
      "abort:finalizing:2",
      "status:finalizing:committed",
      "abort:open:1",
      "status:open:open",
      "wait:0",
      "abort:open:2",
      "delete-path",
    ]);

    const blockedDelete = vi.fn(async () => undefined);
    const blocked = await cleanupRpcSmokeResources(
      sessions.slice(0, 1),
      async () => {
        throw new Error("still finalizing");
      },
      blockedDelete,
    );
    expect(blocked).toHaveLength(1);
    expect(blockedDelete).not.toHaveBeenCalled();
  });

  it("streams arbitrary bytes through the named RPC consumer bridge", async () => {
    await seedStash(DEMO_STASH);
    const token = await mintToken(DEMO_STASH, "write");
    const response = await handleRequest(triggeredRequest("/binary-demo"), exampleEnv(token.token));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      uploaded: { ok: true, value: { version: 1, representation: "binary", size: 6 } },
      bytes: [0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a],
    });
    expect(BINARY_DEMO_PATH).toBe("demo.bin");
  });

  it("runs the gated multipart smoke through the named RPC stream bridge with injected limits", async () => {
    await seedStash(DEMO_STASH);
    const token = await mintToken(DEMO_STASH, "write");
    const mutableEnv = env as unknown as {
      SINGLE_UPLOAD_MAX_BYTES: string;
      MULTIPART_PART_BYTES: string;
    };
    const originalSingle = mutableEnv.SINGLE_UPLOAD_MAX_BYTES;
    const originalPart = mutableEnv.MULTIPART_PART_BYTES;
    mutableEnv.SINGLE_UPLOAD_MAX_BYTES = String(5 * 1024 * 1024);
    mutableEnv.MULTIPART_PART_BYTES = String(5 * 1024 * 1024);

    try {
      const response = await handleRequest(
        triggeredRequest("/multipart-smoke", { method: "POST" }),
        {
          ...exampleEnv(token.token),
          MULTIPART_SMOKE_STASH: DEMO_STASH,
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        checks: [
          "named-rpc-request-stream",
          "multipart-r2",
          "completion-replay",
          "exact-hash-size",
          "raw-range",
          "rollback-history",
          "abort-cleanup",
          "logical-delete",
        ],
      });
    } finally {
      mutableEnv.SINGLE_UPLOAD_MAX_BYTES = originalSingle;
      mutableEnv.MULTIPART_PART_BYTES = originalPart;
    }
  }, 60_000);
});
