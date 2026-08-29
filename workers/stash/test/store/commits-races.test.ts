import { env } from "cloudflare:workers";
import { R2_SPILL_BYTES, type CreateCommitBody } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createCommits, type CommitDependencies } from "../../src/d1/commits.js";
import { createStashStore } from "../../src/d1/store.js";
import { createGcEngine, GC_ORPHAN_MIN_AGE_MS } from "../../src/gc.js";
import type { Env } from "../../src/env.js";
import { commitEvents } from "../../src/events/publish.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

const workerEnv = env as Env;
let sequence = 0;

function deps(overrides: Partial<CommitDependencies> = {}): CommitDependencies {
  return {
    now: () => 10_000 + sequence,
    createId: () => `race-${++sequence}`,
    ...overrides,
  };
}

function store(now = 1_000) {
  return createStashStore(workerEnv, {
    now: () => now,
    createId: () => `seed-${++sequence}`,
  });
}

async function seedFile(stash: string, path: string, body = "seed") {
  const result = await store().writes.put(stash, path, { body, expectedVersion: null });
  if (!result.ok || "unchanged" in result.value) throw new Error("Failed to seed file");
  return result.value;
}

async function counts(stash: string) {
  const result = { commits: -1, versions: -1, files: -1, blobs: -1 };
  for (const table of ["commits", "versions", "files", "blobs"] as const) {
    result[table] =
      (await workerEnv.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
        .bind(stash)
        .first<number>("count")) ?? -1;
  }
  return result;
}

async function idempotencyRows(stash: string, key: string): Promise<number> {
  return (
    (await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM commits WHERE stash_name = ? AND idempotency_key = ?",
    )
      .bind(stash, key)
      .first<number>("count")) ?? -1
  );
}

beforeEach(async () => {
  sequence = 0;
  await resetDatabase();
});

