import { StashError } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintToken, sha256Hex } from "../src/auth.js";
import { createAdminStore } from "../src/d1/admin-store.js";
import type { Env } from "../src/env.js";
import { resetDatabase, seedStash } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

const STASH = "token-rotation";
const NOW = 1_900_000_000_000;
const PREDECESSOR_ID = `tok_${"1".repeat(32)}`;
const PREDECESSOR_SECRET = `zhs_${"P".repeat(43)}`;
const SUCCESSOR_A = {
  id: `tok_${"a".repeat(32)}`,
  token: `zhs_${"A".repeat(43)}`,
};
const SUCCESSOR_B = {
  id: `tok_${"b".repeat(32)}`,
  token: `zhs_${"B".repeat(43)}`,
};

async function seedPredecessor({ expiresAt = null }: { expiresAt?: number | null } = {}) {
  await seedStash(STASH);
  await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO tokens
         (id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
          expires_at, rotated_from, rotated_to)
       VALUES (?, ?, ?, 'Writer', 'write', ?, NULL, NULL, ?, NULL, NULL)`,
    )
    .bind(PREDECESSOR_ID, STASH, await sha256Hex(PREDECESSOR_SECRET), NOW - 1_000, expiresAt)
    .run();
}

async function successors() {
  return createTestEnv()
    .env.DB.prepare(
      `SELECT id, token_hash, expires_at, rotated_from, rotated_to
       FROM tokens
       WHERE rotated_from = ?
       ORDER BY id`,
    )
    .bind(PREDECESSOR_ID)
    .all<{
      id: string;
      token_hash: string;
      expires_at: number | null;
      rotated_from: string | null;
      rotated_to: string | null;
    }>();
}

function instrumentDatabase(
  database: D1Database,
  observations: { batchSizes: number[]; queries: string[] },
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "withSession") {
        return (constraint?: string) => {
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty === "prepare") {
                return (query: string) => {
                  observations.queries.push(query);
                  return sessionTarget.prepare(query);
                };
              }
              if (sessionProperty === "batch") {
                return (statements: D1PreparedStatement[]) => {
                  observations.batchSizes.push(statements.length);
                  return sessionTarget.batch(statements);
                };
              }
              const value: unknown = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failBatchAfter(
  database: D1Database,
  action: () => Promise<void>,
  failure: unknown = new Error("injected batch response loss"),
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "withSession") {
        return (constraint?: string) => {
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty === "batch") {
                return async () => {
                  await action();
                  throw failure;
                };
              }
              const value: unknown = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(resetDatabase);

describe("mintToken", () => {
  it("mints opaque IDs and 256-bit base64url secrets", () => {
    const first = mintToken();
    const second = mintToken();
    expect(first.id).toMatch(/^tok_[0-9a-f]{32}$/);
    expect(first.token).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toEqual(first);
  });
});

describe("fenced token rotation", () => {
  it("uses one two-statement batch with the full insert and final-update fences", async () => {
    await seedPredecessor({ expiresAt: NOW + 86_400_000 });
    const observations = { batchSizes: [] as number[], queries: [] as string[] };
    const base = createTestEnv().env;
    const now = vi.fn(() => NOW);
    const store = createAdminStore(
      { ...base, DB: instrumentDatabase(base.DB, observations) },
      { now, mintToken: () => SUCCESSOR_A },
    );

    const rotated = await store.rotateToken(STASH, PREDECESSOR_ID, {
      graceSeconds: 60,
    });
    expect(rotated.id).toBe(SUCCESSOR_A.id);
    expect(now).toHaveBeenCalledTimes(1);
    expect(observations.batchSizes).toEqual([2]);
    const insert = observations.queries.find((query) => query.includes("INSERT INTO tokens"));
    const update = observations.queries.find((query) => query.includes("UPDATE tokens AS"));
    expect(insert).toContain("predecessor.revoked_at IS NULL");
    expect(insert).toContain("predecessor.rotated_to IS NULL");
    expect(insert).toContain("predecessor.expires_at > ?");
    expect(insert).not.toMatch(/OR\s+IGNORE|ON\s+CONFLICT/i);
    expect(update).toContain("predecessor.revoked_at IS NULL");
    expect(update).toContain("predecessor.rotated_to IS NULL");
    expect(update).toContain("predecessor.expires_at > ?");
    expect(update).toContain("successor.rotated_from = ?");
    expect(update).toContain("successor.stash_name = ?");
  });

  it("allows exactly one concurrent winner and leaves one successor row", async () => {
    await seedPredecessor();
    const workerEnv = createTestEnv().env;
    const now = vi.fn(() => NOW);
    let ready = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeCommit = vi.fn(async () => {
      ready += 1;
      if (ready === 2) release();
      await bothReady;
    });
    const first = createAdminStore(workerEnv, {
      now,
      mintToken: () => SUCCESSOR_A,
      onBeforeRotateCommit: beforeCommit,
    });
    const second = createAdminStore(workerEnv, {
      now,
      mintToken: () => SUCCESSOR_B,
      onBeforeRotateCommit: beforeCommit,
    });

    const settled = await Promise.allSettled([
      first.rotateToken(STASH, PREDECESSOR_ID, {}),
      second.rotateToken(STASH, PREDECESSOR_ID, {}),
    ]);
    const winners = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.rotateToken>>> =>
        result.status === "fulfilled",
    );
    const losers = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(now).toHaveBeenCalledTimes(2);
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(losers[0]?.reason).toBeInstanceOf(StashError);
    expect(losers[0]?.reason).toMatchObject({
      code: "already-rotated",
      successorId: winners[0]?.value.id,
    });

    const rows = await successors();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: winners[0]?.value.id,
      rotated_from: PREDECESSOR_ID,
      rotated_to: null,
    });
    const predecessor = await workerEnv.DB.prepare(
      "SELECT rotated_to FROM tokens WHERE id = ? AND stash_name = ?",
    )
      .bind(PREDECESSOR_ID, STASH)
      .first<{ rotated_to: string | null }>();
    expect(predecessor?.rotated_to).toBe(winners[0]?.value.id);
  });

  it("repeats expiry eligibility in the final update and inserts no expired successor", async () => {
    await seedPredecessor({ expiresAt: NOW + 1 });
    const workerEnv = createTestEnv().env;
    const now = vi.fn(() => NOW);
    const store = createAdminStore(workerEnv, {
      now,
      mintToken: () => SUCCESSOR_A,
      onBeforeRotateCommit: async () => {
        await workerEnv.DB.prepare(
          "UPDATE tokens SET expires_at = ? WHERE id = ? AND stash_name = ?",
        )
          .bind(NOW, PREDECESSOR_ID, STASH)
          .run();
      },
    });

    await expect(store.rotateToken(STASH, PREDECESSOR_ID, {})).rejects.toMatchObject({
      code: "token-expired",
      successorId: undefined,
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect((await successors()).results).toEqual([]);
    const predecessor = await workerEnv.DB.prepare(
      "SELECT expires_at, rotated_to FROM tokens WHERE id = ? AND stash_name = ?",
    )
      .bind(PREDECESSOR_ID, STASH)
      .first<{ expires_at: number; rotated_to: string | null }>();
    expect(predecessor).toEqual({ expires_at: NOW, rotated_to: null });
  });

  it("inherits the predecessor's original expiry before applying its grace cap", async () => {
    const originalExpiry = NOW + 60_000;
    await seedPredecessor({ expiresAt: originalExpiry });
    const workerEnv = createTestEnv().env;
    const store = createAdminStore(workerEnv, {
      now: () => NOW,
      mintToken: () => SUCCESSOR_A,
    });

    const rotated = await store.rotateToken(STASH, PREDECESSOR_ID, {
      graceSeconds: 300,
    });

    expect(rotated.expiresAt).toBe(new Date(originalExpiry).toISOString());
    expect(rotated.predecessor.expiresAt).toBe(new Date(originalExpiry).toISOString());
    const rows = await successors();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.expires_at).toBe(originalExpiry);
  });

  it("applies a TTL override to the successor without extending the predecessor", async () => {
    await seedPredecessor();
    const workerEnv = createTestEnv().env;
    const store = createAdminStore(workerEnv, {
      now: () => NOW,
      mintToken: () => SUCCESSOR_A,
    });

    const rotated = await store.rotateToken(STASH, PREDECESSOR_ID, {
      graceSeconds: 60,
      ttlSeconds: 3_600,
    });

    expect(rotated.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
    expect(rotated.predecessor.expiresAt).toBe(new Date(NOW + 60_000).toISOString());
    expect((await successors()).results[0]?.expires_at).toBe(NOW + 3_600_000);
  });

  it("re-reads after a failed batch response and identifies the committed winner", async () => {
    await seedPredecessor();
    const workerEnv = createTestEnv().env;
    const winner = createAdminStore(workerEnv, {
      now: () => NOW,
      mintToken: () => SUCCESSOR_A,
    });
    const failingEnv: Env = {
      ...workerEnv,
      DB: failBatchAfter(workerEnv.DB, async () => {
        await winner.rotateToken(STASH, PREDECESSOR_ID, {});
      }),
    };
    const loserNow = vi.fn(() => NOW);
    const loser = createAdminStore(failingEnv, {
      now: loserNow,
      mintToken: () => SUCCESSOR_B,
    });

    await expect(loser.rotateToken(STASH, PREDECESSOR_ID, {})).rejects.toMatchObject({
      code: "already-rotated",
      successorId: SUCCESSOR_A.id,
    });
    expect(loserNow).toHaveBeenCalledTimes(1);
    const rows = await successors();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: SUCCESSOR_A.id,
      token_hash: await sha256Hex(SUCCESSOR_A.token),
    });
    expect(JSON.stringify(rows.results)).not.toContain(SUCCESSOR_A.token);
    expect(rows.results.some(({ id }) => id === SUCCESSOR_B.id)).toBe(false);
  });

  it("does not swallow an unrelated batch failure while the predecessor remains eligible", async () => {
    await seedPredecessor();
    const workerEnv = createTestEnv().env;
    const failure = new Error("injected D1 outage");
    const failingEnv: Env = {
      ...workerEnv,
      DB: failBatchAfter(workerEnv.DB, async () => {}, failure),
    };
    const store = createAdminStore(failingEnv, {
      now: () => NOW,
      mintToken: () => SUCCESSOR_A,
    });

    await expect(store.rotateToken(STASH, PREDECESSOR_ID, {})).rejects.toBe(failure);
    expect((await successors()).results).toEqual([]);
  });
});
