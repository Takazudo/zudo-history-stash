import { IDEMPOTENCY_TTL_DAYS, RunGcBody } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { blobKey, legacyBlobKey } from "../src/d1/blobs.js";
import { StorageOperationBudget } from "../src/d1/gc-store.js";
import {
  GcCursorValidationError,
  createGcEngine,
  decodeGcCursor,
  encodeLedgerCursor,
  encodeR2Cursor,
} from "../src/gc.js";
import type { Env } from "../src/env.js";
import { resetDatabase, seedStash } from "./helpers/app.js";

const STASH = "gc-test";
const HASH_A = `sha256-${"a".repeat(64)}`;
const HASH_B = `sha256-${"b".repeat(64)}`;
const GENERATION = "11111111-1111-4111-8111-111111111111";
const TTL_MS = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000;

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

function input(
  values: Partial<ReturnType<typeof RunGcBody.parse>> & { kind: "r2-orphans" | "ledger" },
) {
  return RunGcBody.parse(values);
}

async function putObject(key: string, body = key): Promise<R2Object> {
  const object = await env.BLOBS.put(key, body);
  if (object === null) throw new Error("R2 put failed");
  return object;
}

async function reference(key: string, hash = HASH_A): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
     VALUES (?, ?, NULL, ?, 1, 0)`,
  )
    .bind(STASH, hash, key)
    .run();
}

function futureNow(object: R2Object, extra = 1): number {
  return object.uploaded.getTime() + 900_000 + extra;
}

function withR2Counts(
  bindings: Env,
  calls: { list: number; head: number; delete: number; arrays: number[] },
): Env {
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
        return async (keys: string | string[]) => {
          calls.delete += 1;
          calls.arrays.push(Array.isArray(keys) ? keys.length : 1);
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...bindings, BLOBS: bucket };
}

function withD1Count(bindings: Env, calls: { d1: number; d1BatchSizes?: number[] }): Env {
  function statement(source: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(source, {
      get(target, property) {
        if (property === "bind") {
          return (...args: unknown[]) => statement(Reflect.apply(target.bind, target, args));
        }
        const value = Reflect.get(target, property, target);
        if (
          property === "run" ||
          property === "all" ||
          property === "first" ||
          property === "raw"
        ) {
          return (...args: unknown[]) => {
            calls.d1 += 1;
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  function session(source: D1DatabaseSession): D1DatabaseSession {
    return new Proxy(source, {
      get(target, property) {
        if (property === "prepare") return (query: string) => statement(target.prepare(query));
        if (property === "batch") {
          return (...args: Parameters<D1DatabaseSession["batch"]>) => {
            calls.d1 += 1;
            calls.d1BatchSizes?.push(args[0].length);
            return target.batch(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const db = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "prepare") return (query: string) => statement(target.prepare(query));
      if (property === "withSession") {
        return (...args: Parameters<D1Database["withSession"]>) =>
          session(target.withSession(...args));
      }
      if (property === "batch") {
        return (...args: Parameters<D1Database["batch"]>) => {
          calls.d1 += 1;
          calls.d1BatchSizes?.push(args[0].length);
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...bindings, DB: db };
}

describe("strict GC cursors", () => {
  it("rejects invalid orphan-age configuration instead of normalizing it", () => {
    expect(() => createGcEngine({ ...env, GC_ORPHAN_MIN_AGE_MS: "899999" })).toThrow(
      "GC_ORPHAN_MIN_AGE_MS must be exactly 900000",
    );
  });

  it("round trips exact kind-bound v1 envelopes", () => {
    const r2 = encodeR2Cursor("opaque");
    const ledger = encodeLedgerCursor(10, 2);
    expect(decodeGcCursor("r2-orphans", r2)).toEqual({
      v: 1,
      kind: "r2-orphans",
      value: "opaque",
    });
    expect(decodeGcCursor("ledger", ledger)).toEqual({
      v: 1,
      kind: "ledger",
      createdAt: 10,
      rowid: 2,
    });
    expect(() => decodeGcCursor("ledger", r2)).toThrow(GcCursorValidationError);
  });

  it.each([
    "not base64!",
    btoa("not json"),
    btoa(JSON.stringify({ v: 2, kind: "ledger", createdAt: 1, rowid: 1 })).replaceAll("=", ""),
    btoa(JSON.stringify({ v: 1, kind: "ledger", createdAt: 1, rowid: 1, extra: true })).replaceAll(
      "=",
      "",
    ),
    btoa(JSON.stringify({ v: 1, kind: "ledger", createdAt: 1.5, rowid: 1 })).replaceAll("=", ""),
  ])("rejects malformed cursor %s", (cursor) => {
    expect(() => decodeGcCursor("ledger", cursor)).toThrow(GcCursorValidationError);
  });

  it("finalizes a corrupt persisted cursor as an error without stranding the lease", async () => {
    await env.DB.prepare("UPDATE gc_jobs SET next_cursor = 'corrupt!' WHERE kind = 'ledger'").run();
    const result = await createGcEngine(env).run(input({ kind: "ledger" }));
    expect(result.error).toBe("Garbage collection page failed");
    const job = await env.DB.prepare(
      "SELECT next_cursor, lease_owner, lease_until FROM gc_jobs WHERE kind = 'ledger'",
    ).first<{
      next_cursor: string | null;
      lease_owner: string | null;
      lease_until: number | null;
    }>();
    expect(job).toEqual({ next_cursor: "corrupt!", lease_owner: null, lease_until: null });
  });
});

describe("R2 orphan collection", () => {
  it("classifies exact legacy/v2 keys, references, malformed keys, and strict age boundaries", async () => {
    const legacy = legacyBlobKey(STASH, HASH_A);
    const v2 = blobKey(STASH, HASH_B, GENERATION);
    const malformed = `${STASH}/sha256-${"A".repeat(64)}`;
    const foreign = "foreign/object";
    const [legacyObject, v2Object] = await Promise.all([
      putObject(legacy, "legacy"),
      putObject(v2, "v2"),
      putObject(malformed),
      putObject(foreign),
    ]);
    await reference(legacy);
    const now = Math.max(futureNow(legacyObject), v2Object.uploaded.getTime() + 900_000);
    const dry = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans", dryRun: true, maxObjects: 24 }),
    );
    expect(dry).toMatchObject({ scanned: 4, eligible: 0, deleted: 0 });

    const run = await createGcEngine(env, { now: () => now + 1 }).run(
      input({ kind: "r2-orphans", maxObjects: 24 }),
    );
    expect(run).toMatchObject({ scanned: 4, eligible: 1, deleted: 1, cursor: null, error: null });
    await expect(env.BLOBS.head(v2)).resolves.toBeNull();
    await expect(env.BLOBS.head(legacy)).resolves.not.toBeNull();
    await expect(env.BLOBS.head(malformed)).resolves.not.toBeNull();
    await expect(env.BLOBS.head(foreign)).resolves.not.toBeNull();
  });

  it("rechecks freshness after references and never deletes a replacement", async () => {
    const key = blobKey(STASH, HASH_A, GENERATION);
    const listed = await putObject(key, "old");
    let replaced = false;
    const run = await createGcEngine(env, {
      now: () => futureNow(listed),
      hooks: {
        beforeHead: async () => {
          await env.BLOBS.put(key, "replacement");
          replaced = true;
        },
      },
    }).run(input({ kind: "r2-orphans" }));
    expect(replaced).toBe(true);
    expect(run).toMatchObject({ eligible: 0, deleted: 0 });
    await expect(env.BLOBS.get(key).then((object) => object?.text())).resolves.toBe("replacement");
  });

  it("deletes only the listed generation when a new immutable generation arrives before delete", async () => {
    const listedKey = blobKey(STASH, HASH_A, GENERATION);
    const newKey = blobKey(STASH, HASH_A, "33333333-3333-4333-8333-333333333333");
    const listed = await putObject(listedKey, "listed");
    const run = await createGcEngine(env, {
      now: () => futureNow(listed),
      hooks: {
        beforeDelete: async () => {
          await env.BLOBS.put(newKey, "new-generation");
        },
      },
    }).run(input({ kind: "r2-orphans" }));
    expect(run).toMatchObject({ eligible: 1, deleted: 1 });
    await expect(env.BLOBS.head(listedKey)).resolves.toBeNull();
    await expect(env.BLOBS.get(newKey).then((object) => object?.text())).resolves.toBe(
      "new-generation",
    );
  });

  it("uses the actual continuation cursor across two pages without skips", async () => {
    const objects: R2Object[] = [];
    for (let index = 0; index < 25; index += 1) {
      objects.push(
        await putObject(
          blobKey(STASH, HASH_A, `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`),
          String(index),
        ),
      );
    }
    const now = Math.max(...objects.map((object) => futureNow(object)));
    const first = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans", dryRun: true, maxObjects: 500 }),
    );
    expect(first).toMatchObject({ scanned: 24, eligible: 24, deleted: 0 });
    expect(first.cursor).not.toBeNull();
    const second = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans", dryRun: true, maxObjects: 500, cursor: first.cursor! }),
    );
    expect(second).toMatchObject({ scanned: 1, eligible: 1, deleted: 0, cursor: null });
  });

  it("does not replace persisted progress when an explicit-cursor page fails", async () => {
    const objects: R2Object[] = [];
    for (let index = 0; index < 25; index += 1) {
      objects.push(
        await putObject(
          blobKey(STASH, HASH_A, `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`),
        ),
      );
    }
    const now = Math.max(...objects.map((object) => futureNow(object)));
    const page = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "r2-orphans", dryRun: true, maxObjects: 24 }),
    );
    expect(page.cursor).not.toBeNull();
    const persisted = encodeR2Cursor("persisted-progress");
    await env.DB.prepare("UPDATE gc_jobs SET next_cursor = ? WHERE kind = 'r2-orphans'")
      .bind(persisted)
      .run();

    const failed = await createGcEngine(env, {
      now: () => now,
      hooks: { afterList: () => Promise.reject(new Error("injected failure")) },
    }).run(input({ kind: "r2-orphans", cursor: page.cursor! }));
    expect(failed.error).toBe("Garbage collection page failed");
    const job = await env.DB.prepare(
      "SELECT next_cursor FROM gc_jobs WHERE kind = 'r2-orphans'",
    ).first<{ next_cursor: string | null }>();
    expect(job?.next_cursor).toBe(persisted);
  });

  it("uses one safe array delete and stays within 45 charged operations", async () => {
    const objects: R2Object[] = [];
    for (let index = 0; index < 24; index += 1) {
      objects.push(
        await putObject(
          blobKey(STASH, HASH_A, `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`),
        ),
      );
    }
    const calls = { list: 0, head: 0, delete: 0, arrays: [] as number[], d1: 0 };
    const countedEnv = withD1Count(withR2Counts(env, calls), calls);
    const budget = new StorageOperationBudget(45);
    const result = await createGcEngine(countedEnv, {
      now: () => Math.max(...objects.map((object) => futureNow(object))),
      budget,
    }).run(input({ kind: "r2-orphans", maxObjects: 500 }));
    expect(result.deleted).toBe(24);
    expect(calls).toEqual({ list: 1, head: 24, delete: 1, arrays: [24], d1: 5 });
    expect(calls.d1 + calls.list + calls.head + calls.delete).toBe(budget.used);
    expect(budget.used).toBeLessThanOrEqual(45);
  });
});

async function seedLedger(rows: readonly { key: string; createdAt: number }[]): Promise<void> {
  await env.DB.batch(
    rows.map(({ key, createdAt }) =>
      env.DB.prepare(
        `INSERT INTO idempotency
          (stash_name, key, request_hash, path, version, status_code, created_at)
         VALUES (?, ?, 'hash', 'path', 1, 201, ?)`,
      ).bind(STASH, key, createdAt),
    ),
  );
}

async function ledgerKeys(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT key FROM idempotency ORDER BY created_at, rowid").all<{
    key: string;
  }>();
  return rows.results.map(({ key }) => key);
}

describe("ledger collection", () => {
  it.each([
    { label: "default", count: 100, maxObjects: undefined, deleteStatements: 2 },
    { label: "maximum", count: 500, maxObjects: 500, deleteStatements: 6 },
  ])(
    "deletes a $label $count-row page with at most 100 parameters per statement",
    async ({ count, maxObjects, deleteStatements }) => {
      const now = TTL_MS + 1_000;
      await seedLedger(
        Array.from({ length: count }, (_, index) => ({
          key: `large-${index}`,
          createdAt: index,
        })),
      );
      const calls = { d1: 0, d1BatchSizes: [] as number[] };
      const budget = new StorageOperationBudget(45);
      const engine = createGcEngine(withD1Count(env, calls), { now: () => now, budget });
      const result = await engine.run(
        input({ kind: "ledger", ...(maxObjects === undefined ? {} : { maxObjects }) }),
      );

      expect(result).toMatchObject({
        scanned: count,
        eligible: count,
        deleted: count,
        cursor: null,
        error: null,
      });
      expect(await ledgerKeys()).toEqual([]);
      expect(calls.d1BatchSizes).toEqual([deleteStatements, 4]);
      expect(calls.d1).toBe(budget.used);
      expect(budget.used).toBe(6);
    },
  );

  it("keyset-pages TTL ties, preserves the exact cutoff, and includes arrivals after the boundary", async () => {
    const now = TTL_MS + 1_000;
    await seedLedger([
      { key: "a", createdAt: 10 },
      { key: "b", createdAt: 10 },
      { key: "cutoff", createdAt: 1_000 },
    ]);
    const first = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", maxObjects: 1 }),
    );
    expect(first).toMatchObject({ scanned: 1, eligible: 1, deleted: 1 });
    await seedLedger([{ key: "arrival", createdAt: 11 }]);
    const second = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", maxObjects: 2 }),
    );
    expect(second).toMatchObject({ scanned: 2, deleted: 2, cursor: null });
    expect(await ledgerKeys()).toEqual(["cutoff"]);
  });

  it("dry runs neither mutate nor persist progress, then completion restarts a later pass", async () => {
    const now = TTL_MS + 100;
    await seedLedger([
      { key: "a", createdAt: 1 },
      { key: "b", createdAt: 2 },
    ]);
    const dry = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", dryRun: true, maxObjects: 1 }),
    );
    expect(dry).toMatchObject({ scanned: 1, eligible: 1, deleted: 0 });
    expect(await ledgerKeys()).toEqual(["a", "b"]);
    const jobAfterDry = await env.DB.prepare(
      "SELECT next_cursor FROM gc_jobs WHERE kind = 'ledger'",
    ).first<{ next_cursor: string | null }>();
    expect(jobAfterDry?.next_cursor).toBeNull();

    const completed = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", maxObjects: 2 }),
    );
    expect(completed.cursor).toBeNull();
    await seedLedger([{ key: "new-pass", createdAt: 3 }]);
    const restarted = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", maxObjects: 1 }),
    );
    expect(restarted).toMatchObject({ scanned: 1, deleted: 1 });
    expect(await ledgerKeys()).toEqual([]);
  });

  it("honors an explicit cursor over persisted job progress", async () => {
    const now = TTL_MS + 100;
    await seedLedger([
      { key: "a", createdAt: 1 },
      { key: "b", createdAt: 2 },
      { key: "c", createdAt: 3 },
    ]);
    const rows = await env.DB.prepare(
      "SELECT rowid, created_at FROM idempotency ORDER BY rowid",
    ).all<{
      rowid: number;
      created_at: number;
    }>();
    const stored = encodeLedgerCursor(rows.results[1]!.created_at, rows.results[1]!.rowid);
    await env.DB.prepare("UPDATE gc_jobs SET next_cursor = ? WHERE kind = 'ledger'")
      .bind(stored)
      .run();
    const explicit = encodeLedgerCursor(rows.results[0]!.created_at, rows.results[0]!.rowid);
    const result = await createGcEngine(env, { now: () => now }).run(
      input({ kind: "ledger", cursor: explicit, maxObjects: 1 }),
    );
    expect(result.deleted).toBe(1);
    expect(await ledgerKeys()).toEqual(["a", "c"]);
  });

  it("counts the worst-case scheduled R2 and chunked-ledger sequence against one budget", async () => {
    const now = TTL_MS + 100;
    await seedLedger(
      Array.from({ length: 500 }, (_, index) => ({ key: `k-${index}`, createdAt: index })),
    );
    const objects: R2Object[] = [];
    for (let index = 0; index < 24; index += 1) {
      objects.push(
        await putObject(
          blobKey(STASH, HASH_A, `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`),
        ),
      );
    }
    const calls = {
      d1: 0,
      d1BatchSizes: [] as number[],
      list: 0,
      head: 0,
      delete: 0,
      arrays: [] as number[],
    };
    const countedEnv = withD1Count(withR2Counts(env, calls), calls);
    const budget = new StorageOperationBudget(45);
    const engine = createGcEngine(countedEnv, {
      now: () => Math.max(now, ...objects.map((object) => futureNow(object))),
      budget,
    });
    const orphanRun = await engine.run(input({ kind: "r2-orphans", maxObjects: 80 }));
    const ledgerRun = await engine.run(input({ kind: "ledger", maxObjects: 500 }));

    expect(orphanRun).toMatchObject({ scanned: 24, eligible: 24, deleted: 24 });
    expect(ledgerRun).toMatchObject({ scanned: 500, eligible: 500, deleted: 500 });
    expect(calls).toEqual({
      d1: 11,
      d1BatchSizes: [4, 6, 4],
      list: 1,
      head: 24,
      delete: 1,
      arrays: [24],
    });
    const actualCalls = calls.d1 + calls.list + calls.head + calls.delete;
    expect(actualCalls).toBe(budget.used);
    expect(budget.used).toBeLessThanOrEqual(45);
  });
});
