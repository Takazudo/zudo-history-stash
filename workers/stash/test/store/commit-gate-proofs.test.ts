import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const LIVE_STASH = "commit-proof-live";
const DELETED_STASH = "commit-proof-deleted";

const commitGateSql = `
  INSERT INTO commit_gate_proof_commits
    (stash_name, entry_count, change_count, sealed, client_key)
  SELECT ?, ?, 0, 0, ?
  WHERE EXISTS (
    SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(?) AS entry
    WHERE NOT CASE
      WHEN json_extract(entry.value, '$.expectedVersion') IS NULL THEN
        NOT EXISTS (
          SELECT 1 FROM files
          WHERE stash_name = ?
            AND path = json_extract(entry.value, '$.path')
        )
      WHEN json_extract(entry.value, '$.operation') = 'put' THEN
        EXISTS (
          SELECT 1 FROM files
          WHERE stash_name = ?
            AND path = json_extract(entry.value, '$.path')
            AND head_version = json_extract(entry.value, '$.expectedVersion')
        )
      WHEN json_extract(entry.value, '$.operation') = 'delete' THEN
        EXISTS (
          SELECT 1 FROM files
          WHERE stash_name = ?
            AND path = json_extract(entry.value, '$.path')
            AND head_version = json_extract(entry.value, '$.expectedVersion')
            AND deleted = 0
        )
      WHEN json_extract(entry.value, '$.operation') = 'rollback' THEN
        EXISTS (
          SELECT 1 FROM files
          WHERE stash_name = ?
            AND path = json_extract(entry.value, '$.path')
            AND head_version = json_extract(entry.value, '$.expectedVersion')
        )
        AND EXISTS (
          SELECT 1 FROM versions
          WHERE stash_name = ?
            AND path = json_extract(entry.value, '$.path')
            AND version = json_extract(entry.value, '$.rollbackVersion')
            AND kind != 'delete'
        )
      ELSE 0
    END
  )`;

type GateEntry = {
  path: string;
  operation: "put" | "delete" | "rollback";
  expectedVersion?: number | string | null;
  rollbackVersion?: number;
};

