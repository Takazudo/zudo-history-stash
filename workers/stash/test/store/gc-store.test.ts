import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GC_LEASE_TTL_MS,
  GcLeaseLostError,
  GcLeaseUnavailableError,
  StorageOperationBudget,
  createGcStore,
  parseGcLeaseTtlMs,
} from "../../src/d1/gc-store.js";
import { resetDatabase } from "../helpers/app.js";

beforeEach(resetDatabase);

function store(limit = 100) {
  const budget = new StorageOperationBudget(limit);
  return { budget, gc: createGcStore(env, budget) };
}

describe("fenced GC leases", () => {
  it("requires the configured exact 300000ms lease TTL", () => {
    expect(parseGcLeaseTtlMs("300000")).toBe(300_000);
    expect(() => parseGcLeaseTtlMs("299999")).toThrow("must be exactly 300000");
    expect(() => parseGcLeaseTtlMs("invalid")).toThrow("must be exactly 300000");
  });

  it("contends until the exact expiry boundary and increments the generation", async () => {
    const { gc } = store();
    const first = await gc.acquire("ledger", "owner-a", 1_000);
    expect(first).toMatchObject({ owner: "owner-a", generation: 1 });
    await expect(
      gc.acquire("ledger", "owner-b", 1_000 + GC_LEASE_TTL_MS - 1),
    ).rejects.toBeInstanceOf(GcLeaseUnavailableError);
    const successor = await gc.acquire("ledger", "owner-b", 1_000 + GC_LEASE_TTL_MS);
    expect(successor).toMatchObject({ owner: "owner-b", generation: 2 });
  });

  it("rejects stale owner/generation heartbeat, finalize, and release", async () => {
    const { gc } = store();
    const lease = await gc.acquire("ledger", "owner-a", 0);
    const run = await gc.startRun(lease, "run-a", false, null, 0);
    await gc.acquire("ledger", "owner-b", GC_LEASE_TTL_MS);

    await expect(gc.heartbeat(run, GC_LEASE_TTL_MS)).rejects.toBeInstanceOf(GcLeaseLostError);
    await expect(gc.release(lease, GC_LEASE_TTL_MS)).rejects.toBeInstanceOf(GcLeaseLostError);
    await expect(
      gc.finish(run, {
        nextCursor: null,
        scanned: 1,
        eligible: 1,
        deleted: 1,
        error: null,
        finishedAt: GC_LEASE_TTL_MS,
      }),
    ).rejects.toBeInstanceOf(GcLeaseLostError);
    const row = await env.DB.prepare("SELECT finished_at FROM gc_runs WHERE id = 'run-a'").first<{
      finished_at: number | null;
    }>();
    expect(row?.finished_at).toBeNull();
  });

  it("does not persist or release when the fenced run finalization changes zero rows", async () => {
    const { gc } = store();
    const lease = await gc.acquire("ledger", "owner-a", 0);
    const run = await gc.startRun(lease, "missing-run", false, null, 0);
    await env.DB.prepare("DELETE FROM gc_runs WHERE id = 'missing-run'").run();
    await expect(
      gc.finish(run, {
        nextCursor: "must-not-persist",
        scanned: 1,
        eligible: 1,
        deleted: 0,
        error: null,
        finishedAt: 1,
      }),
    ).rejects.toBeInstanceOf(GcLeaseLostError);
    const job = await env.DB.prepare(
      "SELECT next_cursor, lease_owner FROM gc_jobs WHERE kind = 'ledger'",
    ).first<{ next_cursor: string | null; lease_owner: string | null }>();
    expect(job).toEqual({ next_cursor: null, lease_owner: "owner-a" });
  });

  it("leaves a crashed run unfinished and permits exact-boundary recovery", async () => {
    const { gc } = store();
    const lease = await gc.acquire("r2-orphans", "crashed", 10);
    await gc.startRun(lease, "crashed-run", false, null, 10);
    expect(await gc.listRuns("r2-orphans", 10)).toEqual([
      expect.objectContaining({ runId: "crashed-run", finishedAt: null }),
    ]);

    const successor = await gc.acquire("r2-orphans", "successor", 10 + GC_LEASE_TTL_MS);
    expect(successor.generation).toBe(2);
  });

  it("keeps only the newest 500 runs for a kind after fenced finalization", async () => {
    const statements = Array.from({ length: 501 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO gc_runs
          (id, job_kind, lease_generation, started_at, finished_at)
         VALUES (?, 'ledger', 0, ?, ?)`,
      ).bind(`old-${String(index).padStart(3, "0")}`, index, index),
    );
    await env.DB.batch(statements);
    const { gc } = store();
    const lease = await gc.acquire("ledger", "pruner", 1_000);
    const run = await gc.startRun(lease, "new-run", false, null, 1_000);
    await gc.finish(run, {
      nextCursor: null,
      scanned: 0,
      eligible: 0,
      deleted: 0,
      error: null,
      finishedAt: 1_001,
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM gc_runs WHERE job_kind = 'ledger'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(500);
    expect(
      await env.DB.prepare("SELECT 1 FROM gc_runs WHERE id = 'new-run'").first(),
    ).not.toBeNull();
  });
});
