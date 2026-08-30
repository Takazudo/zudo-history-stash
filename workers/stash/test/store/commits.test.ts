import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, type CreateCommitBody } from "@takazudo/zudo-history-stash-core";
import type { Env } from "../../src/env.js";
import { createCommits } from "../../src/d1/commits.js";
import { createStashStore } from "../../src/d1/store.js";
import {
  commitBatch,
  type CommitBatchInput,
  type PreparedCommitEntry,
} from "../../src/d1/sql/commits.js";
import { resetDatabase, seedStash } from "../helpers/app.js";
import { generation } from "../helpers/blob-generations.js";

const workerEnv = env as Env;
let sequence = 0;

function store(now = 10_000) {
  return createStashStore(workerEnv, {
    now: () => now,
    createId: () => `commit-test-${++sequence}`,
  });
}

async function seedFile(stash: string, path: string, body: string) {
  const result = await store(2_000 + sequence).writes.put(stash, path, {
    body,
    expectedVersion: null,
  });
  if (!result.ok || "unchanged" in result.value) throw new Error("Failed to seed file");
  return result.value;
}

async function tableCount(table: "commits" | "versions" | "files", stash: string) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
    .bind(stash)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

function preparedPut(
  path: string,
  expectedVersion: number | null,
  version: number,
): PreparedCommitEntry {
  return {
    op: "put",
    path,
    expectedVersion,
    version,
    author: "author",
    message: "message",
    metaJson: "{}",
    createdAt: 1_000,
    representation: "text",
    hash: `sha256-${"a".repeat(64)}`,
    size: 4,
    contentType: "text/plain; charset=utf-8",
    body: "body",
    r2_key: null,
  };
}

function commitBatchInput(
  stash: string,
  entries: PreparedCommitEntry[],
  ledger?: CommitBatchInput["ledger"],
): CommitBatchInput {
  return {
    row: {
      id: `cmt-direct-${stash}`,
      stash_name: stash,
      source: "commit",
      source_id: null,
      author: "author",
      message: "message",
      meta_json: "{}",
      entry_count: entries.length,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: "request-hash",
      created_by: "test",
      created_at: 1_000,
    },
    entries,
    ...(ledger ? { ledger } : {}),
  };
}

beforeEach(async () => {
  sequence = 0;
  await resetDatabase();
});

