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
  ["DELETE FROM byte_blobs", /\bDELETE\s+FROM\s+byte_blobs\b/i],
] as const;

const CONTENT_SWEEP_MODULE = "../src/d1/sql/gc.ts";
const CONTENT_SWEEP_EXEMPT = new Set(["DELETE FROM blobs", "DELETE FROM byte_blobs"]);

function assertAppendOnlyHygiene(sources: readonly (readonly [string, string])[]): void {
  const violations = appendOnlyMutationPatterns
    .filter(([name, pattern]) =>
      sources.some(
        ([path, source]) =>
          pattern.test(source) &&
          !(path.endsWith(CONTENT_SWEEP_MODULE) && CONTENT_SWEEP_EXEMPT.has(name)),
      ),
    )
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

    const commitIndexes = await env.DB.prepare("PRAGMA index_list(commits)").all<{
      name: string;
      partial: number;
    }>();
    expect(commitIndexes.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "commits_stash_created", partial: 0 }),
        expect.objectContaining({ name: "commits_stash_idempotency", partial: 1 }),
        expect.objectContaining({ name: "commits_stash_last_change", partial: 0 }),
      ]),
    );
    const versionIndexes = await env.DB.prepare("PRAGMA index_list(versions)").all<{
      name: string;
    }>();
    expect(versionIndexes.results.map(({ name }) => name)).toContain("versions_stash_commit");
    expect(versionIndexes.results.map(({ name }) => name)).toContain("versions_stash_blob");
    const versionColumns = await env.DB.prepare("PRAGMA table_info(versions)").all<{
      name: string;
      notnull: number;
    }>();
    expect(versionColumns.results.find(({ name }) => name === "commit_id")?.notnull).toBe(1);

    const changeSetIndexes = await env.DB.prepare("PRAGMA index_list(change_sets)").all<{
      name: string;
      partial: number;
    }>();
    expect(changeSetIndexes.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "change_sets_stash_status_created", partial: 0 }),
        expect.objectContaining({ name: "change_sets_stash_idempotency", partial: 1 }),
      ]),
    );
    const entryIndexes = await env.DB.prepare("PRAGMA index_list(change_set_entries)").all<{
      name: string;
    }>();
    expect(entryIndexes.results.map(({ name }) => name)).toContain("change_set_entries_stash_path");
    expect(entryIndexes.results.map(({ name }) => name)).toContain("change_set_entries_stash_blob");

    await expect(env.DB.prepare("SELECT 1 FROM proposals").first()).rejects.toThrow();

    const jobs = await env.DB.prepare(
      "SELECT kind, next_cursor, lease_owner, lease_generation, lease_until, updated_at FROM gc_jobs ORDER BY kind",
    ).all();
    expect(jobs.results).toEqual([
      {
        kind: "content",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
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

  it("defers the change-set commit reference through a batch and rolls back unresolved claims", async () => {
    await resetDatabase();
    await env.DB.prepare(
      "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, '', '{}', 1)",
    )
      .bind("deferred-change-set")
      .run();
    for (const id of ["chs_0000000000001aaaaaaaa", "chs_0000000000002bbbbbbbb"]) {
      await env.DB.prepare(
        `INSERT INTO change_sets
          (id, stash_name, status, author, message, meta_json, expires_at, created_by, created_at)
         VALUES (?, 'deferred-change-set', 'open', '', '', '{}', 100, 'test', 1)`,
      )
        .bind(id)
        .run();
    }
    const commitId = "cmt_0000000000001aaaaaaaa";
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "UPDATE change_sets SET status = 'applied', commit_id = ? WHERE id = ?",
        ).bind(commitId, "chs_0000000000001aaaaaaaa"),
        env.DB.prepare(
          `INSERT INTO commits
            (id, stash_name, source, source_id, entry_count, created_by, created_at)
           VALUES (?, 'deferred-change-set', 'change-set', ?, 1, 'test', 1)`,
        ).bind(commitId, "chs_0000000000001aaaaaaaa"),
      ]),
    ).resolves.toHaveLength(2);
    await expect(
      env.DB.prepare("SELECT status, commit_id FROM change_sets WHERE id = ?")
        .bind("chs_0000000000001aaaaaaaa")
        .first(),
    ).resolves.toEqual({ status: "applied", commit_id: commitId });

    await expect(
      env.DB.batch([
        env.DB.prepare(
          "UPDATE change_sets SET status = 'applied', commit_id = ? WHERE id = ?",
        ).bind("cmt_missing", "chs_0000000000002bbbbbbbb"),
      ]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      env.DB.prepare("SELECT status, commit_id FROM change_sets WHERE id = ?")
        .bind("chs_0000000000002bbbbbbbb")
        .first(),
    ).resolves.toEqual({ status: "open", commit_id: null });
  });

  it("uses block comments and unique migration numbers", () => {
    for (const source of Object.values(migrationSources)) expect(source).not.toMatch(/--/);
    const numbers = env.TEST_MIGRATIONS.map(({ name }) => name.match(/^\d+/)?.[0]);
    expect(numbers.every((number): number is string => number !== undefined)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("keeps append-only versions out of update and delete statements", () => {
    assertAppendOnlyHygiene([
      ...Object.entries(migrationSources),
      ...Object.entries(sourceModules),
    ]);
  });

  it("rejects forbidden append-only mutations while allowing cleanup tables", () => {
    expect(() =>
      assertAppendOnlyHygiene([["../src/x.ts", "UPDATE versions SET message = 'rewritten'"]]),
    ).toThrow("UPDATE versions");
    expect(() => assertAppendOnlyHygiene([["../src/x.ts", "DELETE FROM versions"]])).toThrow(
      "DELETE FROM versions",
    );
    expect(() => assertAppendOnlyHygiene([["../src/x.ts", "DELETE FROM files"]])).toThrow(
      "DELETE FROM files",
    );
    expect(() => assertAppendOnlyHygiene([["../src/x.ts", "DELETE FROM blobs"]])).toThrow(
      "DELETE FROM blobs",
    );
    expect(() => assertAppendOnlyHygiene([["../src/x.ts", "DELETE FROM byte_blobs"]])).toThrow(
      "DELETE FROM byte_blobs",
    );
    expect(() =>
      assertAppendOnlyHygiene([[CONTENT_SWEEP_MODULE, "DELETE FROM blobs"]]),
    ).not.toThrow();
    expect(() =>
      assertAppendOnlyHygiene([[CONTENT_SWEEP_MODULE, "DELETE FROM byte_blobs"]]),
    ).not.toThrow();
    expect(() => assertAppendOnlyHygiene([[CONTENT_SWEEP_MODULE, "DELETE FROM versions"]])).toThrow(
      "DELETE FROM versions",
    );
    expect(() => assertAppendOnlyHygiene([[CONTENT_SWEEP_MODULE, "DELETE FROM files"]])).toThrow(
      "DELETE FROM files",
    );
    expect(() =>
      assertAppendOnlyHygiene([
        [CONTENT_SWEEP_MODULE, "UPDATE versions SET message = 'rewritten'"],
      ]),
    ).toThrow("UPDATE versions");
    expect(() =>
      assertAppendOnlyHygiene([
        ["../src/x.ts", "DELETE FROM idempotency"],
        ["../src/x.ts", "DELETE FROM gc_runs"],
      ]),
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
    const legacyHash = `sha256-${"a".repeat(64)}`;
    await env.UPGRADE_DB.prepare(
      "INSERT INTO blobs (stash_name, hash, body, size_bytes, created_at) VALUES ('upgrade', ?, 'legacy text', 11, 1)",
    )
      .bind(legacyHash)
      .run();
    await env.UPGRADE_DB.prepare(
      "INSERT INTO files (stash_name, path, head_version, head_hash, created_at, updated_at) VALUES ('upgrade', 'legacy.txt', 1, ?, 1, 1)",
    )
      .bind(legacyHash)
      .run();
    await env.UPGRADE_DB.prepare(
      "INSERT INTO versions (stash_name, path, version, kind, blob_hash, size_bytes, created_at) VALUES ('upgrade', 'legacy.txt', 1, 'put', ?, 11, 1)",
    )
      .bind(legacyHash)
      .run();
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
    const legacyCommit = await env.UPGRADE_DB.prepare(
      `SELECT id, stash_name, source, entry_count, change_count, sealed,
         first_change_id, last_change_id, created_by
       FROM commits WHERE id = 'cmt_legacy_1'`,
    ).first();
    expect(legacyCommit).toEqual({
      id: "cmt_legacy_1",
      stash_name: "upgrade",
      source: "put",
      entry_count: 1,
      change_count: 1,
      sealed: 1,
      first_change_id: 1,
      last_change_id: 1,
      created_by: "legacy",
    });
    await expect(
      env.UPGRADE_DB.prepare("SELECT commit_id FROM versions WHERE id = 1").first(),
    ).resolves.toEqual({ commit_id: "cmt_legacy_1" });
    await expect(
      env.UPGRADE_DB.prepare(
        `SELECT b.body, b.size_bytes, v.representation, v.application_etag, v.content_storage, f.head_hash
         FROM blobs b
         JOIN versions v ON v.stash_name = b.stash_name AND v.blob_hash = b.hash
         JOIN files f ON f.stash_name = v.stash_name AND f.path = v.path
         WHERE b.stash_name = 'upgrade' AND b.hash = ?`,
      )
        .bind(legacyHash)
        .first(),
    ).resolves.toEqual({
      body: "legacy text",
      size_bytes: 11,
      representation: "text",
      application_etag: null,
      content_storage: "legacy",
      head_hash: legacyHash,
    });

    /* The same application hash may exist in both tables; the version discriminator is decisive. */
    const byteHash = legacyHash;
    const bytes = new Uint8Array([0, 255, 1, 2]);
    await env.UPGRADE_DB.prepare(
      "INSERT INTO byte_blobs (stash_name, hash, body_bytes, size_bytes, created_at) VALUES ('upgrade', ?, ?, 4, 2)",
    )
      .bind(byteHash, bytes)
      .run();
    const byteRow = await env.UPGRADE_DB.prepare(
      "SELECT body_bytes, size_bytes FROM byte_blobs WHERE stash_name = 'upgrade' AND hash = ?",
    )
      .bind(byteHash)
      .first<{ body_bytes: ArrayBuffer; size_bytes: number }>();
    expect(byteRow?.size_bytes).toBe(4);
    expect(Array.from(new Uint8Array(byteRow?.body_bytes ?? new ArrayBuffer(0)))).toEqual([
      0, 255, 1, 2,
    ]);
    await env.UPGRADE_DB.prepare(
      `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
       VALUES ('cmt_upgrade_bytes', 'upgrade', 'put', 1, 'test', 2)`,
    ).run();
    await env.UPGRADE_DB.prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, size_bytes, representation,
          application_etag, content_storage, created_at, commit_id)
       VALUES ('upgrade', 'raw.bin', 1, 'put', ?, 4, 'binary', ?, 'bytes', 2, 'cmt_upgrade_bytes')`,
    )
      .bind(byteHash, byteHash)
      .run();
    const resolutionRows = await env.UPGRADE_DB.prepare(
      `SELECT v.path, v.content_storage,
         CASE v.content_storage WHEN 'legacy' THEN lb.body ELSE hex(bb.body_bytes) END AS resolved
       FROM versions v
       LEFT JOIN blobs lb ON v.content_storage = 'legacy'
         AND lb.stash_name = v.stash_name AND lb.hash = v.blob_hash
       LEFT JOIN byte_blobs bb ON v.content_storage = 'bytes'
         AND bb.stash_name = v.stash_name AND bb.hash = v.blob_hash
       WHERE v.stash_name = 'upgrade' AND v.blob_hash = ? ORDER BY v.path`,
    )
      .bind(byteHash)
      .all();
    expect(resolutionRows.results).toEqual([
      { path: "legacy.txt", content_storage: "legacy", resolved: "legacy text" },
      { path: "raw.bin", content_storage: "bytes", resolved: "00FF0102" },
    ]);

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
    const legacyRead = await request(
      createApp({ now: () => 2 }),
      "http://stash.test/v1/stashes/upgrade/files/legacy.txt",
      { headers: bearer(token.token) },
      { ...createTestEnv().env, DB: env.UPGRADE_DB },
    );
    expect(legacyRead.status).toBe(200);
    await expect(legacyRead.json()).resolves.toMatchObject({
      path: "legacy.txt",
      version: 1,
      hash: legacyHash,
      body: "legacy text",
    });
  });

  it("resets GC runs while retaining all three seeded job rows", async () => {
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
        kind: "content",
        next_cursor: null,
        lease_owner: null,
        lease_generation: 0,
        lease_until: null,
        updated_at: 0,
      },
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
    await env.DB.prepare(
      `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
       VALUES ('cmt_constraint_a', 'alpha', 'delete', 1, 'test', 1),
              ('cmt_constraint_b', 'alpha', 'rollback', 1, 'test', 1)`,
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO versions (stash_name,path,version,kind,blob_hash,created_at,commit_id) VALUES ('alpha','a',1,'delete','sha256-x',1,'cmt_constraint_a')",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO versions (stash_name,path,version,kind,blob_hash,created_at,commit_id) VALUES ('alpha','b',1,'rollback','sha256-x',1,'cmt_constraint_b')",
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
