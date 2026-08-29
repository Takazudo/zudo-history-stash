import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createChangeSets } from "../../src/d1/change-sets.js";
import { createStashStore } from "../../src/d1/store.js";
import type { Env } from "../../src/env.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

const workerEnv = env as Env;
let sequence = 0;

function dependencies(now = 20_000) {
  return { now: () => now, createId: () => `approve-${++sequence}` };
}

function store(now = 20_000) {
  return createStashStore(workerEnv, dependencies(now));
}

async function seedFile(stash: string, path: string, body: string) {
  const result = await store(10_000 + sequence).writes.put(stash, path, {
    body,
    expectedVersion: null,
  });
  if (!result.ok) throw new Error("seed failed");
  if (!("changeId" in result.value)) throw new Error("seed did not create a version");
  return result.value.changeId;
}

async function counts(stash: string) {
  const result = { commits: -1, versions: -1, files: -1 };
  for (const table of ["commits", "versions", "files"] as const) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
      .bind(stash)
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

beforeEach(async () => {
  sequence = 0;
  await resetDatabase();
});

describe("change-set decisions", () => {
  it("approves one text put and replays the stored applied commit", async () => {
    const stash = "approve-text";
    await seedStash(stash);
    const changes = store();
    const created = await changes.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "candidate.txt", baseVersion: null, body: "candidate" }],
      author: "set author",
      message: "set message",
    });

    const applied = await changes.changeSets.approveChangeSet(stash, created.value.id, {});
    expect(applied).toMatchObject({
      status: "applied",
      commit: {
        source: "change-set",
        sourceId: created.value.id,
        author: "set author",
        message: "set message",
        entryCount: 1,
        entries: [{ path: "candidate.txt", op: "put", version: 1 }],
      },
    });
    await expect(changes.changeSets.approveChangeSet(stash, created.value.id, {})).resolves.toEqual(
      applied,
    );
    await expect(counts(stash)).resolves.toEqual({ commits: 1, versions: 1, files: 1 });
  });

  it("atomically applies text, binary, copy, delete, and rollback entries", async () => {
    const stash = "approve-mixed";
    await seedStash(stash);
    const changes = store();
    await seedFile(stash, "copy-source.txt", "copy source");
    await seedFile(stash, "delete.txt", "delete me");
    await seedFile(stash, "rollback.txt", "first");
    await changes.writes.put(stash, "rollback.txt", { body: "second", expectedVersion: 1 });
    const created = await changes.changeSets.createChangeSet(stash, {
      entries: [
        { op: "put", path: "text.txt", baseVersion: null, body: "text" },
        {
          op: "put",
          path: "binary.bin",
          baseVersion: null,
          representation: "binary",
          contentType: "application/octet-stream",
          bytesBase64: "AAEC",
        },
        {
          op: "copy",
          path: "copy.txt",
          baseVersion: null,
          from: { path: "copy-source.txt", version: 1 },
        },
        { op: "delete", path: "delete.txt", baseVersion: 1 },
        { op: "rollback", path: "rollback.txt", baseVersion: 2, toVersion: 1 },
      ],
    });

    const applied = await changes.changeSets.approveChangeSet(stash, created.value.id, {
      author: "override",
      message: "approved",
    });
    expect(applied.commit.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "binary.bin", op: "put", representation: "binary" }),
        expect.objectContaining({
          path: "copy.txt",
          op: "copy",
          copiedFrom: { path: "copy-source.txt", version: 1 },
        }),
        expect.objectContaining({ path: "delete.txt", op: "delete", kind: "delete" }),
        expect.objectContaining({ path: "rollback.txt", op: "rollback", rollbackOf: 1 }),
        expect.objectContaining({ path: "text.txt", op: "put", representation: "text" }),
      ]),
    );
    expect(applied.commit).toMatchObject({
      author: "override",
      message: "approved",
      entryCount: 5,
    });
    const commit = await env.DB.prepare("SELECT sealed, change_count FROM commits WHERE id = ?")
      .bind(applied.commit.id)
      .first();
    expect(commit).toEqual({ sealed: 1, change_count: 5 });
  });

  it("refuses a raced head and leaves the set open without approval rows", async () => {
    const stash = "approve-race";
    await seedStash(stash);
    await seedFile(stash, "raced.txt", "before");
    const base = store();
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [
        { op: "put", path: "new.txt", baseVersion: null, body: "new" },
        { op: "put", path: "raced.txt", baseVersion: 1, body: "loser" },
      ],
    });
    const before = await counts(stash);
    const changes = createChangeSets(workerEnv, {
      ...dependencies(),
      onBeforeCommit: async () => {
        const winner = await base.writes.put(stash, "raced.txt", {
          body: "winner",
          expectedVersion: 1,
        });
        if (!winner.ok) throw new Error("race winner failed");
      },
    });

    await expect(changes.approveChangeSet(stash, created.value.id, {})).rejects.toMatchObject({
      code: "commit-conflict",
      conflicts: [{ path: "raced.txt", current: { version: 2 } }],
    });
    await expect(base.changeSets.getChangeSet(stash, created.value.id)).resolves.toMatchObject({
      status: "open",
    });
    await expect(counts(stash)).resolves.toEqual({
      commits: before.commits + 1,
      versions: before.versions + 1,
      files: before.files,
    });
  });

  it("classifies a competitor tombstone and a never-existing delete without leaking rows", async () => {
    const stash = "approve-delete-races";
    await seedStash(stash);
    await seedFile(stash, "delete.txt", "before");
    const base = store();
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [{ op: "delete", path: "delete.txt", baseVersion: 1 }],
    });
    const changes = createChangeSets(workerEnv, {
      ...dependencies(),
      onBeforeCommit: async () => {
        const winner = await base.writes.delete(stash, "delete.txt", { expectedVersion: 1 });
        if (!winner.ok) throw new Error("delete winner failed");
      },
    });
    await expect(changes.approveChangeSet(stash, created.value.id, {})).rejects.toMatchObject({
      code: "commit-conflict",
      conflicts: [{ path: "delete.txt", current: { version: 2, deleted: true } }],
    });
    await expect(base.changeSets.getChangeSet(stash, created.value.id)).resolves.toMatchObject({
      status: "open",
    });

    const missingId = "chs_0000000030000abcdef12";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO change_sets
          (id, stash_name, status, expires_at, created_by, created_at)
         VALUES (?, ?, 'open', ?, 'test', ?)`,
      ).bind(missingId, stash, 40_000, 30_000),
      env.DB.prepare(
        `INSERT INTO change_set_entries
          (change_set_id, stash_name, path, op, base_version)
         VALUES (?, ?, 'never.txt', 'delete', 1)`,
      ).bind(missingId, stash),
    ]);
    await expect(
      store(30_000).changeSets.approveChangeSet(stash, missingId, {}),
    ).rejects.toMatchObject({
      code: "not-found",
      conflicts: [{ path: "never.txt", current: null }],
    });
    await expect(base.changeSets.getChangeSet(stash, missingId)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("refuses missing prepared content and a raced expected-last-change fence", async () => {
    const stash = "approve-content-fences";
    await seedStash(stash);
    const missingId = "chs_0000000030000fedcba98";
    const missingHash = `sha256-${"f".repeat(64)}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO change_sets
          (id, stash_name, status, expires_at, created_by, created_at)
         VALUES (?, ?, 'open', 40000, 'test', 30000)`,
      ).bind(missingId, stash),
      env.DB.prepare(
        `INSERT INTO change_set_entries
          (change_set_id, stash_name, path, op, base_version, blob_hash, content_storage,
           representation, content_type, size_bytes)
         VALUES (?, ?, 'missing.txt', 'put', NULL, ?, 'legacy', 'text', 'text/plain', 7)`,
      ).bind(missingId, stash, missingHash),
    ]);
    await expect(
      store(30_000).changeSets.approveChangeSet(stash, missingId, {}),
    ).rejects.toMatchObject({
      code: "commit-conflict",
      conflicts: [{ path: "missing.txt", current: null }],
    });
    await expect(counts(stash)).resolves.toEqual({ commits: 0, versions: 0, files: 0 });

    const base = store(31_000);
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "new.txt", baseVersion: null, body: "new" }],
      expectedLastChangeId: 0,
    });
    await seedFile(stash, "competitor.txt", "winner");
    await expect(
      base.changeSets.approveChangeSet(stash, created.value.id, {}),
    ).rejects.toMatchObject({ code: "commit-conflict" });
    await expect(base.changeSets.getChangeSet(stash, created.value.id)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("approves a prefix-scoped set after an unrelated path changes", async () => {
    const stash = "approve-prefix-unrelated";
    await seedStash(stash);
    const changes = store(31_000);
    const siteChangeId = await seedFile(stash, "site/existing.txt", "site");
    const created = await changes.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "site/candidate.txt", baseVersion: null, body: "candidate" }],
      expectedLastChangeId: siteChangeId,
      expectedLastChangePrefix: "site/",
    });

    await seedFile(stash, "docs/unrelated.txt", "docs");

    await expect(
      changes.changeSets.approveChangeSet(stash, created.value.id, {}),
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("atomically refuses a prefix-scoped set when its prefix changes before the claim", async () => {
    const stash = "approve-prefix-race";
    await seedStash(stash);
    const base = store(31_000);
    const siteChangeId = await seedFile(stash, "site/existing.txt", "site");
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "site/candidate.txt", baseVersion: null, body: "candidate" }],
      expectedLastChangeId: siteChangeId,
      expectedLastChangePrefix: "site/",
    });
    const changes = createChangeSets(workerEnv, {
      ...dependencies(32_000),
      onBeforeCommit: async () => {
        const winner = await base.writes.put(stash, "site/competitor.txt", {
          body: "competitor",
          expectedVersion: null,
        });
        if (!winner.ok) throw new Error("prefix race winner failed");
      },
    });

    await expect(changes.approveChangeSet(stash, created.value.id, {})).rejects.toMatchObject({
      code: "commit-conflict",
    });
    await expect(base.changeSets.getChangeSet(stash, created.value.id)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("keeps whole-stash future cursors strict while prefix future cursors pass at approval", async () => {
    const wholeStash = "approve-future-whole";
    await seedStash(wholeStash);
    const wholeStore = store(31_000);
    const whole = await wholeStore.changeSets.createChangeSet(wholeStash, {
      entries: [{ op: "put", path: "candidate.txt", baseVersion: null, body: "candidate" }],
    });
    await env.DB.prepare(
      "UPDATE change_sets SET expected_last_change_id = 100 WHERE stash_name = ? AND id = ?",
    )
      .bind(wholeStash, whole.value.id)
      .run();
    await expect(
      wholeStore.changeSets.approveChangeSet(wholeStash, whole.value.id, {}),
    ).rejects.toMatchObject({ code: "commit-conflict" });

    const prefixStash = "approve-future-prefix";
    await seedStash(prefixStash);
    const prefixStore = store(31_000);
    const prefix = await prefixStore.changeSets.createChangeSet(prefixStash, {
      entries: [{ op: "put", path: "site/candidate.txt", baseVersion: null, body: "candidate" }],
      expectedLastChangeId: 100,
      expectedLastChangePrefix: "site/",
    });
    await expect(
      prefixStore.changeSets.approveChangeSet(prefixStash, prefix.value.id, {}),
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("fences two approvers so the loser returns the winner's stored result", async () => {
    const stash = "approve-twice";
    await seedStash(stash);
    const base = store();
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "only.txt", baseVersion: null, body: "only" }],
    });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changes = createChangeSets(workerEnv, {
      ...dependencies(),
      onBeforeCommit: async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    let appliedCallbacks = 0;
    const [first, second] = await Promise.all([
      changes.approveChangeSet(
        stash,
        created.value.id,
        {},
        {
          onApplied: () => {
            appliedCallbacks += 1;
          },
        },
      ),
      changes.approveChangeSet(
        stash,
        created.value.id,
        {},
        {
          onApplied: () => {
            appliedCallbacks += 1;
          },
        },
      ),
    ]);
    expect(second).toEqual(first);
    expect(appliedCallbacks).toBe(1);
    await expect(counts(stash)).resolves.toEqual({ commits: 1, versions: 1, files: 1 });
  });

  it("lets rejection win while an approval is paused before its claim", async () => {
    const stash = "approve-reject";
    await seedStash(stash);
    const base = store();
    const created = await base.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "only.txt", baseVersion: null, body: "only" }],
    });
    let entered!: () => void;
    let release!: () => void;
    const atHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changes = createChangeSets(workerEnv, {
      ...dependencies(),
      onBeforeCommit: async () => {
        entered();
        await barrier;
      },
    });
    const approval = changes.approveChangeSet(stash, created.value.id, {});
    await atHook;
    await base.changeSets.rejectChangeSet(stash, created.value.id, { reason: "race winner" });
    release();
    await expect(approval).rejects.toMatchObject({ code: "change-set-closed" });
    await expect(counts(stash)).resolves.toEqual({ commits: 0, versions: 0, files: 0 });
  });

  it("rejects an expired open set and records the decision", async () => {
    const stash = "reject-expired";
    await seedStash(stash);
    const create = store(20_000);
    const created = await create.changeSets.createChangeSet(stash, {
      entries: [{ op: "put", path: "later.txt", baseVersion: null, body: "later" }],
      expiresAt: new Date(20_001).toISOString(),
    });
    const decide = store(20_001);
    await expect(
      decide.changeSets.approveChangeSet(stash, created.value.id, {}),
    ).rejects.toMatchObject({ code: "change-set-expired" });
    await expect(
      decide.changeSets.rejectChangeSet(
        stash,
        created.value.id,
        { reason: "superseded" },
        { decidedBy: "reviewer" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      decisionReason: "superseded",
      decidedBy: "reviewer",
    });
  });
});
