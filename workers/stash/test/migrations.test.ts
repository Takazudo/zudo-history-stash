import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken, sha256Hex } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { TABLE_COLUMNS, TABLE_NAMES } from "../src/d1/schema.js";
import { bearer, request } from "./helpers/app.js";
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

describe("D1 migrations", () => {
  it("keeps the runtime schema mirror in parity with SQLite", async () => {
    for (const table of TABLE_NAMES) {
      const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(result.results.map((column) => column.name)).toEqual([...TABLE_COLUMNS[table]]);
    }
    const indexes = await env.DB.prepare("PRAGMA index_list(tokens)").all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("tokens_expires");
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
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("keeps append-only versions out of update and delete statements", () => {
    const guardedSource = [
      ...Object.values(migrationSources),
      ...Object.values(sourceModules),
    ].join("\n");
    expect(guardedSource).not.toMatch(/\bUPDATE\s+versions\b/i);
    expect(guardedSource).not.toMatch(/\bDELETE\s+FROM\s+versions\b/i);
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