describe("commit store", () => {
  function base64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  it("writes one fenced ledger row for a successful direct commit batch", async () => {
    const stash = "commit-batch-ledger";
    await seedStash(stash);
    const input = commitBatchInput(stash, [preparedPut("one.txt", null, 1)], {
      key: "direct-key",
      requestHash: "direct-request",
      statusCode: 201,
    });

    const results = await env.DB.batch(commitBatch(env.DB, input));

    expect(results.at(-1)?.meta.changes).toBe(1);
    const ledger = await env.DB.prepare(
      "SELECT key, request_hash, path, version, status_code FROM idempotency WHERE stash_name = ?",
    )
      .bind(stash)
      .all();
    expect(ledger.results).toEqual([
      {
        key: "direct-key",
        request_hash: "direct-request",
        path: "one.txt",
        version: 1,
        status_code: 201,
      },
    ]);
  });

  it("writes no ledger row when the direct commit batch gate refuses", async () => {
    const stash = "commit-batch-ledger-refused";
    await seedStash(stash);
    await seedFile(stash, "one.txt", "before");
    const input = commitBatchInput(stash, [preparedPut("one.txt", 99, 100)], {
      key: "refused-key",
      requestHash: "refused-request",
      statusCode: 201,
    });

    const results = await env.DB.batch(commitBatch(env.DB, input));

    expect(results.at(-1)?.meta.changes).toBe(0);
    const ledger = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE stash_name = ?",
    )
      .bind(stash)
      .first<{ count: number }>();
    expect(ledger?.count).toBe(0);
  });

  it("rejects a ledger on a multi-entry direct commit batch", async () => {
    const stash = "commit-batch-ledger-many";
    const input = commitBatchInput(
      stash,
      [preparedPut("one.txt", null, 1), preparedPut("two.txt", null, 1)],
      { key: "many-key", requestHash: "many-request", statusCode: 201 },
    );

    expect(() => commitBatch(env.DB, input)).toThrow(
      "Commit batch ledger requires exactly one entry",
    );
  });

  it("atomically seals create, put, and delete entries under one commit", async () => {
    const stash = "commit-three";
    await seedStash(stash);
    await seedFile(stash, "updated.txt", "before");
    await seedFile(stash, "deleted.txt", "delete me");

    const result = await store().commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "created.txt", expectedVersion: null, body: "created" },
          { op: "put", path: "updated.txt", expectedVersion: 1, body: "after" },
          { op: "delete", path: "deleted.txt", expectedVersion: 1 },
        ],
        author: "A",
        message: "three changes",
        meta: { purpose: "acceptance" },
      },
      { principal: "test-principal", idempotencyKey: "three" },
    );

    expect(result).toMatchObject({
      ok: true,
      statusCode: 201,
      value: {
        source: "commit",
        entryCount: 3,
        createdBy: "test-principal",
        entries: [
          { path: "created.txt", op: "put", version: 1, kind: "put" },
          { path: "updated.txt", op: "put", version: 2, kind: "put" },
          { path: "deleted.txt", op: "delete", version: 2, kind: "delete" },
        ],
      },
    });
    if (!result.ok) throw new Error("Expected commit success");
    expect(result.value.meta).toEqual({ commitId: result.value.id, purpose: "acceptance" });

    const commit = await env.DB.prepare(
      `SELECT entry_count, change_count, sealed, first_change_id, last_change_id
       FROM commits WHERE id = ?`,
    )
      .bind(result.value.id)
      .first();
    const versions = await env.DB.prepare(
      `SELECT id, commit_id FROM versions WHERE stash_name = ? AND commit_id = ? ORDER BY id`,
    )
      .bind(stash, result.value.id)
      .all<{ id: number; commit_id: string }>();
    expect(commit).toEqual({
      entry_count: 3,
      change_count: 3,
      sealed: 1,
      first_change_id: versions.results[0]?.id,
      last_change_id: versions.results.at(-1)?.id,
    });
    expect(versions.results).toHaveLength(3);
    expect(versions.results.every((row) => row.commit_id === result.value.id)).toBe(true);
    await expect(
      env.DB.prepare(
        `SELECT path, head_version, deleted FROM files
         WHERE stash_name = ? ORDER BY path`,
      )
        .bind(stash)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { path: "created.txt", head_version: 1, deleted: 0 },
        { path: "deleted.txt", head_version: 2, deleted: 1 },
        { path: "updated.txt", head_version: 2, deleted: 0 },
      ],
    });
  });

  it("refuses an entire stale three-entry request without rows or sequence consumption", async () => {
    const stash = "commit-stale";
    await seedStash(stash);
    await seedFile(stash, "stale.txt", "one");
    const before = {
      commits: await tableCount("commits", stash),
      versions: await tableCount("versions", stash),
      files: await tableCount("files", stash),
      sequence: await env.DB.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'versions'",
      ).first(),
    };

    const result = await store().commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "new-a.txt", expectedVersion: null, body: "a" },
          { op: "put", path: "stale.txt", expectedVersion: 99, body: "stale" },
          { op: "put", path: "new-b.txt", expectedVersion: null, body: "b" },
        ],
      },
      { principal: "test" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "commit-conflict", status: 409 },
      conflicts: [{ path: "stale.txt", expectedVersion: 99, current: { version: 1 } }],
    });
    expect(await tableCount("commits", stash)).toBe(before.commits);
    expect(await tableCount("versions", stash)).toBe(before.versions);
    expect(await tableCount("files", stash)).toBe(before.files);
    await expect(
      env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'versions'").first(),
    ).resolves.toEqual(before.sequence);
  });

  it("lets the aggregate gate reject a raced head without partial rows or sequence use", async () => {
    const stash = "commit-gate-race";
    await seedStash(stash);
    await seedFile(stash, "raced.txt", "one");
    let hookRan = false;
    const writes = store(9_000).writes;
    const commits = createCommits(workerEnv, {
      now: () => 10_000,
      createId: () => `raced-${++sequence}`,
      onBeforeCommit: async () => {
        hookRan = true;
        const winner = await writes.put(stash, "raced.txt", {
          body: "winner",
          expectedVersion: 1,
        });
        if (!winner.ok) throw new Error("Failed to commit race winner");
      },
    });
    const result = await commits.createCommit(
      stash,
      {
        entries: [
          { op: "put", path: "new-a.txt", expectedVersion: null, body: "a" },
          { op: "put", path: "raced.txt", expectedVersion: 1, body: "loser" },
          { op: "put", path: "new-b.txt", expectedVersion: null, body: "b" },
        ],
      },
      { principal: "test" },
    );
    expect(hookRan).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "commit-conflict" },
      conflicts: [{ path: "raced.txt", current: { version: 2 } }],
    });
    expect(await tableCount("commits", stash)).toBe(2);
    expect(await tableCount("versions", stash)).toBe(2);
    expect(await tableCount("files", stash)).toBe(1);
    await expect(
      env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'versions'").first(),
    ).resolves.toEqual({ seq: 2 });
  });

  it("spills a 600KB binary and leaves a refused spill as an R2-only GC orphan", async () => {
    const stash = "commit-binary-spill";
    await seedStash(stash);
    const bytes = Uint8Array.from({ length: 600 * 1024 }, (_, index) => index % 251);
    const hash = await sha256Hex(bytes.slice().buffer as ArrayBuffer);
    const first = createCommits(workerEnv, {
      now: () => 10_000,
      createId: () => "binary-spill-one",
      createBlobGeneration: () => generation(1),
    });
    const committed = await first.createCommit(
      stash,
      {
        entries: [
          {
            op: "put",
            path: "large.bin",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: base64(bytes),
          },
        ],
      },
      { principal: "test" },
    );
    expect(committed).toMatchObject({
      ok: true,
      value: { entries: [{ hash, size: bytes.length, storageTier: "r2" }] },
    });
    await expect(
      env.DB.prepare("SELECT body_bytes, r2_key FROM byte_blobs WHERE stash_name = ? AND hash = ?")
        .bind(stash, hash)
        .first(),
    ).resolves.toEqual({
      body_bytes: null,
      r2_key: `v2/${stash}/${hash}/${generation(1)}`,
    });

    await seedFile(stash, "raced.txt", "before");
    const refusedBytes = bytes.map((byte) => byte ^ 0xff);
    const refusedHash = await sha256Hex(refusedBytes.slice().buffer as ArrayBuffer);
    const writes = store(11_000).writes;
    const raced = createCommits(workerEnv, {
      now: () => 12_000,
      createId: () => "binary-spill-raced",
      createBlobGeneration: () => generation(2),
      onBeforeCommit: async () => {
        const winner = await writes.put(stash, "raced.txt", {
          body: "winner",
          expectedVersion: 1,
        });
        if (!winner.ok) throw new Error("Failed to commit race winner");
      },
    });
    const refused = await raced.createCommit(
      stash,
      {
        entries: [
          {
            op: "put",
            path: "refused.bin",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: base64(refusedBytes),
          },
          { op: "put", path: "raced.txt", expectedVersion: 1, body: "loser" },
        ],
      },
      { principal: "test" },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "commit-conflict" } });
    await expect(
      env.DB.prepare("SELECT 1 FROM byte_blobs WHERE stash_name = ? AND hash = ?")
        .bind(stash, refusedHash)
        .first(),
    ).resolves.toBeNull();
    const orphanKey = `v2/${stash}/${refusedHash}/${generation(2)}`;
    await expect(env.BLOBS.head(orphanKey)).resolves.not.toBeNull();
    await expect(
      env.DB.prepare("SELECT 1 FROM byte_blobs WHERE r2_key = ?").bind(orphanKey).first(),
    ).resolves.toBeNull();
  });

  it("builds copy and rollback entries from live stored versions", async () => {
    const stash = "commit-derived";
    await seedStash(stash);
    const source = await seedFile(stash, "source.txt", "source body");
    await seedFile(stash, "rollback.txt", "rollback body");
    const result = await store().commits.createCommit(
      stash,
      {
        entries: [
          {
            op: "copy",
            path: "copy.txt",
            expectedVersion: null,
            from: { path: "source.txt", version: 1 },
          },
          {
            op: "rollback",
            path: "rollback.txt",
            expectedVersion: 1,
            toVersion: 1,
          },
        ],
      },
      { principal: "test" },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            op: "copy",
            path: "copy.txt",
            kind: "put",
            hash: source.hash,
            copiedFrom: { path: "source.txt", version: 1 },
          },
          {
            op: "rollback",
            path: "rollback.txt",
            kind: "rollback",
            rollbackOf: 1,
            identicalToHead: true,
          },
        ],
      },
    });
  });

  it.each([
    ["put", { op: "put", path: "missing.txt", expectedVersion: 1, body: "x" }],
    ["delete", { op: "delete", path: "missing.txt", expectedVersion: 1 }],
    ["rollback", { op: "rollback", path: "missing.txt", expectedVersion: 1, toVersion: 1 }],
  ] satisfies Array<[string, CreateCommitBody["entries"][number]]>)(
    "%s against an absent path is a not-found conflict",
    async (_name, entry) => {
      const stash = `commit-absent-${_name}`;
      await seedStash(stash);
      const result = await store().commits.createCommit(
        stash,
        { entries: [entry] },
        { principal: "test" },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "not-found", status: 404 },
        conflicts: [{ path: "missing.txt", expectedVersion: 1, current: null }],
      });
    },
  );

  it("replays the identical durable result by idempotency key", async () => {
    const stash = "commit-replay";
    await seedStash(stash);
    const input = {
      entries: [{ op: "put" as const, path: "one.txt", expectedVersion: null, body: "one" }],
    };
    const commits = store().commits;
    const first = await commits.createCommit(stash, input, {
      principal: "test",
      idempotencyKey: "same",
    });
    const replayed = await commits.createCommit(stash, input, {
      principal: "test",
      idempotencyKey: "same",
    });
    expect(first.ok).toBe(true);
    expect(replayed).toEqual(first.ok ? { ...first, replayed: true } : first);
    expect(await tableCount("commits", stash)).toBe(1);
    expect(await tableCount("versions", stash)).toBe(1);
  });

  it("reports the newest change id for stale whole-stash CAS", async () => {
    const stash = "commit-last-change";
    await seedStash(stash);
    const seeded = await seedFile(stash, "existing.txt", "one");
    const result = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "new.txt", expectedVersion: null, body: "new" }],
        expectedLastChangeId: seeded.changeId - 1,
      },
      { principal: "test" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    if (result.ok) throw new Error("Expected stale result");
    expect(result.error.message).toContain(`newest change is ${seeded.changeId}`);
    expect(await tableCount("versions", stash)).toBe(1);
  });

  it("allows a prefix-scoped commit after only an unrelated prefix changed", async () => {
    const stash = "commit-prefix-unrelated";
    await seedStash(stash);
    const site = await seedFile(stash, "site/index.html", "one");
    const docs = await seedFile(stash, "docs/readme.md", "later");
    expect(docs.changeId).toBeGreaterThan(site.changeId);

    const result = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "site/about.html", expectedVersion: null, body: "about" }],
        expectedLastChangeId: site.changeId,
        expectedLastChangePrefix: "site",
      },
      { principal: "test" },
    );

    expect(result).toMatchObject({ ok: true, statusCode: 201 });
  });

  it("rejects a prefix-scoped commit after that prefix changed", async () => {
    const stash = "commit-prefix-stale";
    await seedStash(stash);
    const cursor = await seedFile(stash, "site/index.html", "one");
    let newerChangeId: number | undefined;
    const commits = createCommits(workerEnv, {
      now: () => 10_000,
      createId: () => `prefix-stale-${++sequence}`,
      onBeforeCommit: async () => {
        const newer = await seedFile(stash, "site/about.html", "later");
        newerChangeId = newer.changeId;
      },
    });

    const result = await commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "site/new.html", expectedVersion: null, body: "new" }],
        expectedLastChangeId: cursor.changeId,
        expectedLastChangePrefix: "site/",
      },
      { principal: "test" },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    if (result.ok) throw new Error("Expected stale result");
    expect(result.error.message).toContain('for prefix "site/"');
    expect(newerChangeId).toBeDefined();
    expect(result.error.message).toContain(`newest change is ${newerChangeId}`);
  });

  it("rejects a future whole-stash cursor but accepts a future prefix cursor", async () => {
    const stash = "commit-prefix-future";
    await seedStash(stash);
    const seeded = await seedFile(stash, "existing.txt", "one");
    const futureCursor = seeded.changeId + 100;

    const wholeStash = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "whole.txt", expectedVersion: null, body: "whole" }],
        expectedLastChangeId: futureCursor,
      },
      { principal: "test" },
    );
    const prefixScoped = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "site/new.html", expectedVersion: null, body: "site" }],
        expectedLastChangeId: futureCursor,
        expectedLastChangePrefix: "site",
      },
      { principal: "test" },
    );

    expect(wholeStash).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    expect(prefixScoped).toMatchObject({ ok: true, statusCode: 201 });
  });

  it("allows a prefix-scoped commit when the prefix has no existing writes", async () => {
    const stash = "commit-prefix-empty";
    await seedStash(stash);
    const unrelated = await seedFile(stash, "docs/readme.md", "docs");

    const result = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "site/index.html", expectedVersion: null, body: "site" }],
        expectedLastChangeId: unrelated.changeId,
        expectedLastChangePrefix: "site",
      },
      { principal: "test" },
    );

    expect(result).toMatchObject({ ok: true, statusCode: 201 });
  });

  it("rejects an invalid expected-last-change prefix", async () => {
    const stash = "commit-prefix-invalid";
    await seedStash(stash);

    const result = await store().commits.createCommit(
      stash,
      {
        entries: [{ op: "put", path: "new.txt", expectedVersion: null, body: "new" }],
        expectedLastChangeId: 0,
        expectedLastChangePrefix: "..",
      },
      { principal: "test" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid-path", status: 400, message: "Invalid file path" },
    });
    expect(await tableCount("commits", stash)).toBe(0);
  });

  it("treats different expected-last-change prefixes as different idempotent requests", async () => {
    const stash = "commit-prefix-idempotency";
    await seedStash(stash);
    const input = {
      entries: [{ op: "put" as const, path: "new.txt", expectedVersion: null, body: "new" }],
      expectedLastChangeId: 100,
    };
    const commits = store().commits;

    const first = await commits.createCommit(
      stash,
      { ...input, expectedLastChangePrefix: "site" },
      { principal: "test", idempotencyKey: "prefix-key" },
    );
    const reused = await commits.createCommit(
      stash,
      { ...input, expectedLastChangePrefix: "docs" },
      { principal: "test", idempotencyKey: "prefix-key" },
    );

    expect(first).toMatchObject({ ok: true, statusCode: 201 });
    expect(reused).toMatchObject({
      ok: false,
      error: { code: "idempotency-key-reused", status: 422 },
    });
  });

  it("classifies malformed text before schema validation", async () => {
    const stash = "commit-malformed";
    await seedStash(stash);
    const result = await store().commits.createCommit(
      stash,
      { entries: [{ op: "put", path: "bad.txt", expectedVersion: null, body: "\ud800" }] },
      { principal: "test" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "body-not-well-formed", status: 400 },
    });
    expect(await tableCount("commits", stash)).toBe(0);
  });
});
