import { env } from "cloudflare:workers";
import {
  BODY_LIMIT_BYTES,
  MAX_BODY_BYTES,
  R2_SPILL_BYTES,
  sha256Hex,
} from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { parseBlobKey } from "../../src/d1/blobs.js";
import type { Env } from "../../src/env.js";
import { request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";
import { escapedImportRequest, type EncodedRequest } from "../helpers/large-json.js";

const STASH = "route-limits";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

async function encodedApi(
  path: string,
  encoded: EncodedRequest,
  bindings: Env = createTestEnv().env,
  token: string | null = "test-admin",
): Promise<Response> {
  const headers = new Headers({
    "Content-Length": String(encoded.byteLength),
    "Content-Type": "application/json",
  });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return request(
    app,
    `${BASE}${path}`,
    {
      method: "POST",
      headers,
      body: encoded.body,
    },
    bindings,
  );
}

interface DatabaseSnapshot {
  stashes: Record<string, unknown>[];
  files: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  blobs: Record<string, unknown>[];
  idempotency: Record<string, unknown>[];
}

async function databaseSnapshot(db: D1Database): Promise<DatabaseSnapshot> {
  const [stashes, files, versions, blobs, idempotency] = await Promise.all([
    db
      .prepare("SELECT name, description, meta_json, created_at FROM stashes ORDER BY name")
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT stash_name, path, head_version, head_hash, deleted, created_at, updated_at
         FROM files ORDER BY stash_name, path`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT id, stash_name, path, version, kind, blob_hash, size_bytes, content_type,
                rollback_of, author, message, meta_json, created_at
         FROM versions ORDER BY id`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT stash_name, hash, body, r2_key, size_bytes, created_at
         FROM blobs ORDER BY stash_name, hash`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT stash_name, key, request_hash, path, version, status_code, created_at
         FROM idempotency ORDER BY stash_name, key`,
      )
      .all<Record<string, unknown>>(),
  ]);
  return {
    stashes: stashes.results,
    files: files.results,
    versions: versions.results,
    blobs: blobs.results,
    idempotency: idempotency.results,
  };
}

