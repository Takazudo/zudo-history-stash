import { IDEMPOTENCY_TTL_DAYS } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { encodeLedgerCursor, encodeR2Cursor } from "../../src/gc.js";
import type { Env } from "../../src/env.js";
import { blobKey } from "../../src/d1/blobs.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const BASE_URL = "http://example.test";
const STASH = "gc-route";
const TTL_MS = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000;
const NOW = TTL_MS + 10_000;
const HASH = `sha256-${"a".repeat(64)}`;
const GENERATION = "11111111-1111-4111-8111-111111111111";
const fixedApp = createApp({ now: () => NOW });

function jsonRequest(
  path: string,
  body: unknown,
  bindings: Env = createTestEnv().env,
): Promise<Response> {
  return request(
    fixedApp,
    `${BASE_URL}${path}`,
    {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function adminRequest(path: string, bindings: Env = createTestEnv().env): Promise<Response> {
  return request(fixedApp, `${BASE_URL}${path}`, { headers: bearer("test-admin") }, bindings);
}

async function seedLedger(keys: readonly string[]): Promise<void> {
  const db = createTestEnv().env.DB;
  await db.batch(
    keys.map((key, index) =>
      db
        .prepare(
          `INSERT INTO idempotency
             (stash_name, key, request_hash, path, version, status_code, created_at)
           VALUES (?, ?, 'hash', 'path', 1, 201, ?)`,
        )
        .bind(STASH, key, index),
    ),
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("GC routes", () => {
  it("returns one run page and wraps recent runs in the public response shape", async () => {
    await seedLedger(["route-default"]);

    const run = await jsonRequest("/v1/admin/gc", { kind: "ledger" });
    expect(run.status).toBe(200);
    const runBody = await run.json<{
      runId: string;
      jobId: string;
      kind: string;
      dryRun: boolean;
      scanned: number;
      deleted: number;
      cursor: string | null;
      finishedAt: string | null;
    }>();
    expect(runBody).toMatchObject({
      jobId: "ledger",
      kind: "ledger",
      dryRun: false,
      scanned: 1,
      deleted: 1,
      cursor: null,
    });
    expect(runBody.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runBody.finishedAt).toBe(new Date(NOW).toISOString());

    const listed = await adminRequest("/v1/admin/gc/runs");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      runs: [expect.objectContaining({ runId: runBody.runId, jobId: "ledger" })],
    });
  });

  it("accepts an opaque explicit cursor and rejects malformed or kind-mismatched cursors", async () => {
    await seedLedger(["a", "b"]);
    const first = await jsonRequest("/v1/admin/gc", {
      kind: "ledger",
      dryRun: true,
      maxObjects: 1,
    });
    const firstBody = await first.json<{ cursor: string | null }>();
    expect(firstBody.cursor).not.toBeNull();

    const continuation = await jsonRequest("/v1/admin/gc", {
      kind: "ledger",
      dryRun: true,
      maxObjects: 1,
      cursor: firstBody.cursor!,
    });
    expect(continuation.status).toBe(200);
    await expect(continuation.json()).resolves.toMatchObject({ scanned: 1, deleted: 0 });

    const malformed = await jsonRequest("/v1/admin/gc", {
      kind: "ledger",
      cursor: "not-a-cursor",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "validation" } });

    const mismatch = await jsonRequest("/v1/admin/gc", {
      kind: "ledger",
      cursor: encodeR2Cursor("r2-page"),
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: "validation" } });
  });

  it("keeps dry runs non-mutating while pinning nullable and opaque fields", async () => {
    await seedLedger(["dry-run"]);
    const key = blobKey(STASH, HASH, GENERATION);
    await createTestEnv().env.BLOBS.put(key, "orphan");

    const response = await jsonRequest("/v1/admin/gc", {
      kind: "ledger",
      dryRun: true,
      maxObjects: 100,
      cursor: encodeLedgerCursor(1, 1),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dryRun: true,
      deleted: 0,
      cursor: null,
      finishedAt: expect.any(String),
    });
    await expect(
      createTestEnv().env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency").first(),
    ).resolves.toEqual({ count: 1 });
    await expect(createTestEnv().env.BLOBS.head(key)).resolves.not.toBeNull();
  });

  it("returns gc-busy when the requested kind has a live lease", async () => {
    await createTestEnv()
      .env.DB.prepare(
        "UPDATE gc_jobs SET lease_owner = 'busy-owner', lease_until = ? WHERE kind = 'ledger'",
      )
      .bind(NOW + 1_000)
      .run();

    const response = await jsonRequest("/v1/admin/gc", { kind: "ledger" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "gc-busy", message: "A garbage-collection run is already in progress." },
    });
  });

  it("lists runs newest first and preserves unfinished timestamps", async () => {
    const db = createTestEnv().env.DB;
    await db.batch([
      db
        .prepare(
          `INSERT INTO gc_runs
             (id, job_kind, lease_generation, dry_run, input_cursor, next_cursor,
              scanned, eligible, deleted, error, started_at, finished_at)
           VALUES (?, 'ledger', 1, 0, NULL, NULL, 1, 1, 1, NULL, ?, NULL)`,
        )
        .bind("00000000-0000-4000-8000-000000000001", NOW - 2),
      db
        .prepare(
          `INSERT INTO gc_runs
             (id, job_kind, lease_generation, dry_run, input_cursor, next_cursor,
              scanned, eligible, deleted, error, started_at, finished_at)
           VALUES (?, 'ledger', 2, 1, NULL, 'opaque-cursor', 2, 2, 0, NULL, ?, NULL)`,
        )
        .bind("00000000-0000-4000-8000-000000000002", NOW - 1),
    ]);

    const response = await adminRequest("/v1/admin/gc/runs?kind=ledger&limit=2");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runs: [
        expect.objectContaining({
          runId: "00000000-0000-4000-8000-000000000002",
          cursor: "opaque-cursor",
          finishedAt: null,
        }),
        expect.objectContaining({
          runId: "00000000-0000-4000-8000-000000000001",
          cursor: null,
          finishedAt: null,
        }),
      ],
    });
  });

  it("does not mutate a job when a request cursor is malformed", async () => {
    const before = await createTestEnv()
      .env.DB.prepare(
        "SELECT next_cursor, lease_owner, lease_generation, lease_until FROM gc_jobs WHERE kind = 'ledger'",
      )
      .first();
    const response = await jsonRequest("/v1/admin/gc", { kind: "ledger", cursor: "%%%" });
    expect(response.status).toBe(400);
    await expect(
      createTestEnv()
        .env.DB.prepare(
          "SELECT next_cursor, lease_owner, lease_generation, lease_until FROM gc_jobs WHERE kind = 'ledger'",
        )
        .first(),
    ).resolves.toEqual(before);
  });

  it("rejects an invalid query without invoking the run store", async () => {
    const response = await adminRequest("/v1/admin/gc/runs?limit=201");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "validation" } });
  });
});
