import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { stageSingleBytes, stagingObjectKey } from "../src/byte-writes.js";
import { resetDatabase } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

beforeEach(resetDatabase);

describe("single byte staging", () => {
  it("does not delete an immutable object when a generated key collides", async () => {
    const key = stagingObjectKey("upl_collision", 0, "same-object");
    await env.BLOBS.put(key, "original");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("replacement"));
        controller.close();
      },
    });
    await expect(
      stageSingleBytes(createTestEnv().env, {
        sessionId: "upl_collision",
        generation: 0,
        tier: "r2",
        stream,
        declaredSize: 11,
        representation: "binary",
        maximumBytes: 100,
        createObjectId: () => "same-object",
      }),
    ).rejects.toThrow("collision");
    await expect((await env.BLOBS.get(key))?.text()).resolves.toBe("original");
  });

  it("rejects an early disconnect without leaving an R2 object", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("disconnected"));
      },
    });
    await expect(
      stageSingleBytes(createTestEnv().env, {
        sessionId: "upl_disconnect",
        generation: 0,
        tier: "r2",
        stream,
        declaredSize: 4,
        representation: "binary",
        maximumBytes: 100,
        createObjectId: () => "disconnect-object",
      }),
    ).rejects.toThrow("disconnected");
    await expect(env.BLOBS.head("uploads/upl_disconnect/0/disconnect-object")).resolves.toBeNull();
  });
});
