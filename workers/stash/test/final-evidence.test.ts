import { IDEMPOTENCY_TTL_DAYS, RunGcBody } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { blobKey, legacyBlobKey } from "../src/d1/blobs.js";
import { StorageOperationBudget, createGcStore } from "../src/d1/gc-store.js";
import { GC_ORPHAN_MIN_AGE_MS, createGcEngine } from "../src/gc.js";
import { bearer, request, resetDatabase, seedStash } from "./helpers/app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEDGER_TTL_MS = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000;

function gcInput(
  values: Partial<ReturnType<typeof RunGcBody.parse>> & { kind: "r2-orphans" | "ledger" },
) {
  return RunGcBody.parse(values);
}

function uniqueStash(label: string): string {
  return `gc-proof-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function putObject(key: string, body: string): Promise<R2Object> {
  const object = await env.BLOBS.put(key, body);
  if (object === null) throw new Error("R2 proof fixture could not be stored");
  return object;
}

async function seedLedger(
  stash: string,
  keys: readonly string[],
  createdAt: number,
): Promise<void> {
  await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare(
        `INSERT INTO idempotency
          (stash_name, key, request_hash, path, version, status_code, created_at)
         VALUES (?, ?, 'proof-hash', 'proof/path', 1, 201, ?)`,
      ).bind(stash, key, createdAt),
    ),
  );
}

async function ledgerKeys(stash: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT key FROM idempotency WHERE stash_name = ? ORDER BY created_at, rowid",
  )
    .bind(stash)
    .all<{ key: string }>();
  return rows.results.map(({ key }) => key);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("final lifecycle GC storage evidence", () => {
  it("dry-runs then collects only aged unreferenced v2 and legacy R2 objects", async () => {
    const stash = uniqueStash("r2");
    await seedStash(stash);

    const referencedHash = `sha256-${"1".repeat(64)}`;
    const orphanHash = `sha256-${"2".repeat(64)}`;
    const legacyHash = `sha256-${"3".repeat(64)}`;
    const referencedKey = blobKey(stash, referencedHash, crypto.randomUUID());
    const orphanKey = blobKey(stash, orphanHash, crypto.randomUUID());
    const legacyKey = legacyBlobKey(stash, legacyHash);
    const objects = await Promise.all([
      putObject(referencedKey, "referenced-generation"),
      putObject(orphanKey, "orphan-generation"),
      putObject(legacyKey, "legacy-orphan"),
    ]);
    await env.DB.prepare(
      `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
      .bind(stash, referencedHash, referencedKey, "referenced-generation".length, 0)
      .run();

    const now =
      Math.max(...objects.map(({ uploaded }) => uploaded.getTime())) + GC_ORPHAN_MIN_AGE_MS + 1;
    const dryRunId = "00000000-0000-4000-8000-000000000001";
    const liveRunId = "00000000-0000-4000-8000-000000000002";
    const dry = await createGcEngine(env, {
      now: () => now,
      createId: () => dryRunId,
      createOwner: () => "r2-proof-dry-owner",
    }).run(gcInput({ kind: "r2-orphans", dryRun: true, maxObjects: 24 }));

    expect(dry).toMatchObject({
      runId: dryRunId,
      jobId: "r2-orphans",
      kind: "r2-orphans",
      dryRun: true,
      scanned: 3,
      eligible: 2,
      deleted: 0,
      cursor: null,
      error: null,
    });
    await expect(
      Promise.all([
        env.BLOBS.head(referencedKey),
        env.BLOBS.head(orphanKey),
        env.BLOBS.head(legacyKey),
      ]),
    ).resolves.toEqual([expect.anything(), expect.anything(), expect.anything()]);

    const live = await createGcEngine(env, {
      now: () => now + 1,
      createId: () => liveRunId,
      createOwner: () => "r2-proof-live-owner",
    }).run(gcInput({ kind: "r2-orphans", maxObjects: 24 }));

    expect(live).toMatchObject({
      runId: liveRunId,
      jobId: "r2-orphans",
      kind: "r2-orphans",
      dryRun: false,
      scanned: 3,
      eligible: 2,
      deleted: 2,
      cursor: null,
      error: null,
    });
    expect(live.runId).not.toBe(dry.runId);
    expect(live.runId).toMatch(UUID);
    await expect(env.BLOBS.head(referencedKey)).resolves.not.toBeNull();
    await expect(env.BLOBS.head(orphanKey)).resolves.toBeNull();
    await expect(env.BLOBS.head(legacyKey)).resolves.toBeNull();

    const runs = await createGcStore(env, new StorageOperationBudget()).listRuns("r2-orphans", 10);
    expect(runs.map(({ runId }) => runId)).toEqual([liveRunId, dryRunId]);
    expect(runs.every(({ jobId, kind }) => jobId === "r2-orphans" && kind === jobId)).toBe(true);
    expect(JSON.stringify(runs)).not.toMatch(/r2_key|r2Key|v2\//u);
  });

  it("persists tied ledger cursors, fences a busy lease, orders runs, and restarts after null", async () => {
    const stash = uniqueStash("ledger");
    await seedStash(stash);
    const tiedKeys = ["tied-a", "tied-b", "tied-c"];
    const createdAt = 25;
    const baseNow = LEDGER_TTL_MS + 10_000;
    await seedLedger(stash, tiedKeys, createdAt);

    const dryRunId = "00000000-0000-4000-8000-000000000011";
    const firstRunId = "00000000-0000-4000-8000-000000000012";
    const secondRunId = "00000000-0000-4000-8000-000000000013";
    const restartRunId = "00000000-0000-4000-8000-000000000014";

    const dry = await createGcEngine(env, {
      now: () => baseNow,
      createId: () => dryRunId,
      createOwner: () => "ledger-proof-dry-owner",
    }).run(gcInput({ kind: "ledger", dryRun: true, maxObjects: 1 }));
    expect(dry).toMatchObject({
      jobId: "ledger",
      kind: "ledger",
      dryRun: true,
      scanned: 1,
      eligible: 1,
      deleted: 0,
    });
    expect(dry.cursor).not.toBeNull();
    expect(await ledgerKeys(stash)).toEqual(tiedKeys);
    await expect(
      env.DB.prepare("SELECT next_cursor FROM gc_jobs WHERE kind = 'ledger'").first<{
        next_cursor: string | null;
      }>(),
    ).resolves.toEqual({ next_cursor: null });

    const first = await createGcEngine(env, {
      now: () => baseNow + 100,
      createId: () => firstRunId,
      createOwner: () => "ledger-proof-first-owner",
    }).run(gcInput({ kind: "ledger", maxObjects: 1 }));
    expect(first).toMatchObject({ scanned: 1, eligible: 1, deleted: 1 });
    expect(first.cursor).not.toBeNull();
    expect(await ledgerKeys(stash)).toEqual(tiedKeys.slice(1));
    await expect(
      env.DB.prepare("SELECT next_cursor FROM gc_jobs WHERE kind = 'ledger'").first<{
        next_cursor: string | null;
      }>(),
    ).resolves.toEqual({ next_cursor: first.cursor });

    const busyStore = createGcStore(env, new StorageOperationBudget());
    const busyLease = await busyStore.acquire("ledger", "ledger-proof-busy-owner", baseNow + 150);
    const busyResponse = await request(
      createApp({ now: () => baseNow + 151 }),
      "http://example.test/v1/admin/gc",
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "ledger", maxObjects: 2 }),
      },
      env,
    );
    expect(busyResponse.status).toBe(409);
    await expect(busyResponse.json()).resolves.toEqual({
      error: {
        code: "gc-busy",
        message: "A garbage-collection run is already in progress.",
      },
    });
    await busyStore.release(busyLease, baseNow + 152);

    const second = await createGcEngine(env, {
      now: () => baseNow + 200,
      createId: () => secondRunId,
      createOwner: () => "ledger-proof-second-owner",
    }).run(gcInput({ kind: "ledger", maxObjects: 2 }));
    expect(second).toMatchObject({
      jobId: "ledger",
      kind: "ledger",
      scanned: 2,
      eligible: 2,
      deleted: 2,
      cursor: null,
      error: null,
    });
    expect(await ledgerKeys(stash)).toEqual([]);
    await expect(
      env.DB.prepare("SELECT next_cursor FROM gc_jobs WHERE kind = 'ledger'").first<{
        next_cursor: string | null;
      }>(),
    ).resolves.toEqual({ next_cursor: null });

    await seedLedger(stash, ["restarted-pass"], createdAt);
    const restarted = await createGcEngine(env, {
      now: () => baseNow + 300,
      createId: () => restartRunId,
      createOwner: () => "ledger-proof-restart-owner",
    }).run(gcInput({ kind: "ledger", maxObjects: 1 }));
    expect(restarted).toMatchObject({
      jobId: "ledger",
      kind: "ledger",
      scanned: 1,
      eligible: 1,
      deleted: 1,
      cursor: null,
      error: null,
    });
    expect(await ledgerKeys(stash)).toEqual([]);

    const runs = await createGcStore(env, new StorageOperationBudget()).listRuns("ledger", 10);
    expect(runs.map(({ runId }) => runId)).toEqual([
      restartRunId,
      secondRunId,
      firstRunId,
      dryRunId,
    ]);
    expect(new Set(runs.map(({ runId }) => runId)).size).toBe(4);
    expect(runs.every(({ runId }) => UUID.test(runId))).toBe(true);
    expect(runs.every(({ jobId, kind }) => jobId === "ledger" && kind === jobId)).toBe(true);
  });
});