function rejectingDatabase(db: D1Database, calls: { value: number }): D1Database {
  const rejected = new Set<PropertyKey>(["prepare", "batch", "exec", "withSession"]);
  return new Proxy(db, {
    get(target, property) {
      if (rejected.has(property)) {
        return () => {
          calls.value += 1;
          throw new Error(`Unexpected D1 ${String(property)} call`);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe.sequential("raised request and text limits", () => {
  it("stores a 4.9 MB text body through the route as an R2 pointer", async () => {
    const body = "s".repeat(4_900_000);
    const hash = await sha256Hex(body);
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(createTestEnv().env, { count: calls });
    const payload = JSON.stringify({ body, expectedVersion: null });

    const response = await request(
      app,
      `${BASE}/files/large.txt`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: payload,
      },
      bindings,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ version: 1, hash, size: 4_900_000 });
    expect(calls).toEqual({ get: 0, put: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM files").first()).resolves.toEqual({
      count: 1,
    });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first()).resolves.toEqual(
      { count: 1 },
    );
    const row = await env.DB.prepare(
      "SELECT hash, body, r2_key, size_bytes FROM blobs WHERE stash_name = ? AND hash = ?",
    )
      .bind(STASH, hash)
      .first<{ hash: string; body: string | null; r2_key: string | null; size_bytes: number }>();
    expect(row).toMatchObject({ hash, body: null, size_bytes: 4_900_000 });
    if (row?.r2_key === null || row?.r2_key === undefined) throw new Error("Expected R2 pointer");
    expect(parseBlobKey(row.r2_key)).toMatchObject({ format: "v2", stash: STASH, hash });
    await expect(bindings.BLOBS.head(row.r2_key)).resolves.toMatchObject({
      key: row.r2_key,
      size: 4_900_000,
    });
  }, 60_000);

  it("imports several individually valid spilled bodies below the aggregate limit", async () => {
    const encoded = escapedImportRequest(5, 800_001);
    expect(encoded.byteLength).toBeLessThan(BODY_LIMIT_BYTES);
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(createTestEnv().env, { count: calls });

    const response = await encodedApi("/import", encoded, bindings);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      path: "history.txt",
      headVersion: 5,
    });
    expect(calls).toEqual({ get: 0, put: 5 });
    const blobs = await env.DB.prepare(
      `SELECT body, r2_key, size_bytes FROM blobs
       WHERE stash_name = ? ORDER BY hash`,
    )
      .bind(STASH)
      .all<{ body: string | null; r2_key: string | null; size_bytes: number }>();
    expect(blobs.results).toHaveLength(5);
    for (const blob of blobs.results) {
      expect(blob).toMatchObject({ body: null, size_bytes: 800_001 });
      expect(parseBlobKey(blob.r2_key ?? "")).toMatchObject({ format: "v2", stash: STASH });
    }
    const versions = await env.DB.prepare(
      `SELECT version, size_bytes FROM versions
       WHERE stash_name = ? AND path = ? ORDER BY version`,
    )
      .bind(STASH, "history.txt")
      .all<{ version: number; size_bytes: number }>();
    expect(versions.results).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ version: index + 1, size_bytes: 800_001 })),
    );
    await expect(
      env.DB.prepare("SELECT head_version, deleted FROM files WHERE stash_name = ? AND path = ?")
        .bind(STASH, "history.txt")
        .first(),
    ).resolves.toEqual({ head_version: 5, deleted: 0 });
    const objects = await bindings.BLOBS.list({ prefix: `v2/${STASH}/` });
    expect(objects.objects).toHaveLength(5);
    expect(objects.objects.every(({ size }) => size === 800_001)).toBe(true);
  }, 60_000);

  it("rejects an over-32 MiB import before authentication or storage access", async () => {
    const realBindings = createTestEnv().env;
    const before = await databaseSnapshot(realBindings.DB);
    const encoded = escapedImportRequest(7, 800_001);
    expect(encoded.byteLength).toBeGreaterThan(BODY_LIMIT_BYTES);
    expect(800_001).toBeLessThanOrEqual(MAX_BODY_BYTES);

    const d1Calls = { value: 0 };
    const blobCalls: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(
      { ...realBindings, DB: rejectingDatabase(realBindings.DB, d1Calls) },
      { count: blobCalls, failGet: true, failPut: true },
    );

    const response = await encodedApi("/import", encoded, bindings, null);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "payload-too-large", message: "The request payload is too large." },
    });
    expect(d1Calls.value).toBe(0);
    expect(blobCalls).toEqual({ get: 0, put: 0 });
    await expect(databaseSnapshot(realBindings.DB)).resolves.toEqual(before);
    await expect(realBindings.BLOBS.list({ prefix: `v2/${STASH}/` })).resolves.toMatchObject({
      objects: [],
    });
  }, 60_000);

  it("continues to serve a legacy oversized inline D1 body without touching R2", async () => {
    const body = "l".repeat(R2_SPILL_BYTES + 1);
    const hash = await sha256Hex(body);
    const createdAt = 1_780_000_000_000;
    await env.DB.prepare(
      `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
      .bind(STASH, hash, body, R2_SPILL_BYTES + 1, createdAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO versions (
        stash_name, path, version, kind, blob_hash, size_bytes, content_type,
        rollback_of, author, message, meta_json, created_at
      ) VALUES (?, ?, 1, 'put', ?, ?, 'text/plain; charset=utf-8', NULL, ?, ?, ?, ?)`,
    )
      .bind(
        STASH,
        "legacy-inline.txt",
        hash,
        R2_SPILL_BYTES + 1,
        "legacy",
        "pre-spill row",
        '{"source":"legacy"}',
        createdAt,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO files (
        stash_name, path, head_version, head_hash, deleted, created_at, updated_at
      ) VALUES (?, ?, 1, ?, 0, ?, ?)`,
    )
      .bind(STASH, "legacy-inline.txt", hash, createdAt, createdAt)
      .run();
    const calls: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(createTestEnv().env, { count: calls, failGet: true });

    const response = await request(
      app,
      `${BASE}/files/legacy-inline.txt`,
      { headers: { Authorization: "Bearer test-admin" } },
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "legacy-inline.txt",
      version: 1,
      hash,
      size: R2_SPILL_BYTES + 1,
      kind: "put",
      author: "legacy",
      message: "pre-spill row",
      meta: { source: "legacy" },
      createdAt: new Date(createdAt).toISOString(),
      deleted: false,
      body,
    });
    expect(calls).toEqual({ get: 0, put: 0 });
  }, 30_000);
});
