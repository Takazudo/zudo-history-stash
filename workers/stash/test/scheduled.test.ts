import { IDEMPOTENCY_TTL_DAYS } from "@takazudo/zudo-history-stash-core";
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { blobKey } from "../src/d1/blobs.js";
import type { Env } from "../src/env.js";
import { resetDatabase, seedStash } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

const STASH = "scheduled-gc";
const NOW = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000 + 10_000;
const HASH = `sha256-${"a".repeat(64)}`;

async function seedLedger(count: number): Promise<void> {
  const db = env.DB;
  await db.batch(
    Array.from({ length: count }, (_, index) =>
      db
        .prepare(
          `INSERT INTO idempotency
             (stash_name, key, request_hash, path, version, status_code, created_at)
           VALUES (?, ?, 'hash', 'path', 1, 201, ?)`,
        )
        .bind(STASH, `ledger-${index}`, index),
    ),
  );
}

function staleBucket(bucket: R2Bucket): R2Bucket {
  const uploaded = new Date(0);
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "list") {
        return async (...args: Parameters<R2Bucket["list"]>) => {
          const result = await target.list(...args);
          return {
            ...result,
            objects: result.objects.map((object) => ({ ...object, uploaded })),
          };
        };
      }
      if (property === "head") {
        return async (...args: Parameters<R2Bucket["head"]>) => {
          const object = await target.head(...args);
          return object === null ? null : { ...object, uploaded };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedOrphans(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await env.BLOBS.put(
      blobKey(STASH, HASH, `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`),
      String(index),
    );
  }
}

async function invokeScheduled(bindings: Env = createTestEnv().env): Promise<void> {
  const scheduled = worker.scheduled;
  if (scheduled === undefined) throw new Error("The Worker has no scheduled handler");
  const context = createExecutionContext();
  await scheduled(
    createScheduledController({ scheduledTime: new Date(NOW), cron: "17 3 * * *" }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await resetDatabase();
  await seedStash(STASH);
});

afterEach(() => vi.restoreAllMocks());

describe("scheduled GC orchestration", () => {
  it("attempts both kinds fairly, caps R2 pages at 24, and stops at the shared 45-op budget", async () => {
    await seedOrphans(50);
    await seedLedger(500);
    const bindings = createTestEnv().env;
    bindings.BLOBS = staleBucket(bindings.BLOBS);

    await invokeScheduled(bindings);

    const runs = await env.DB.prepare(
      `SELECT job_kind, scanned, eligible, deleted, next_cursor, finished_at
         FROM gc_runs ORDER BY rowid`,
    ).all<{
      job_kind: string;
      scanned: number;
      eligible: number;
      deleted: number;
      next_cursor: string | null;
      finished_at: number | null;
    }>();
    expect(runs.results).toHaveLength(3);
    expect(
      runs.results.map(({ job_kind, scanned, eligible, deleted }) => ({
        job_kind,
        scanned,
        eligible,
        deleted,
      })),
    ).toEqual([
      { job_kind: "r2-orphans", scanned: 24, eligible: 24, deleted: 24 },
      { job_kind: "ledger", scanned: 80, eligible: 80, deleted: 80 },
      { job_kind: "r2-orphans", scanned: 1, eligible: 1, deleted: 1 },
    ]);
    expect(runs.results.every(({ finished_at }) => finished_at === NOW)).toBe(true);
    expect(runs.results[0]?.next_cursor).not.toBeNull();
    expect(runs.results[1]?.next_cursor).not.toBeNull();
    expect(runs.results[2]?.next_cursor).not.toBeNull();

    const jobs = await env.DB.prepare("SELECT kind, next_cursor FROM gc_jobs ORDER BY kind").all<{
      kind: string;
      next_cursor: string | null;
    }>();
    expect(jobs.results).toEqual([
      { kind: "ledger", next_cursor: expect.any(String) },
      { kind: "r2-orphans", next_cursor: expect.any(String) },
    ]);
  });

  it("continues persisted cursors on the next invocation without skipping objects or ledger rows", async () => {
    await seedOrphans(50);
    await seedLedger(500);
    const bindings = createTestEnv().env;
    bindings.BLOBS = staleBucket(bindings.BLOBS);

    await invokeScheduled(bindings);
    await invokeScheduled(bindings);

    const remainingObjects = await bindings.BLOBS.list({ limit: 100 });
    expect(remainingObjects.objects).toHaveLength(0);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency").first(),
    ).resolves.toEqual({ count: 340 });
    await expect(
      env.DB.prepare("SELECT next_cursor FROM gc_jobs WHERE kind = 'r2-orphans'").first(),
    ).resolves.toEqual({ next_cursor: null });
    const r2Runs = await env.DB.prepare(
      "SELECT scanned, deleted FROM gc_runs WHERE job_kind = 'r2-orphans' ORDER BY rowid",
    ).all<{ scanned: number; deleted: number }>();
    expect(r2Runs.results).toEqual([
      { scanned: 24, deleted: 24 },
      { scanned: 1, deleted: 1 },
      { scanned: 24, deleted: 24 },
      { scanned: 1, deleted: 1 },
    ]);
  });

  it("surfaces scheduled setup errors through waitUntil", async () => {
    const bindings = createTestEnv({ env: { GC_ORPHAN_MIN_AGE_MS: "899999" } }).env;
    const scheduled = worker.scheduled;
    if (scheduled === undefined) throw new Error("The Worker has no scheduled handler");
    const context = createExecutionContext();
    await scheduled(
      createScheduledController({ scheduledTime: new Date(NOW), cron: "17 3 * * *" }),
      bindings,
      context,
    );
    await expect(waitOnExecutionContext(context)).rejects.toThrow(
      "GC_ORPHAN_MIN_AGE_MS must be exactly 900000",
    );
  });
});
