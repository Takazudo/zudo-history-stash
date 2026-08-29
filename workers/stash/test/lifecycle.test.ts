import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth.js";
import { createAdminStore } from "../src/d1/admin-store.js";
import type { Env } from "../src/env.js";
import { resetDatabase } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";
import { seedCommit } from "./helpers/seed-rows.js";

const STASH = "lifecycle-store";
const DELETED_AT = 1_900_000_000_000;
const DAY_MS = 86_400_000;

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

async function seedHistoryAndTokens(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, 'kept', '{\"owner\":\"test\"}', ?)",
  )
    .bind(STASH, DELETED_AT - 1_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
     VALUES (?, 'hash-one', 'body', NULL, 4, ?)`,
  )
    .bind(STASH, DELETED_AT - 900)
    .run();
  const commitId = await seedCommit(STASH, "cmt_lifecycle_1", DELETED_AT - 800);
  await env.DB.prepare(
    `INSERT INTO versions
       (stash_name, path, version, kind, blob_hash, size_bytes, author, message, created_at, commit_id)
     VALUES (?, 'file.txt', 1, 'put', 'hash-one', 4, 'author', 'message', ?, ?)`,
  )
    .bind(STASH, DELETED_AT - 800, commitId)
    .run();
  await env.DB.prepare(
    `INSERT INTO files
       (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
     VALUES (?, 'file.txt', 1, 'hash-one', 0, ?, ?)`,
  )
    .bind(STASH, DELETED_AT - 800, DELETED_AT - 800)
    .run();
  for (const [id, secret, revokedAt] of [
    [`tok_${"a".repeat(32)}`, `zhs_${"A".repeat(43)}`, null],
    [`tok_${"b".repeat(32)}`, `zhs_${"B".repeat(43)}`, null],
    [`tok_${"c".repeat(32)}`, `zhs_${"C".repeat(43)}`, DELETED_AT - 500],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO tokens
         (id, stash_name, token_hash, label, scope, created_at, revoked_at)
       VALUES (?, ?, ?, '', 'write', ?, ?)`,
    )
      .bind(id, STASH, await sha256Hex(secret), DELETED_AT - 700, revokedAt)
      .run();
  }
}

async function immutableRows(): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of ["blobs", "versions", "files"] as const) {
    rows[table] = (
      await env.DB.prepare(`SELECT * FROM ${table} WHERE stash_name = ?`).bind(STASH).all()
    ).results;
  }
  return rows;
}

beforeEach(resetDatabase);