describe("controlled commit races and invariants", () => {
  it("names exactly the raced path and leaks no loser rows when one of N heads moves", async () => {
    const stash = "race-one-head";
    await seedStash(stash);
    await seedFile(stash, "raced.txt");
    const before = await counts(stash);
    const winnerStore = store(9_000);
    const commits = createCommits(
      workerEnv,
      deps({
        onBeforeCommit: async () => {
          const winner = await winnerStore.writes.put(stash, "raced.txt", {
            body: "winner",
            expectedVersion: 1,
          });
          if (!winner.ok) throw new Error("Race winner failed");
        },
      }),
    );

    const refused = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "new-a.txt", expectedVersion: null, body: "a" },
          { op: "put", path: "raced.txt", expectedVersion: 1, body: "loser" },
          { op: "put", path: "new-b.txt", expectedVersion: null, body: "b" },
        ],
      },
      { principal: "test", idempotencyKey: "loser" },
    );

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "commit-conflict", status: 409 },
      conflicts: [{ path: "raced.txt", current: { version: 2 } }],
    });
    expect(refused.ok ? [] : refused.conflicts?.map(({ path }) => path)).toEqual(["raced.txt"]);
    expect(await counts(stash)).toEqual({
      commits: before.commits + 1,
      versions: before.versions + 1,
      files: before.files,
      blobs: before.blobs + 1,
    });
    expect(await idempotencyRows(stash, "loser")).toBe(0);
  });

  it("serializes simultaneous identical idempotency keys into one winner and one replay", async () => {
    const stash = "race-idempotency";
    await seedStash(stash);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commits = createCommits(
      workerEnv,
      deps({
        onBeforeCommit: async () => {
          arrivals += 1;
          if (arrivals === 2) release();
          await barrier;
        },
      }),
    );
    const input: CreateCommitBody = {
      entries: [{ op: "put", path: "same.txt", expectedVersion: null, body: "same" }],
    };

    const results = await Promise.all([
      commits.createCommit(stash, input, { principal: "a", idempotencyKey: "same" }),
      commits.createCommit(stash, input, { principal: "a", idempotencyKey: "same" }),
    ]);

    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    if (!results[0]?.ok || !results[1]?.ok) throw new Error("Expected two successful results");
    expect(results[0].value).toEqual(results[1].value);
    expect(await counts(stash)).toEqual({ commits: 1, versions: 1, files: 1, blobs: 1 });
    expect(await idempotencyRows(stash, "same")).toBe(1);
  });

  it.each([
    [
      "duplicate path",
      {
        entries: [
          { op: "put", path: "same.txt", expectedVersion: null, body: "a" },
          { op: "put", path: "same.txt", expectedVersion: null, body: "b" },
        ],
      },
    ],
    [
      "intra-commit copy source",
      {
        entries: [
          { op: "put", path: "source.txt", expectedVersion: null, body: "a" },
          {
            op: "copy",
            path: "copy.txt",
            expectedVersion: null,
            from: { path: "source.txt", version: 1 },
          },
        ],
      },
    ],
  ] satisfies Array<[string, CreateCommitBody]>)(
    "rejects %s before creating a batch",
    async (_label, input) => {
      const stash = `race-validation-${sequence++}`;
      await seedStash(stash);
      let beforeBatch = false;
      const result = await createCommits(
        workerEnv,
        deps({
          onBeforeCommit: () => {
            beforeBatch = true;
          },
        }),
      ).createCommit(stash, input, { principal: "test" });

      expect(result).toMatchObject({ ok: false, error: { code: "validation", status: 400 } });
      expect(beforeBatch).toBe(false);
      expect(await counts(stash)).toEqual({ commits: 0, versions: 0, files: 0, blobs: 0 });
    },
  );

  it("reports the newest offending change id for whole-stash stale CAS without rows", async () => {
    const stash = "race-last-change";
    await seedStash(stash);
    const seeded = await seedFile(stash, "existing.txt");
    const before = await counts(stash);
    const result = await createCommits(workerEnv, deps()).createCommit(
      stash,
      {
        entries: [{ op: "put", path: "new.txt", expectedVersion: null, body: "new" }],
        expectedLastChangeId: seeded.changeId - 1,
      },
      { principal: "test", idempotencyKey: "stale" },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    if (result.ok) throw new Error("Expected stale result");
    expect(result.error.message).toContain(`newest change is ${seeded.changeId}`);
    expect(await counts(stash)).toEqual(before);
    expect(await idempotencyRows(stash, "stale")).toBe(0);
  });

  it("lets a prefix-scoped commit survive an unrelated raced write while whole-stash CAS refuses it", async () => {
    async function raceDocsWrite(stash: string, expectedLastChangePrefix?: string) {
      await seedStash(stash);
      await seedFile(stash, "site/existing.txt");
      const newest = await seedFile(stash, "docs/existing.txt");
      let afterCompetitor: Awaited<ReturnType<typeof counts>> | null = null;
      const commits = createCommits(
        workerEnv,
        deps({
          onBeforeCommit: async () => {
            const competitor = await store(9_000).writes.put(stash, "docs/other.txt", {
              body: "competitor",
              expectedVersion: null,
            });
            if (!competitor.ok) throw new Error("Docs competitor failed");
            afterCompetitor = await counts(stash);
          },
        }),
      );
      const result = await commits.createCommit(
        stash,
        {
          entries: [
            { op: "put", path: "site/candidate.txt", expectedVersion: null, body: "candidate" },
          ],
          expectedLastChangeId: newest.changeId,
          ...(expectedLastChangePrefix === undefined ? {} : { expectedLastChangePrefix }),
        },
        { principal: "test" },
      );
      return { result, afterCompetitor };
    }

    const scoped = await raceDocsWrite("race-prefix-docs", "site");
    expect(scoped.result.ok).toBe(true);
    if (!scoped.result.ok) throw new Error("Expected prefix-scoped commit to succeed");
    await expect(
      workerEnv.DB.prepare(
        `SELECT v.path, v.commit_id, c.sealed
         FROM versions AS v JOIN commits AS c ON c.id = v.commit_id
         WHERE v.stash_name = ? AND v.commit_id = ?`,
      )
        .bind("race-prefix-docs", scoped.result.value.id)
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          path: "site/candidate.txt",
          commit_id: scoped.result.value.id,
          sealed: 1,
        },
      ],
    });

    const whole = await raceDocsWrite("race-whole-docs");
    expect(whole.result).toMatchObject({
      ok: false,
      error: { code: "stale", status: 409 },
    });
    expect(whole.result).not.toHaveProperty("conflicts");
    expect(await counts("race-whole-docs")).toEqual(whole.afterCompetitor);
  });

  it("refuses a prefix-scoped commit after a raced write under that prefix without leaking rows", async () => {
    const stash = "race-prefix-site";
    await seedStash(stash);
    await seedFile(stash, "site/existing.txt");
    const newest = await seedFile(stash, "docs/existing.txt");
    let afterCompetitor: Awaited<ReturnType<typeof counts>> | null = null;
    const commits = createCommits(
      workerEnv,
      deps({
        onBeforeCommit: async () => {
          const competitor = await store(9_000).writes.put(stash, "site/other.txt", {
            body: "competitor",
            expectedVersion: null,
          });
          if (!competitor.ok) throw new Error("Site competitor failed");
          afterCompetitor = await counts(stash);
        },
      }),
    );

    const refused = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "site/candidate.txt", expectedVersion: null, body: "candidate" },
        ],
        expectedLastChangeId: newest.changeId,
        expectedLastChangePrefix: "site",
      },
      { principal: "test" },
    );

    expect(refused).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    expect(refused).not.toHaveProperty("conflicts");
    expect(await counts(stash)).toEqual(afterCompetitor);
  });

  it("rolls back a forced missing head write and classifies the durable re-read as internal", async () => {
    const stash = "race-seal-check";
    await seedStash(stash);
    let batchRejected = false;
    const database = new Proxy(workerEnv.DB, {
      get(target, property, receiver) {
        if (property !== "withSession") return Reflect.get(target, property, receiver);
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty, sessionReceiver) {
              if (sessionProperty !== "batch") {
                return Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
              }
              return async (statements: D1PreparedStatement[]) => {
                try {
                  return await sessionTarget.batch(statements);
                } catch (error) {
                  batchRejected = true;
                  throw error;
                }
              };
            },
          });
        };
      },
    });
    const commits = createCommits(
      { ...workerEnv, DB: database },
      deps({
        alterCommitStatementsForTest: (statements) =>
          statements.filter((_, index) => index !== statements.length - 2),
      }),
    );
    const result = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "one.txt", expectedVersion: null, body: "one" },
          { op: "put", path: "two.txt", expectedVersion: null, body: "two" },
        ],
      },
      { principal: "test", idempotencyKey: "forced-seal" },
    );

    expect(batchRejected).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: "internal", status: 500 } });
    expect(await counts(stash)).toEqual({ commits: 0, versions: 0, files: 0, blobs: 0 });
    expect(await idempotencyRows(stash, "forced-seal")).toBe(0);
    await expect(
      workerEnv.DB.prepare(
        "SELECT path, head_version FROM files WHERE stash_name = ? ORDER BY path",
      )
        .bind(stash)
        .all(),
    ).resolves.toMatchObject({ results: [] });
  });

  it("garbage-collects exactly N spilled objects from a refused commit", async () => {
    const stash = "race-r2-orphans";
    await seedStash(stash);
    await seedFile(stash, "raced.txt");
    const spillA = "a".repeat(R2_SPILL_BYTES + 1);
    const spillB = "b".repeat(R2_SPILL_BYTES + 1);
    let generation = 0;
    const commits = createCommits(
      workerEnv,
      deps({
        createBlobGeneration: () =>
          `11111111-1111-4111-8111-${String(++generation).padStart(12, "0")}`,
        onBeforeCommit: async () => {
          const winner = await store(9_000).writes.put(stash, "raced.txt", {
            body: "winner",
            expectedVersion: 1,
          });
          if (!winner.ok) throw new Error("Race winner failed");
        },
      }),
    );
    const result = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "raced.txt", expectedVersion: 1, body: spillA },
          { op: "put", path: "new.txt", expectedVersion: null, body: spillB },
        ],
      },
      { principal: "test", idempotencyKey: "spilled-loser" },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "commit-conflict" } });
    expect(await idempotencyRows(stash, "spilled-loser")).toBe(0);
    const beforeGc = await workerEnv.BLOBS.list();
    expect(beforeGc.objects).toHaveLength(2);
    const newestUpload = Math.max(...beforeGc.objects.map(({ uploaded }) => uploaded.getTime()));
    const gc = await createGcEngine(workerEnv, {
      now: () => newestUpload + GC_ORPHAN_MIN_AGE_MS + 1,
    }).run({ kind: "r2-orphans", dryRun: false, maxObjects: 10 });
    expect(gc).toMatchObject({ scanned: 2, eligible: 2, deleted: 2 });
    expect((await workerEnv.BLOBS.list()).objects).toHaveLength(0);
  });

  it("keeps a multi-entry commit contiguous around an injected unrelated write", async () => {
    const stash = "race-contiguous";
    await seedStash(stash);
    const first = await seedFile(stash, "before.txt");
    let competitorId = -1;
    let competitorCommitId = "";
    const commits = createCommits(
      workerEnv,
      deps({
        onBeforeCommit: async () => {
          const competitor = await store(9_000).writes.put(stash, "competitor.txt", {
            body: "between",
            expectedVersion: null,
          });
          if (!competitor.ok || "unchanged" in competitor.value) {
            throw new Error("Competitor failed");
          }
          competitorId = competitor.value.changeId;
          competitorCommitId = competitor.value.commitId;
        },
      }),
    );
    const result = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "one.txt", expectedVersion: null, body: "one" },
          { op: "put", path: "two.txt", expectedVersion: null, body: "two" },
          { op: "put", path: "three.txt", expectedVersion: null, body: "three" },
        ],
      },
      { principal: "test" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected successful commit");
    expect(competitorId).toBe(first.changeId + 1);
    expect(result.value.entries.map(({ changeId }) => changeId)).toEqual([
      competitorId + 1,
      competitorId + 2,
      competitorId + 3,
    ]);
    expect(result.value.firstChangeId).toBe(competitorId + 1);
    expect(result.value.lastChangeId).toBe(competitorId + 3);

    // The raw D1 batch guarantee is proved separately in commit-gate-proofs.test.ts under
    // "change-id contiguity proof"; this is the corresponding store-level contract.
    const block = await workerEnv.DB.prepare(
      `SELECT id, path, commit_id FROM versions
       WHERE stash_name = ? AND id BETWEEN ? AND ? ORDER BY id`,
    )
      .bind(stash, result.value.firstChangeId, result.value.lastChangeId)
      .all<{ id: number; path: string; commit_id: string }>();
    expect(block.results).toHaveLength(3);
    expect(block.results.every(({ commit_id }) => commit_id === result.value.id)).toBe(true);
    expect(block.results.map(({ path }) => path)).toEqual(["one.txt", "two.txt", "three.txt"]);

    await expect(
      store().reads.resolveCommitAtChange(stash, result.value.firstChangeId),
    ).resolves.toBe(competitorCommitId);
    await expect(store().reads.resolveCommitAtChange(stash, competitorId)).resolves.toBe(
      competitorCommitId,
    );
  });

  it("calls onCommitted once for a new commit and never for its replay", async () => {
    const stash = "race-on-committed";
    await seedStash(stash);
    const published: string[] = [];
    const input: CreateCommitBody = {
      entries: [{ op: "put", path: "event.txt", expectedVersion: null, body: "event" }],
    };
    const commits = createCommits(workerEnv, deps());
    const options = {
      principal: "test",
      idempotencyKey: "event",
      onCommitted: (result: { id: string }) => {
        published.push(result.id);
      },
    };

    const created = await commits.createCommit(stash, input, options);
    const replayed = await commits.createCommit(stash, input, options);

    expect(created.ok).toBe(true);
    expect(replayed).toMatchObject({ ok: true, replayed: true });
    expect(published).toEqual(created.ok ? [created.value.id] : []);
    expect(await counts(stash)).toEqual({ commits: 1, versions: 1, files: 1, blobs: 1 });
  });

  it("publishes only the new change when copying a version created by an upload", async () => {
    const stash = "race-copy-upload";
    await seedStash(stash);
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO commits
            (id, stash_name, source, source_id, entry_count, change_count, sealed,
             first_change_id, last_change_id, created_by, created_at)
           VALUES ('cmt_uploaded', ?, 'upload', 'upl_source', 1, 1, 1, 1, 1, 'test', 1)`,
      ).bind(stash),
      workerEnv.DB.prepare(
        `INSERT INTO versions
            (id, stash_name, path, version, kind, blob_hash, size_bytes, content_type,
             created_at, representation, application_etag, content_storage, commit_id)
           VALUES (1, ?, 'uploaded.bin', 1, 'put', 'sha256-uploaded', 2,
             'application/octet-stream', 1, 'binary', 'etag-uploaded', 'bytes', 'cmt_uploaded')`,
      ).bind(stash),
      workerEnv.DB.prepare(
        `INSERT INTO files
            (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
           VALUES (?, 'uploaded.bin', 1, 'sha256-uploaded', 0, 1, 1)`,
      ).bind(stash),
    ]);
    const published = [] as ReturnType<typeof commitEvents>;
    const result = await createCommits(workerEnv, deps()).createCommit(
      stash,
      {
        entries: [
          {
            op: "copy",
            path: "copied.bin",
            expectedVersion: null,
            from: { path: "uploaded.bin", version: 1 },
          },
        ],
      },
      {
        principal: "test",
        onCommitted: (committed) => {
          published.push(...commitEvents(committed, null));
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected copy commit");
    expect(published.filter(({ type }) => type === "change")).toEqual([
      expect.objectContaining({
        type: "change",
        changeId: result.value.entries[0]?.changeId,
        commitId: result.value.id,
        path: "copied.bin",
      }),
    ]);
    expect(published.map(({ type }) => type)).toEqual(["change", "commit"]);
    expect(published).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ changeId: 1 })]),
    );
  });
});
