import { RunGcBody } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { GcLeaseLostError } from "../src/d1/gc-store.js";
import { buildChangeSetDeletes } from "../src/d1/sql/gc.js";
import type { Env } from "../src/env.js";
import {
  GC_CHANGE_SET_RETENTION_MS,
  GcCursorValidationError,
  createGcEngine,
  decodeGcCursor,
  encodeContentCursor,
  encodeLedgerCursor,
} from "../src/gc.js";
import { bearer, request, resetDatabase, seedStash } from "./helpers/app.js";

const STASH = "gc-change-sets";
const DELETED_STASH = "gc-change-sets-deleted";
const NOW = GC_CHANGE_SET_RETENTION_MS + 1_000;
const CUTOFF = NOW - GC_CHANGE_SET_RETENTION_MS;

function changeSetId(value: number): string {
  return `chs_${String(value).padStart(13, "0")}aaaaaaaa`;
}

function input(values: Partial<ReturnType<typeof RunGcBody.parse>> & { kind: "change-sets" }) {
  return RunGcBody.parse(values);
}

function withR2Counts(bindings: Env, calls: { list: number; head: number; delete: number }): Env {
  const bucket = new Proxy(bindings.BLOBS, {
    get(target, property) {
      if (property === "list") {
        return async (...args: Parameters<R2Bucket["list"]>) => {
          calls.list += 1;
          return target.list(...args);
        };
      }
      if (property === "head") {
        return async (...args: Parameters<R2Bucket["head"]>) => {
          calls.head += 1;
          return target.head(...args);
        };
      }
      if (property === "delete") {
        return async (...args: Parameters<R2Bucket["delete"]>) => {
          calls.delete += 1;
          return target.delete(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...bindings, BLOBS: bucket };
}

async function seedChangeSet(values: {
  id: string;
  status: "open" | "applied" | "rejected";
  expiresAt: number;
  decidedAt?: number | null;
  stash?: string;
  entries?: number;
}): Promise<void> {
  const stash = values.stash ?? STASH;
  await env.DB.prepare(
    `INSERT INTO change_sets
       (id, stash_name, status, expires_at, created_by, created_at, decided_at)
     VALUES (?, ?, ?, ?, 'test', 0, ?)`,
  )
    .bind(values.id, stash, values.status, values.expiresAt, values.decidedAt ?? null)
    .run();
  for (let index = 0; index < (values.entries ?? 1); index += 1) {
    await env.DB.prepare(
      `INSERT INTO change_set_entries (change_set_id, stash_name, path, op)
       VALUES (?, ?, ?, 'delete')`,
    )
      .bind(values.id, stash, `${values.id}-${index}.txt`)
      .run();
  }
}

async function survivingIds(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT id FROM change_sets ORDER BY id").all<{ id: string }>();
  return rows.results.map(({ id }) => id);
}

async function entryCount(id: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM change_set_entries WHERE change_set_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function tableCounts(): Promise<{ changeSets: number; entries: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM change_sets) AS changeSets,
       (SELECT COUNT(*) FROM change_set_entries) AS entries`,
  ).first<{ changeSets: number; entries: number }>();
  if (row === null) throw new Error("Missing change-set table counts");
  return row;
}

async function persistedCursor(): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT next_cursor FROM gc_jobs WHERE kind = 'change-sets'",
  ).first<{ next_cursor: string | null }>();
  if (row === null) throw new Error("Missing change-set GC job");
  return row.next_cursor;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
  await seedStash(DELETED_STASH);
  await env.DB.prepare("UPDATE stashes SET deleted_at = 1 WHERE name = ?")
    .bind(DELETED_STASH)
    .run();
});

describe("change-set garbage collection", () => {
  it("applies both retention clocks at the inclusive boundary and never reclaims applied sets", async () => {
    const expiredBoundary = changeSetId(1);
    const freshOpen = changeSetId(2);
    const applied = changeSetId(3);
    const rejectedBoundary = changeSetId(4);
    const freshRejected = changeSetId(5);
    const rejectedExpiryFallback = changeSetId(6);
    await seedChangeSet({ id: expiredBoundary, status: "open", expiresAt: CUTOFF });
    await seedChangeSet({ id: freshOpen, status: "open", expiresAt: CUTOFF + 1 });
    await seedChangeSet({ id: applied, status: "applied", expiresAt: 0 });
    await seedChangeSet({
      id: rejectedBoundary,
      status: "rejected",
      expiresAt: CUTOFF + 1,
      decidedAt: CUTOFF,
    });
    await seedChangeSet({
      id: freshRejected,
      status: "rejected",
      expiresAt: 0,
      decidedAt: CUTOFF + 1,
    });
    await seedChangeSet({
      id: rejectedExpiryFallback,
      status: "rejected",
      expiresAt: CUTOFF,
      decidedAt: null,
    });

    const expired = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets" }),
    );
    expect(expired).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    expect(decodeGcCursor("change-sets", expired.cursor!)).toEqual({
      v: 1,
      kind: "change-sets",
      phase: "rejected",
      afterId: null,
    });
    expect(await survivingIds()).toEqual([
      freshOpen,
      applied,
      rejectedBoundary,
      freshRejected,
      rejectedExpiryFallback,
    ]);

    const rejected = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets", cursor: expired.cursor! }),
    );
    expect(rejected).toMatchObject({ scanned: 2, eligible: 2, deleted: 2, cursor: null });
    expect(await survivingIds()).toEqual([freshOpen, applied, freshRejected]);
    await expect(entryCount(applied)).resolves.toBe(1);
  });

  it("reclaims a soft-deleted stash child-first, counts parents, and never accesses R2", async () => {
    const id = changeSetId(1);
    await seedChangeSet({
      id,
      stash: DELETED_STASH,
      status: "open",
      expiresAt: CUTOFF,
      entries: 3,
    });
    const calls = { list: 0, head: 0, delete: 0 };

    const result = await createGcEngine(withR2Counts(env, calls), { now: () => NOW }).run(
      input({ kind: "change-sets" }),
    );

    expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    await expect(survivingIds()).resolves.toEqual([]);
    await expect(entryCount(id)).resolves.toBe(0);
    expect(calls).toEqual({ list: 0, head: 0, delete: 0 });
  });

  it("guards the parent delete when an entry survives", async () => {
    const id = changeSetId(1);
    const owner = "change-set-parent-guard";
    const generation = 7;
    await seedChangeSet({ id, status: "open", expiresAt: CUTOFF });
    await env.DB.prepare(
      `UPDATE gc_jobs
       SET lease_owner = ?, lease_generation = ?
       WHERE kind = 'change-sets'`,
    )
      .bind(owner, generation)
      .run();
    const batch = buildChangeSetDeletes(env.DB, {
      phase: "expired",
      rows: [{ id }],
      cutoff: CUTOFF,
      kind: "change-sets",
      owner,
      generation,
    });

    const results = await env.DB.batch([batch.statements[batch.parentIndexes[0]!]!]);

    expect(results[0]?.meta.changes).toBe(0);
    await expect(survivingIds()).resolves.toEqual([id]);
    await expect(entryCount(id)).resolves.toBe(1);
  });

  it("reports dry-run eligibility without mutating either table or persisting progress", async () => {
    await seedChangeSet({ id: changeSetId(1), status: "open", expiresAt: CUTOFF });
    await seedChangeSet({ id: changeSetId(2), status: "open", expiresAt: CUTOFF });
    const before = await tableCounts();

    const result = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets", dryRun: true, maxObjects: 1 }),
    );

    expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 0, error: null });
    expect(result.cursor).not.toBeNull();
    await expect(tableCounts()).resolves.toEqual(before);
    await expect(persistedCursor()).resolves.toBeNull();
  });

  it("pages by id, persists resume progress, and hands off from expired to rejected", async () => {
    const expired = [changeSetId(1), changeSetId(2), changeSetId(3)];
    const rejected = changeSetId(4);
    for (const id of expired) {
      await seedChangeSet({ id, status: "open", expiresAt: CUTOFF });
    }
    await seedChangeSet({
      id: rejected,
      status: "rejected",
      expiresAt: CUTOFF,
      decidedAt: CUTOFF,
    });

    const first = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets", maxObjects: 2 }),
    );
    expect(first).toMatchObject({ scanned: 2, eligible: 2, deleted: 2, error: null });
    expect(decodeGcCursor("change-sets", first.cursor!)).toEqual({
      v: 1,
      kind: "change-sets",
      phase: "expired",
      afterId: expired[1],
    });
    await expect(persistedCursor()).resolves.toBe(first.cursor);
    await expect(survivingIds()).resolves.toEqual([expired[2], rejected]);

    const handoff = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets", maxObjects: 2 }),
    );
    expect(handoff).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, error: null });
    expect(decodeGcCursor("change-sets", handoff.cursor!)).toEqual({
      v: 1,
      kind: "change-sets",
      phase: "rejected",
      afterId: null,
    });
    await expect(persistedCursor()).resolves.toBe(handoff.cursor);
    await expect(survivingIds()).resolves.toEqual([rejected]);

    const complete = await createGcEngine(env, { now: () => NOW }).run(
      input({ kind: "change-sets", maxObjects: 2 }),
    );
    expect(complete).toMatchObject({
      scanned: 1,
      eligible: 1,
      deleted: 1,
      cursor: null,
      error: null,
    });
    await expect(persistedCursor()).resolves.toBeNull();
    await expect(survivingIds()).resolves.toEqual([]);
    const runRows = await env.DB.prepare(
      "SELECT scanned, deleted FROM gc_runs WHERE job_kind = 'change-sets' ORDER BY started_at, id",
    ).all<{ scanned: number; deleted: number }>();
    expect(runRows.results).toHaveLength(3);
    expect(runRows.results.reduce((total, row) => total + row.deleted, 0)).toBe(4);
  });

  it("rejects cross-kind and malformed cursors before running the change-set job", async () => {
    for (const cursor of [encodeContentCursor("blobs", null), encodeLedgerCursor(1, 1), "%%%"])
      await expect(
        createGcEngine(env, { now: () => NOW }).run(input({ kind: "change-sets", cursor })),
      ).rejects.toThrow(GcCursorValidationError);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM gc_runs").first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rechecks eligibility after selection and preserves a row changed to applied", async () => {
    const protectedId = changeSetId(1);
    const deletedId = changeSetId(2);
    await seedChangeSet({ id: protectedId, status: "open", expiresAt: CUTOFF });
    await seedChangeSet({ id: deletedId, status: "open", expiresAt: CUTOFF });
    let hookCalls = 0;

    const result = await createGcEngine(env, {
      now: () => NOW,
      hooks: {
        beforeDelete: async () => {
          hookCalls += 1;
          await env.DB.prepare("UPDATE change_sets SET status = 'applied' WHERE id = ?")
            .bind(protectedId)
            .run();
        },
      },
    }).run(input({ kind: "change-sets" }));

    expect(hookCalls).toBe(1);
    expect(result).toMatchObject({ scanned: 2, eligible: 2, deleted: 1, error: null });
    expect(result.eligible).toBeGreaterThan(result.deleted);
    await expect(survivingIds()).resolves.toEqual([protectedId]);
    await expect(entryCount(protectedId)).resolves.toBe(1);
    await expect(entryCount(deletedId)).resolves.toBe(0);
  });

  it("loses the lease without deleting rows or finishing the run", async () => {
    const id = changeSetId(1);
    const runId = "run-change-set-lease-loss";
    await seedChangeSet({ id, status: "open", expiresAt: CUTOFF });
    const engine = createGcEngine(env, {
      now: () => NOW,
      createId: () => runId,
      hooks: {
        beforeDelete: async () => {
          await env.DB.prepare(
            `UPDATE gc_jobs SET lease_generation = lease_generation + 1
             WHERE kind = 'change-sets'`,
          ).run();
        },
      },
    });

    await expect(engine.run(input({ kind: "change-sets" }))).rejects.toThrow(GcLeaseLostError);
    await expect(survivingIds()).resolves.toEqual([id]);
    await expect(entryCount(id)).resolves.toBe(1);
    await expect(
      env.DB.prepare("SELECT finished_at FROM gc_runs WHERE id = ?")
        .bind(runId)
        .first<{ finished_at: number | null }>(),
    ).resolves.toEqual({ finished_at: null });
  });

  it("reclaims terminal sets end to end while an in-retention set remains listable", async () => {
    const expired = changeSetId(1);
    const rejected = changeSetId(2);
    const rejectedFallback = changeSetId(3);
    const survivor = changeSetId(4);
    await seedChangeSet({ id: expired, status: "open", expiresAt: CUTOFF });
    await seedChangeSet({
      id: rejected,
      status: "rejected",
      expiresAt: CUTOFF + 1,
      decidedAt: CUTOFF,
    });
    await seedChangeSet({
      id: rejectedFallback,
      status: "rejected",
      expiresAt: CUTOFF,
      decidedAt: null,
    });
    await seedChangeSet({ id: survivor, status: "open", expiresAt: CUTOFF + 1 });

    let cursor: string | null | undefined;
    let pages = 0;
    do {
      pages += 1;
      const result = await createGcEngine(env, { now: () => NOW }).run(
        input({
          kind: "change-sets",
          maxObjects: 1,
          ...(typeof cursor === "string" ? { cursor } : {}),
        }),
      );
      expect(result.error).toBeNull();
      cursor = result.cursor;
    } while (cursor !== null && pages < 10);
    expect(cursor).toBeNull();

    await expect(survivingIds()).resolves.toEqual([survivor]);
    for (const id of [expired, rejected, rejectedFallback]) {
      await expect(entryCount(id)).resolves.toBe(0);
    }
    await expect(entryCount(survivor)).resolves.toBe(1);

    const response = await request(
      createApp({ now: () => NOW }),
      `http://localhost/v1/stashes/${STASH}/change-sets?status=expired`,
      { headers: bearer(env.STASH_ADMIN_TOKEN) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      changeSets: [{ id: survivor, status: "expired" }],
    });
  });
});