async function insertStash(name: string, deletedAt: number | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stashes (name, description, meta_json, created_at, deleted_at)
       VALUES (?, '', '{}', 1, ?)`,
    )
    .bind(name, deletedAt)
    .run();
}

async function insertHead(
  path: string,
  headVersion: number,
  { deleted = false }: { deleted?: boolean } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO files
         (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
    )
    .bind(LIVE_STASH, path, headVersion, deleted ? null : `sha256-${path}`, deleted ? 1 : 0)
    .run();
}

async function insertVersion(
  path: string,
  version: number,
  kind: "put" | "delete" | "rollback" = "put",
): Promise<void> {
  const commitId = `cmt_proof_${path}_${version}`;
  await db
    .prepare(
      `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
       VALUES (?, ?, ?, 1, 'proof', 1)`,
    )
    .bind(commitId, LIVE_STASH, kind)
    .run();
  await db
    .prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, rollback_of, created_at, commit_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      LIVE_STASH,
      path,
      version,
      kind,
      kind === "delete" ? null : `sha256-${path}-${version}`,
      kind === "rollback" ? 1 : null,
      commitId,
    )
    .run();
}

async function runGate(stash: string, entries: GateEntry[], clientKey: string): Promise<number> {
  const json = JSON.stringify(entries);
  const result = await db
    .prepare(commitGateSql)
    .bind(stash, entries.length, clientKey, stash, json, stash, stash, stash, stash, stash)
    .run();
  return result.meta.changes;
}

async function commitIds(clientKey: string): Promise<number[]> {
  const rows = await db
    .prepare("SELECT id FROM commit_gate_proof_commits WHERE client_key = ? ORDER BY id")
    .bind(clientKey)
    .all<{ id: number }>();
  return rows.results.map(({ id }) => id);
}

async function resetProofRows(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM versions"),
    db.prepare("DELETE FROM commits"),
    db.prepare("DELETE FROM files"),
    db.prepare("DELETE FROM stashes"),
    db.prepare("DELETE FROM commit_gate_proof_payloads"),
    db.prepare("DELETE FROM commit_gate_proof_marks"),
    db.prepare("DELETE FROM commit_gate_proof_commits"),
    db.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('commit_gate_proof_commits', 'versions')",
    ),
  ]);
}

beforeAll(async () => {
  await db.batch([
    db.prepare(`CREATE TABLE commit_gate_proof_commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stash_name TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      change_count INTEGER NOT NULL DEFAULT 0,
      sealed INTEGER NOT NULL DEFAULT 0,
      client_key TEXT NOT NULL UNIQUE,
      CHECK (sealed = 0 OR change_count = entry_count)
    )`),
    db.prepare(`CREATE TABLE commit_gate_proof_payloads (
      id INTEGER PRIMARY KEY,
      commit_id INTEGER NOT NULL,
      body TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE commit_gate_proof_marks (
      id INTEGER PRIMARY KEY,
      commit_id INTEGER NOT NULL
    )`),
  ]);
});

beforeEach(async () => {
  await resetProofRows();
  await insertStash(LIVE_STASH);
  await insertStash(DELETED_STASH, 2);
  await insertHead("live.txt", 1);
  await insertVersion("live.txt", 1);
  await insertHead("tombstone.txt", 1, { deleted: true });
  await insertVersion("tombstone.txt", 1, "delete");
  await insertHead("rollback.txt", 3);
  await insertVersion("rollback.txt", 1);
  await insertVersion("rollback.txt", 2, "delete");
  await insertVersion("rollback.txt", 3);
});

describe("commit aggregate gate D1 proofs", () => {
  it("uses one bound JSON value and changes one row only when every entry matches", async () => {
    const accepted: GateEntry[] = [
      { path: "new.txt", operation: "put" },
      { path: "new-with-null.txt", operation: "put", expectedVersion: null },
      { path: "live.txt", operation: "put", expectedVersion: 1 },
      { path: "live.txt", operation: "delete", expectedVersion: 1 },
      {
        path: "rollback.txt",
        operation: "rollback",
        expectedVersion: 3,
        rollbackVersion: 1,
      },
    ];
    expect(await runGate(LIVE_STASH, accepted, "all-match")).toBe(1);
    expect(await commitIds("all-match")).toHaveLength(1);

    const refusedCases: GateEntry[][] = [
      [{ path: "live.txt", operation: "put" }],
      [{ path: "live.txt", operation: "put", expectedVersion: 2 }],
      [{ path: "tombstone.txt", operation: "delete", expectedVersion: 1 }],
      [
        {
          path: "rollback.txt",
          operation: "rollback",
          expectedVersion: 3,
          rollbackVersion: 2,
        },
      ],
      [accepted[0]!, { path: "live.txt", operation: "put", expectedVersion: 2 }],
    ];
    for (const [index, entries] of refusedCases.entries()) {
      expect(await runGate(LIVE_STASH, entries, `refused-${index}`)).toBe(0);
      expect(await commitIds(`refused-${index}`)).toEqual([]);
    }

    expect(await runGate(DELETED_STASH, [accepted[0]!], "deleted-stash")).toBe(0);
    expect(await runGate(LIVE_STASH, [{ path: "omitted.txt", operation: "put" }], "omitted")).toBe(
      1,
    );
  });

  it("pins Zod as the integer guard because SQLite affinity accepts JSON string expectedVersion", async () => {
    const entries: GateEntry[] = [{ path: "live.txt", operation: "put", expectedVersion: "1" }];
    expect(await runGate(LIVE_STASH, entries, "string-affinity")).toBe(1);
  });
});

describe("D1 batch transaction and metadata proofs", () => {
  it.each([
    [
      "CHECK",
      "UPDATE commit_gate_proof_commits SET sealed = 1 WHERE client_key = 'rollback-check'",
    ],
    [
      "UNIQUE",
      `INSERT INTO commit_gate_proof_commits
         (stash_name, entry_count, change_count, sealed, client_key)
       VALUES ('${LIVE_STASH}', 0, 0, 1, 'rollback-unique')`,
    ],
  ])(
    "rolls back an earlier insert, sqlite_sequence, and id reuse after a %s failure",
    async (_, sql) => {
      const key = sql.includes("rollback-check") ? "rollback-check" : "rollback-unique";
      const first = db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
           (stash_name, entry_count, change_count, sealed, client_key)
         VALUES (?, 1, 0, 0, ?)`,
        )
        .bind(LIVE_STASH, key);
      const failing = db.prepare(sql);

      await expect(db.batch([first, failing])).rejects.toThrow(/D1_ERROR:.*SQLITE_CONSTRAINT/su);
      expect(await commitIds(key)).toEqual([]);
      const sequence = await db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'commit_gate_proof_commits'")
        .first<{ seq: number }>();
      expect(sequence).toBeNull();

      const next = await db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
           (stash_name, entry_count, change_count, sealed, client_key)
         VALUES (?, 0, 0, 1, ?)`,
        )
        .bind(LIVE_STASH, `after-${key}`)
        .run();
      expect(next.meta.last_row_id).toBe(1);
    },
  );

  it("pins exact changes and repeated last_row_id after a zero-row INSERT SELECT", async () => {
    await db
      .prepare(
        `INSERT INTO commit_gate_proof_commits
           (stash_name, entry_count, change_count, sealed, client_key)
         VALUES (?, 0, 0, 1, 'metadata-baseline')`,
      )
      .bind(LIVE_STASH)
      .run();
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
           (stash_name, entry_count, change_count, sealed, client_key)
         VALUES (?, 0, 0, 1, 'metadata-2')`,
        )
        .bind(LIVE_STASH),
      db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
           (stash_name, entry_count, change_count, sealed, client_key)
         SELECT ?, 0, 0, 1, 'metadata-refused' WHERE 0`,
        )
        .bind(LIVE_STASH),
      db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
             (stash_name, entry_count, change_count, sealed, client_key)
           VALUES (?, 0, 0, 1, 'metadata-3')`,
        )
        .bind(LIVE_STASH),
    ]);
    expect(
      results.map(({ meta }) => ({ changes: meta.changes, lastRowId: meta.last_row_id })),
    ).toEqual([
      { changes: 1, lastRowId: 2 },
      { changes: 0, lastRowId: 2 },
      { changes: 1, lastRowId: 3 },
    ]);
  });

  it.each([
    [true, [1, 1]],
    [false, [0, 0]],
  ] as const)(
    "makes statement 1 visibility to a statement 2 EXISTS fence equal %s",
    async (insert, expected) => {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO commit_gate_proof_commits
             (stash_name, entry_count, change_count, sealed, client_key)
           SELECT ?, 0, 0, 1, 'fence' WHERE ?`,
          )
          .bind(LIVE_STASH, insert ? 1 : 0),
        db.prepare(
          `INSERT INTO commit_gate_proof_marks (id, commit_id)
         SELECT 1, id FROM commit_gate_proof_commits WHERE client_key = 'fence'`,
        ),
      ]);
      expect(results.map(({ meta }) => meta.changes)).toEqual(expected);
    },
  );

  it("@local-only completes a 62-statement batch with 5,000,000 bound body bytes", async () => {
    const body = "x".repeat(250_000);
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO commit_gate_proof_commits
             (stash_name, entry_count, change_count, sealed, client_key)
           VALUES (?, 20, 0, 0, 'large-batch')`,
        )
        .bind(LIVE_STASH),
    ];
    for (let index = 1; index <= 20; index += 1) {
      statements.push(
        db
          .prepare("INSERT INTO commit_gate_proof_payloads (id, commit_id, body) VALUES (?, 1, ?)")
          .bind(index, body),
        db
          .prepare("INSERT INTO commit_gate_proof_marks (id, commit_id) VALUES (?, 1)")
          .bind(index * 2 - 1),
        db
          .prepare("INSERT INTO commit_gate_proof_marks (id, commit_id) VALUES (?, 1)")
          .bind(index * 2),
      );
    }
    statements.push(
      db.prepare(
        "UPDATE commit_gate_proof_commits SET change_count = 20, sealed = 1 WHERE client_key = 'large-batch'",
      ),
    );

    expect(statements).toHaveLength(62);
    const started = performance.now();
    const results = await db.batch(statements);
    const elapsedMs = Math.round(performance.now() - started);
    console.info("commit batch local-only proof", {
      statements: results.length,
      boundBodyBytes: body.length * 20,
      elapsedMs,
    });
    expect(results).toHaveLength(62);
    expect(body.length * 20).toBe(5_000_000);
    expect(results.every(({ success }) => success)).toBe(true);
  });
});

