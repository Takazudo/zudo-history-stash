import { beforeEach, describe, expect, it } from "vitest";
import { R2_SPILL_BYTES, sha256Hex } from "@takazudo/zudo-history-stash-core";
import { app } from "../../src/app.js";
import { parseBlobKey } from "../../src/d1/blobs.js";
import type { Env } from "../../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const url = "http://example.test/v1/stashes/route-import/import";

function body(overrides: Record<string, unknown> = {}) {
  return {
    path: "history.txt",
    expectedVersion: null,
    versions: [
      {
        kind: "put",
        body: "route body",
        author: "route author",
        message: "route message",
        meta: { source: "route" },
        createdAt: 1_000,
      },
    ],
    ...overrides,
  };
}

async function post(payload: unknown, token = "test-admin", bindings: Env = createTestEnv().env) {
  return request(
    app,
    url,
    {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    bindings,
  );
}

function spilledBody(marker: string, fill: string): string {
  return `${marker}:${fill.repeat(R2_SPILL_BYTES + 1)}`;
}

async function importCounts(): Promise<{ blobs: number; versions: number; files: number }> {
  const result = { blobs: 0, versions: 0, files: 0 };
  for (const table of Object.keys(result) as (keyof typeof result)[]) {
    const row = await createTestEnv()
      .env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
      .bind("route-import")
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash("route-import");
});

describe("POST stash import", () => {
  it("returns the bounded 201 response shape for an administrator", async () => {
    const response = await post(body());
    expect(response.status).toBe(201);
    const json = await response.json<Record<string, unknown>>();
    expect(json).toEqual({
      commitId: "legacy:1",
      path: "history.txt",
      headVersion: 1,
      firstChangeId: expect.any(Number),
    });
    expect(json).not.toHaveProperty("versions");
    expect(JSON.stringify(json)).not.toContain("route body");
  });

  it("imports A, B, A through two R2 uploads and keeps pointers out of the response", async () => {
    const bodyA = spilledBody("ROUTE_SPILL_A", "a");
    const bodyB = spilledBody("ROUTE_SPILL_B", "b");
    const hashA = await sha256Hex(bodyA);
    const hashB = await sha256Hex(bodyB);
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const attempts: { call: number; key: string }[] = [];
    const bindings = wrapBlobs(createTestEnv().env, {
      count: calls,
      failPut: (call, key) => {
        attempts.push({ call, key });
        return false;
      },
    });

    const response = await post(
      body({
        versions: [
          { kind: "put", body: bodyA, createdAt: 1_000 },
          { kind: "put", body: bodyB, createdAt: 1_001 },
          { kind: "put", body: bodyA, createdAt: 1_002 },
        ],
      }),
      "test-admin",
      bindings,
    );

    expect(response.status).toBe(201);
    const json = await response.json<Record<string, unknown>>();
    expect(json).toEqual({
      commitId: "legacy:1",
      path: "history.txt",
      headVersion: 3,
      firstChangeId: expect.any(Number),
    });
    expect(JSON.stringify(json)).not.toContain("ROUTE_SPILL");
    expect(JSON.stringify(json)).not.toContain("r2_key");
    expect(calls).toEqual({ get: 0, put: 2 });
    expect(attempts.map(({ call }) => call)).toEqual([1, 2]);
    expect(attempts.map(({ key }) => parseBlobKey(key))).toEqual([
      expect.objectContaining({ format: "v2", stash: "route-import", hash: hashA }),
      expect.objectContaining({ format: "v2", stash: "route-import", hash: hashB }),
    ]);
    for (const { key } of attempts) {
      const parsedKey = parseBlobKey(key);
      if (parsedKey?.format !== "v2") throw new Error("Expected v2 R2 pointer");
      expect(JSON.stringify(json)).not.toContain(key);
      expect(JSON.stringify(json)).not.toContain(parsedKey.generation);
    }
    expect(await importCounts()).toEqual({ blobs: 2, versions: 3, files: 1 });
    const versions = await createTestEnv()
      .env.DB.prepare(
        `SELECT version, blob_hash FROM versions
         WHERE stash_name = ? AND path = ? ORDER BY version`,
      )
      .bind("route-import", "history.txt")
      .all<{ version: number; blob_hash: string }>();
    expect(versions.results).toEqual([
      { version: 1, blob_hash: hashA },
      { version: 2, blob_hash: hashB },
      { version: 3, blob_hash: hashA },
    ]);
  });

  it("maps a second-upload failure to generic 500 after leaving only the first orphan", async () => {
    const bodyA = spilledBody("ROUTE_FAILURE_A", "a");
    const bodyB = spilledBody("ROUTE_FAILURE_B", "b");
    const hashA = await sha256Hex(bodyA);
    const hashB = await sha256Hex(bodyB);
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const attempts: { call: number; key: string }[] = [];
    const bindings = wrapBlobs(createTestEnv().env, {
      count: calls,
      failPut: (call, key) => {
        attempts.push({ call, key });
        return call === 2;
      },
    });

    const response = await post(
      body({
        versions: [
          { kind: "put", body: bodyA, createdAt: 1_000 },
          { kind: "put", body: bodyB, createdAt: 1_001 },
          { kind: "put", body: bodyA, createdAt: 1_002 },
        ],
      }),
      "test-admin",
      bindings,
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal", message: "An internal error occurred." },
    });
    expect(text).not.toContain("Injected R2 put failure");
    expect(text).not.toContain("ROUTE_FAILURE");
    for (const { key } of attempts) expect(text).not.toContain(key);
    expect(calls).toEqual({ get: 0, put: 2 });
    expect(attempts.map(({ call }) => call)).toEqual([1, 2]);
    expect(attempts.map(({ key }) => parseBlobKey(key))).toEqual([
      expect.objectContaining({ format: "v2", stash: "route-import", hash: hashA }),
      expect.objectContaining({ format: "v2", stash: "route-import", hash: hashB }),
    ]);
    expect(await importCounts()).toEqual({ blobs: 0, versions: 0, files: 0 });
    expect(
      (await createTestEnv().env.BLOBS.list({ prefix: "v2/route-import/" })).objects.map(
        ({ key }) => key,
      ),
    ).toEqual([attempts[0]?.key]);
    await expect(createTestEnv().env.BLOBS.head(attempts[1]!.key)).resolves.toBeNull();
  });

  it("conceals the admin route from stash tokens", async () => {
    const token = await mintToken("route-import", "write");
    const response = await post(body(), token.token);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "The requested resource was not found." },
    });
  });

  it("returns generic 400 validation errors without echoing request bodies", async () => {
    const marker = "ZHS_IMPORT_BODY_MUST_NOT_BE_ECHOED";
    const response = await post(
      body({
        unexpected: marker,
        versions: [{ kind: "put", body: marker, createdAt: 1_000 }],
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toEqual({
      error: { code: "validation", message: "Invalid import input." },
    });
  });

  it("maps store-only timestamp validation to the same body-safe 400 shape", async () => {
    const marker = "ZHS_FUTURE_IMPORT_BODY_MUST_NOT_BE_ECHOED";
    const response = await post(
      body({ versions: [{ kind: "put", body: marker, createdAt: Date.now() + 60_000 }] }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "validation" } });
  });
});