describe("stash lifecycle store", () => {
  it("deletes in one conditional batch, revokes exactly live tokens, and preserves history", async () => {
    await seedHistoryAndTokens();
    const before = await immutableRows();
    const now = vi.fn(() => DELETED_AT);
    const base = createTestEnv({ env: { STASH_DELETE_GRACE_DAYS: "2" } }).env;
    const observations = { batchSizes: [] as number[], queries: [] as string[] };
    const store = createAdminStore(
      { ...base, DB: instrumentDatabase(base.DB, observations) },
      { now },
    );

    await expect(store.deleteStash(STASH)).resolves.toEqual({
      name: STASH,
      deletedAt: new Date(DELETED_AT).toISOString(),
      revokedTokens: 2,
      restoreUntil: new Date(DELETED_AT + 2 * DAY_MS).toISOString(),
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect(observations.batchSizes).toEqual([2]);
    expect(observations.queries[0]).toContain("UPDATE tokens SET revoked_at = ?");
    expect(observations.queries[0]).toContain("revoked_at IS NULL");
    expect(observations.queries[0]).toContain("deleted_at IS NULL");
    expect(observations.queries[1]).toContain(
      "UPDATE stashes SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL",
    );
    await expect(
      env.DB.prepare("SELECT deleted_at FROM stashes WHERE name = ?").bind(STASH).first(),
    ).resolves.toEqual({ deleted_at: DELETED_AT });
    await expect(
      env.DB.prepare("SELECT revoked_at FROM tokens WHERE stash_name = ? ORDER BY id")
        .bind(STASH)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { revoked_at: DELETED_AT },
        { revoked_at: DELETED_AT },
        { revoked_at: DELETED_AT - 500 },
      ],
    });
    expect(await immutableRows()).toEqual(before);

    await expect(store.deleteStash(STASH)).rejects.toMatchObject({ code: "already-deleted" });
    expect(observations.batchSizes).toEqual([2, 2]);
    expect(await immutableRows()).toEqual(before);
  });

  it("restores only inside the grace boundary and never revives old tokens", async () => {
    await seedHistoryAndTokens();
    const base = createTestEnv({ env: { STASH_DELETE_GRACE_DAYS: "2" } }).env;
    const observations = { batchSizes: [] as number[], queries: [] as string[] };
    const bindings = { ...base, DB: instrumentDatabase(base.DB, observations) };
    await createAdminStore(bindings, { now: () => DELETED_AT }).deleteStash(STASH);
    const before = await immutableRows();

    const restored = await createAdminStore(bindings, {
      now: () => DELETED_AT + 2 * DAY_MS - 1,
    }).restoreStash(STASH);
    expect(restored).toMatchObject({
      name: STASH,
      description: "kept",
      meta: { owner: "test" },
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    });
    expect(observations.batchSizes).toEqual([2, 1]);
    const restoreUpdate = observations.queries.find((query) =>
      query.includes("UPDATE stashes SET deleted_at = NULL"),
    );
    expect(restoreUpdate).toContain("deleted_at IS NOT NULL AND deleted_at > ?");
    expect(await immutableRows()).toEqual(before);
    const revoked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM tokens WHERE stash_name = ? AND revoked_at IS NOT NULL",
    )
      .bind(STASH)
      .first<{ count: number }>();
    expect(revoked?.count).toBe(3);

    await expect(
      createAdminStore(bindings, { now: () => DELETED_AT + 2 * DAY_MS }).restoreStash(STASH),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("conceals unknown, live, and at-or-past-expiry restore targets as the same 404", async () => {
    await seedHistoryAndTokens();
    const bindings = createTestEnv({ env: { STASH_DELETE_GRACE_DAYS: "2" } }).env;
    const live = createAdminStore(bindings, { now: () => DELETED_AT });
    await expect(live.restoreStash("missing-stash")).rejects.toMatchObject({ code: "not-found" });
    await expect(live.restoreStash(STASH)).rejects.toMatchObject({ code: "not-found" });

    await live.deleteStash(STASH);
    const atExpiry = createAdminStore(bindings, { now: () => DELETED_AT + 2 * DAY_MS });
    await expect(atExpiry.restoreStash(STASH)).rejects.toMatchObject({ code: "not-found" });
    const pastExpiry = createAdminStore(bindings, { now: () => DELETED_AT + 2 * DAY_MS + 1 });
    await expect(pastExpiry.restoreStash(STASH)).rejects.toMatchObject({ code: "not-found" });
  });

  it("keeps a deleted stash name reserved", async () => {
    await seedHistoryAndTokens();
    const store = createAdminStore(env as Env, { now: () => DELETED_AT });
    await store.deleteStash(STASH);
    await expect(store.createStash({ name: STASH })).rejects.toMatchObject({ code: "exists" });
  });

  it("validates the grace configuration before mutating lifecycle state", async () => {
    await seedHistoryAndTokens();
    const bindings = createTestEnv({ env: { STASH_DELETE_GRACE_DAYS: "invalid" } }).env;
    const store = createAdminStore(bindings, { now: () => DELETED_AT });

    await expect(store.deleteStash(STASH)).rejects.toMatchObject({ code: "internal" });
    await expect(
      env.DB.prepare("SELECT deleted_at FROM stashes WHERE name = ?").bind(STASH).first(),
    ).resolves.toEqual({ deleted_at: null });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tokens WHERE stash_name = ? AND revoked_at IS NULL",
      )
        .bind(STASH)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });
});