describe("change-id contiguity proof", () => {
  it("keeps one commit batch consecutive when a competing batch runs at the pre-commit hook", async () => {
    await db.prepare("DELETE FROM versions").run();
    await db.prepare("DELETE FROM commits").run();
    await db.prepare("DELETE FROM sqlite_sequence WHERE name = 'versions'").run();

    const onBeforeCommit = async (): Promise<void> => {
      await db.prepare(
        `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
         VALUES ('cmt_proof_competing', ?, 'put', 1, 'proof', 1)`,
      ).bind(LIVE_STASH).run();
      await db.batch([
        db
          .prepare(
            `INSERT INTO versions (stash_name, path, version, kind, blob_hash, created_at, commit_id)
           VALUES (?, 'competing.txt', 1, 'put', 'sha256-competing', 1, 'cmt_proof_competing')`,
          )
          .bind(LIVE_STASH),
      ]);
    };

    await db.prepare("SELECT 1 FROM stashes WHERE name = ?").bind(LIVE_STASH).first();
    await onBeforeCommit();
    await db.batch(
      ["a.txt", "b.txt", "c.txt"].map((path) =>
        db.prepare(
          `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
           VALUES (?, ?, 'put', 1, 'proof', 1)`,
        ).bind(`cmt_proof_${path}`, LIVE_STASH),
      ),
    );
    await db.batch(
      ["a.txt", "b.txt", "c.txt"].map((path) =>
        db
          .prepare(
            `INSERT INTO versions (stash_name, path, version, kind, blob_hash, created_at, commit_id)
             VALUES (?, ?, 1, 'put', ?, 1, ?)`,
          )
          .bind(LIVE_STASH, path, `sha256-${path}`, `cmt_proof_${path}`),
      ),
    );

    const rows = await db.prepare("SELECT id, path FROM versions ORDER BY id").all<{
      id: number;
      path: string;
    }>();
    const ownIds = rows.results.filter(({ path }) => path !== "competing.txt").map(({ id }) => id);
    expect(rows.results).toEqual([
      { id: 1, path: "competing.txt" },
      { id: 2, path: "a.txt" },
      { id: 3, path: "b.txt" },
      { id: 4, path: "c.txt" },
    ]);
    expect(ownIds).toEqual([2, 3, 4]);
    expect(ownIds.at(-1)! - ownIds[0]! + 1).toBe(ownIds.length);
  });
});
