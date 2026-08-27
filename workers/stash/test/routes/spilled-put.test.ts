import { env } from "cloudflare:workers";
import { R2_SPILL_BYTES, sha256Hex } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { parseBlobKey } from "../../src/d1/blobs.js";
import type { Env } from "../../src/env.js";
import { request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const STASH = "route-spilled-put";
const URL = `http://stash.test/v1/stashes/${STASH}/files/spilled.txt`;

async function put(
  bindings: Env,
  body: string,
  idempotencyKey = "route-spilled-key",
): Promise<Response> {
  return request(
    app,
    URL,
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-admin",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ body, expectedVersion: null }),
    },
    bindings,
  );
}

async function tableCount(table: "blobs" | "versions" | "files" | "idempotency") {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
    .bind(STASH)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("spilled PUT route", () => {
  it("stores an R2 pointer and replays the public response without another upload", async () => {
    const body = "p".repeat(R2_SPILL_BYTES + 1);
    const hash = await sha256Hex(body);
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, { count: calls });

    const response = await put(bindings, body);
    expect(response.status).toBe(201);
    const result = await response.json<Record<string, unknown>>();
    expect(result).toMatchObject({
      version: 1,
      hash,
      size: R2_SPILL_BYTES + 1,
      changeId: expect.any(Number),
      createdAt: expect.stringMatching(/Z$/),
    });
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("r2_key");
    expect(calls).toEqual({ get: 0, put: 1 });

    const row = await env.DB.prepare(
      "SELECT body, r2_key, size_bytes FROM blobs WHERE stash_name = ? AND hash = ?",
    )
      .bind(STASH, hash)
      .first<{ body: string | null; r2_key: string | null; size_bytes: number }>();
    expect(row).toMatchObject({ body: null, size_bytes: R2_SPILL_BYTES + 1 });
    if (row?.r2_key === null || row?.r2_key === undefined) throw new Error("Expected R2 pointer");
    const parsedKey = parseBlobKey(row.r2_key);
    expect(parsedKey).toMatchObject({ format: "v2", stash: STASH, hash });
    if (parsedKey?.format !== "v2") throw new Error("Expected v2 R2 pointer");
    expect(JSON.stringify(result)).not.toContain(row.r2_key);
    expect(JSON.stringify(result)).not.toContain(parsedKey.generation);
    await expect(
      env.DB.prepare("SELECT body, r2_key, size_bytes FROM blobs WHERE stash_name = ? AND hash = ?")
        .bind(STASH, hash)
        .first(),
    ).resolves.toEqual(row);
    await expect(env.BLOBS.head(row.r2_key)).resolves.toMatchObject({
      key: row.r2_key,
      size: R2_SPILL_BYTES + 1,
    });

    const replay = await put(bindings, body);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual(result);
    expect(calls).toEqual({ get: 0, put: 1 });
    await expect(tableCount("blobs")).resolves.toBe(1);
    await expect(tableCount("versions")).resolves.toBe(1);
    await expect(tableCount("files")).resolves.toBe(1);
    await expect(tableCount("idempotency")).resolves.toBe(1);
  });

  it("returns a generic 500 and commits nothing when R2 upload fails", async () => {
    const marker = "ZHS_R2_UPLOAD_SECRET";
    const body = `${marker}${"x".repeat(R2_SPILL_BYTES + 1 - marker.length)}`;
    const hash = await sha256Hex(body);
    let attemptedKey = "";
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, {
      count: calls,
      failPut: (_call, key) => {
        attemptedKey = key;
        return true;
      },
    });

    const response = await put(bindings, body, "failed-upload");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal", message: "An internal error occurred." },
    });
    expect(text).not.toContain(marker);
    expect(text).not.toContain(hash);
    expect(attemptedKey).not.toBe("");
    expect(text).not.toContain(attemptedKey);
    expect(calls).toEqual({ get: 0, put: 1 });
    await expect(tableCount("blobs")).resolves.toBe(0);
    await expect(tableCount("versions")).resolves.toBe(0);
    await expect(tableCount("files")).resolves.toBe(0);
    await expect(tableCount("idempotency")).resolves.toBe(0);
    await expect(env.BLOBS.list({ prefix: `v2/${STASH}/` })).resolves.toMatchObject({
      objects: [],
    });
  });
});
