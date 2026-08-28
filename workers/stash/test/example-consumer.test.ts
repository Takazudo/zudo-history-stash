import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_STASH,
  BINARY_DEMO_PATH,
  handleRequest,
  type Env as ExampleEnv,
} from "../../example-rpc-consumer/src/index.js";
import type { StashRpcEntrypoint } from "@takazudo/zudo-history-stash";
import { mintToken, resetDatabase, seedStash } from "./helpers/app.js";

function exampleEnv(token: string): ExampleEnv {
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
  };
}

describe("example RPC consumer", () => {
  beforeEach(resetDatabase);

  it("runs its get, put, history, and rollback round trip through the named RPC binding", async () => {
    await seedStash(DEMO_STASH);
    const token = await mintToken(DEMO_STASH, "write");

    const response = await handleRequest(
      new Request("https://example-consumer.test/demo"),
      exampleEnv(token.token),
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      get: { ok: boolean; error?: { code: string } };
      put: { ok: boolean; value?: { version: number } };
      history: { ok: boolean; value?: { versions: unknown[] } };
      rollback: { ok: boolean; value?: { rollbackOf: number } };
    };
    expect(result.get).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(result.put).toMatchObject({ ok: true, value: { version: 1 } });
    expect(result.history).toMatchObject({ ok: true, value: { versions: [{ version: 1 }] } });
    expect(result.rollback).toMatchObject({ ok: true, value: { rollbackOf: 1 } });

    const second = await handleRequest(
      new Request("https://example-consumer.test/demo"),
      exampleEnv(token.token),
    );
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
    const response = await handleRequest(
      new Request("https://example-consumer.test/demo", { method: "POST" }),
      bindings,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("streams arbitrary bytes through the named RPC consumer bridge", async () => {
    await seedStash(DEMO_STASH);
    const token = await mintToken(DEMO_STASH, "write");
    const response = await handleRequest(
      new Request("https://example-consumer.test/binary-demo"),
      exampleEnv(token.token),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      uploaded: { ok: true, value: { version: 1, representation: "binary", size: 6 } },
      bytes: [0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a],
    });
    expect(BINARY_DEMO_PATH).toBe("demo.bin");
  });
});
