import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken, sha256Hex } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { TABLE_COLUMNS, TABLE_NAMES } from "../src/d1/schema.js";
import { bearer, request, resetDatabase } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

const migrationSources = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sourceModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const appendOnlyMutationPatterns = [
  ["UPDATE versions", /\bUPDATE\s+versions\b/i],
  ["DELETE FROM versions", /\bDELETE\s+FROM\s+versions\b/i],
  ["DELETE FROM files", /\bDELETE\s+FROM\s+files\b/i],
  ["DELETE FROM blobs", /\bDELETE\s+FROM\s+blobs\b/i],
] as const;

function assertAppendOnlyHygiene(sources: readonly string[]): void {
  const source = sources.join("\n");
  const violations = appendOnlyMutationPatterns
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name);
  if (violations.length > 0) {
    throw new Error(`Append-only mutation guard failed: ${violations.join(", ")}`);
  }
}

describe("D1 migrations", () => {
  it("keeps the runtime schema mirror in parity with SQLite", async () => {
    for (const table of TABLE_NAMES) {
      const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(result.results.map((column) => column.name)).toEqual([...TABLE_COLUMNS[table]]);
    }
    const indexes = await env.DB.prepare("PRAGMA index_list(tokens)").all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("tokens_expires");

    const blobIndexes = await env.DB.prepare("PRAGMA index_list(blobs)").all<{
      name: string;
      partial: number;
    }>();
    expect(blobIndexes.results).toContainEqual(
      expect.objectContaining({ name: "blobs_r2_key", partial: 1 }),
    );

    const runIndexes = await env.DB.prepare("PRAGMA index_list(gc_runs)").all<{ name: string }>();
    expect(runIndexes.results.map((index) => index.name)).toContain("gc_runs_job_started");
    const runIndexColumns = await env.DB.prepare("PRAGMA index_xinfo(gc_runs_job_started)").all<{
      name: string | null;
      desc: number;
      key: number;
    }>();
    expect(
      runIndexColumns.results
        .filter((column) => column.key === 1)
        .map(({ name, desc }) => ({ name, desc })),
    ).toEqual([
      { name: "job_kind", desc: 0 },
      { name: "started_at", desc: 1 },
      { name: "id", desc: 1 },
    ]);

    const proposalIndexes = await env.DB.prepare("PRAGMA index_list(proposals)").all<{
      name: string;
      partial: number;
      unique: number;
    }>();
    expect(proposalIndexes.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "proposals_stash_status_created", partial: 0, unique: 0 }),
        expect.objectContaining({ name: "proposals_stash_path", partial: 0, unique: 0 }),
        expect.objectContaining({ name: "proposals_stash_idempotency", partial: 1, unique: 1 }),
      ]),
    );
    const proposalOrder = await env.DB.prepare(
      "PRAGMA index_xinfo(proposals_stash_status_created)",
    ).all<{ name: string | null; desc: number; key: number }>();
    expect(
      proposalOrder.results
        .filter((column) => column.key === 1)
        .map(({ name, desc }) => ({ name, desc })),
    ).toEqual([
      { name: "stash_name", desc: 0 },
      { name: "status", desc: 0 },
      { name: "created_at", desc: 0 },
      { name: "id", desc: 0 },
    ]);

    const jobs = await env.DB.prepare(
      "SELECT kind, next_cursor, lease_owner, lease_generation, lease_until, updated_at FROM gc_jobs ORDER BY kind",
    ).all();
    expect(jobs.results).toEqual([
      {
        kind: "ledger",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
      {
        kind: "r2-orphans",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
    ]);
  });

  it("is intentionally not idempotent when 0001 is executed twice", async () => {
    for (const query of env.TEST_MIGRATIONS[0]?.queries ?? []) {
      await expect(env.DB.exec(query)).rejects.toThrow();
      break;
    }
  });

  it("uses block comments and unique migration numbers", () => {
    for (const source of Object.values(migrationSources)) expect(source).not.toMatch(/--/);
    const numbers = env.TEST_MIGRATIONS.map(({ name }) => name.match(/^\d+/)?.[0]);
    expect(numbers.every((number): number is string => number !== undefined)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("keeps append-only versions out of update and delete statements", () => {
    assertAppendOnlyHygiene([...Object.values(migrationSources), ...Object.values(sourceModules)]);
  });

  it("rejects forbidden append-only mutations while allowing cleanup tables", () => {
    expect(() => assertAppendOnlyHygiene(["UPDATE versions SET message = 'rewritten'"])).toThrow(
      "UPDATE versions",
    );
    expect(() => assertAppendOnlyHygiene(["DELETE FROM versions"])).toThrow("DELETE FROM versions");
    expect(() => assertAppendOnlyHygiene(["DELETE FROM files"])).toThrow("DELETE FROM files");
    expect(() => assertAppendOnlyHygiene(["DELETE FROM blobs"])).toThrow("DELETE FROM blobs");
    expect(() =>
      assertAppendOnlyHygiene(["DELETE FROM idempotency", "DELETE FROM gc_runs"]),
    ).not.toThrow();
  });

  it("upgrades a 0001 database without expiring an existing token", async () => {
    const [initialMigration, ...remainingMigrations] = env.TEST_MIGRATIONS;
    if (initialMigration === undefined || remainingMigrations.length === 0) {
      throw new Error("The upgrade smoke requires both the initial and an additive migration.");
    }
    expect(initialMigration.name).toMatch(/^0001_/);

    await applyD1Migrations(env.UPGRADE_DB, [initialMigration]);
    const token = mintToken();
    await env.UPGRADE_DB.prepare(
      "INSERT INTO stashes (name, description, meta_json, created_at) VALUES ('upgrade', '', '{}', 1)",
    ).run();
    await env.UPGRADE_DB.prepare(
      `INSERT INTO tokens (id, stash_name, token_hash, label, scope, created_at)
       VALUES (?, 'upgrade', ?, '', 'read', 1)`,
    )
      .bind(token.id, await sha256Hex(token.token))
      .run();

    await applyD1Migrations(env.UPGRADE_DB, remainingMigrations);

    const upgraded = await env.UPGRADE_DB.prepare(
      "SELECT expires_at, rotated_from, rotated_to FROM tokens WHERE id = ?",
    )
      .bind(token.id)
      .first<{
        expires_at: number | null;
        rotated_from: string | null;
        rotated_to: string | null;
      }>();
    expect(upgraded).toEqual({ expires_at: null, rotated_from: null, rotated_to: null });
    const upgradedStash = await env.UPGRADE_DB.prepare(
      "SELECT deleted_at FROM stashes WHERE name = 'upgrade'",
    ).first<{ deleted_at: number | null }>();
    expect(upgradedStash).toEqual({ deleted_at: null });

    const response = await request(
      createApp({ now: () => 2 }),
      "http://stash.test/v1/me",
      { headers: bearer(token.token) },
      { ...createTestEnv().env, DB: env.UPGRADE_DB },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      principal: "stash",
      stash: "upgrade",
      expiresAt: null,
    });
  });

  it("resets GC runs while retaining both seeded job rows", async () => {
    await env.DB.prepare(
      `UPDATE gc_jobs
         SET next_cursor = 'cursor', lease_owner = 'owner', lease_generation = 7,
             lease_until = 9, updated_at = 10`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO gc_runs (id, job_kind, lease_generation, input_cursor, next_cursor, started_at)
         VALUES (?, 'ledger', 7, 'input', 'next', 11)`,
    )
      .bind(crypto.randomUUID())
      .run();

    await resetDatabase();

    const jobs = await env.DB.prepare(
      "SELECT kind, next_cursor, lease_owner, lease_generation, lease_until, updated_at FROM gc_jobs ORDER BY kind",
    ).all();
    expect(jobs.results).toEqual([
      {
        kind: "ledger",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
      {
        kind: "r2-orphans",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
    ]);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM gc_runs").first()).resolves.toEqual({
      count: 0,
    });
  });

  it("enforces version and file-state CHECK constraints", async () => {
    await env.DB.prepare(
      "INSERT INTO stashes (name, description, meta_json, created_at) VALUES ('alpha', '', '{}', 1)",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO versions (stash_name,path,version,kind,blob_hash,created_at) VALUES ('alpha','a',1,'delete','sha256-x',1)",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO proposals
           (id, stash_name, path, blob_hash, size_bytes, status, expires_at, created_at)
         VALUES ('prp_000000000000100000001', 'alpha', 'p', 'sha256-x', 1, 'expired', 2, 1)`,
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO versions (stash_name,path,version,kind,blob_hash,created_at) VALUES ('alpha','b',1,'rollback','sha256-x',1)",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO files (stash_name,path,head_version,head_hash,deleted,created_at,updated_at) VALUES ('alpha','c',1,'sha256-x',1,1,1)",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("vitest-plugin D1 storage-isolation spike", () => {
  it("can insert the probe row in the first test", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO stashes (name, description, meta_json, created_at) VALUES ('isolation-probe', '', '{}', 1)",
      ).run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("observes the first test's probe row in the second test", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO stashes (name, description, meta_json, created_at) VALUES ('isolation-probe', '', '{}', 1)",
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
