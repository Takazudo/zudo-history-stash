import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationSource from "../migrations/0001_init.sql?raw";
import { TABLE_COLUMNS, TABLE_NAMES } from "../src/d1/schema.js";

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
  });

  it("is intentionally not idempotent when 0001 is executed twice", async () => {
    for (const query of env.TEST_MIGRATIONS[0]?.queries ?? []) {
      await expect(env.DB.exec(query)).rejects.toThrow();
      break;
    }
  });

  it("uses block comments and unique migration numbers", () => {
    expect(migrationSource).not.toMatch(/--/);
    const numbers = env.TEST_MIGRATIONS.map(({ name }) => name.match(/^\d+/)?.[0]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("keeps append-only versions out of update and delete statements", () => {
    const guardedSource = [migrationSource, ...Object.values(sourceModules)].join("\n");
    expect(guardedSource).not.toMatch(/\bUPDATE\s+versions\b/i);
    expect(guardedSource).not.toMatch(/\bDELETE\s+FROM\s+versions\b/i);
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
