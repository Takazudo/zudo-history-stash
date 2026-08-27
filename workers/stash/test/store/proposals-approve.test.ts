import { env } from "cloudflare:workers";
import { R2_SPILL_BYTES, StashError } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createProposals, type ProposalDependencies } from "../../src/d1/proposals.js";
import { createWrites } from "../../src/d1/writes.js";
import type { Env } from "../../src/env.js";
import { resetDatabase, seedStash } from "../helpers/app.js";
import { generation, generationFactory } from "../helpers/blob-generations.js";
import { wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const STASH = "proposal-decisions";
const NOW = 1_810_000_000_000;

function idFactory(): () => string {
  let sequence = 0;
  return () => `decision-${(sequence += 1)}`;
}

function proposalIdFactory(): () => string {
  let sequence = 0;
  return () => (sequence += 1).toString(16).padStart(8, "0");
}

function dependencies(
  now: () => number,
  onBeforeCommit?: () => void | Promise<void>,
): ProposalDependencies {
  return {
    now,
    createId: idFactory(),
    createBlobGeneration: generationFactory(generation(901), generation(902), generation(903)),
    ...(onBeforeCommit === undefined ? {} : { onBeforeCommit }),
  };
}

function createDependencies(now: () => number): ProposalDependencies {
  return {
    ...dependencies(now),
    createId: proposalIdFactory(),
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(StashError);
    expect((error as StashError).code).toBe(code);
    return error as StashError;
  }
}

async function counts(path: string) {
  const [proposal, blob, versions, file] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM proposals WHERE stash_name = ? AND path = ?")
      .bind(STASH, path)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM blobs b
       WHERE b.stash_name = ? AND EXISTS (
         SELECT 1 FROM proposals p WHERE p.stash_name = b.stash_name
           AND p.path = ? AND p.blob_hash = b.hash)`,
    )
      .bind(STASH, path)
      .first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM versions WHERE stash_name = ? AND path = ?")
      .bind(STASH, path)
      .first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM files WHERE stash_name = ? AND path = ?")
      .bind(STASH, path)
      .first<{ count: number }>(),
  ]);
  return {
    proposals: proposal?.count ?? -1,
    blobs: blob?.count ?? -1,
    versions: versions?.count ?? -1,
    files: file?.count ?? -1,
  };
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await bothArrived;
  };
}

beforeEach(resetDatabase);

describe("proposal approval and rejection", () => {
  it("applies a null-base proposal as an ordinary audited version and reapproves exactly", async () => {
    let clock = NOW;
    await seedStash(STASH);
    const bindings = env as Env;
    const creator = createProposals(
      bindings,
      createDependencies(() => clock),
    );
    const created = await creator.createProposal(STASH, {
      path: "new.md",
      body: "candidate\n",
      baseVersion: null,
      author: "proposal-author",
      message: "proposal-message",
      meta: { source: "proposal" },
      expiresAt: new Date(NOW + 1_000).toISOString(),
    });
    const proposals = createProposals(
      bindings,
      dependencies(
        () => clock,
        () => {
          clock = NOW + 100;
        },
      ),
    );

    const approved = await proposals.approveProposal(
      STASH,
      created.value.id,
      { author: "approver", message: "ship it" },
      "admin",
    );
    expect(approved).toMatchObject({
      status: "applied",
      appliedVersion: 1,
      hash: created.value.hash,
      createdAt: new Date(NOW + 100).toISOString(),
    });
    const version = await env.DB.prepare(
      `SELECT id, kind, blob_hash, author, message, meta_json, created_at
       FROM versions WHERE stash_name = ? AND path = ? AND version = 1`,
    )
      .bind(STASH, "new.md")
      .first<{
        id: number;
        kind: string;
        blob_hash: string;
        author: string;
        message: string;
        meta_json: string;
        created_at: number;
      }>();
    expect(version).toMatchObject({
      id: approved?.appliedChangeId,
      kind: "put",
      blob_hash: created.value.hash,
      author: "approver",
      message: "ship it",
      created_at: NOW + 100,
    });
    expect(JSON.parse(version?.meta_json ?? "{}")).toEqual({
      proposalId: created.value.id,
      source: "proposal",
    });
    await expect(proposals.getProposal(STASH, created.value.id)).resolves.toMatchObject({
      status: "applied",
      decidedBy: "admin",
      appliedVersion: 1,
      appliedChangeId: approved?.appliedChangeId,
    });

    clock = NOW + 1_000;
    const replay = await proposals.approveProposal(
      STASH,
      created.value.id,
      { author: "ignored", message: "ignored" },
      "tok_ignored",
    );
    expect(replay).toEqual(approved);
    expect(await counts("new.md")).toEqual({ proposals: 1, blobs: 1, versions: 1, files: 1 });
  });

  it("recovers a missing applied change-id backfill from the stored version", async () => {
    await seedStash(STASH);
    const proposals = createProposals(
      env as Env,
      createDependencies(() => NOW),
    );
    const created = await proposals.createProposal(STASH, {
      path: "recover.md",
      body: "candidate",
      baseVersion: null,
    });
    const approved = await proposals.approveProposal(STASH, created.value.id, {}, "admin");
    await env.DB.prepare("UPDATE proposals SET applied_change_id = NULL WHERE id = ?")
      .bind(created.value.id)
      .run();

    await expect(proposals.approveProposal(STASH, created.value.id, {}, "admin")).resolves.toEqual(
      approved,
    );
    await expect(
      env.DB.prepare("SELECT applied_change_id FROM proposals WHERE id = ?")
        .bind(created.value.id)
        .first<{ applied_change_id: number }>(),
    ).resolves.toEqual({ applied_change_id: approved?.appliedChangeId });
  });

  it("appends same-body content and resurrects an exact tombstone base", async () => {
    await seedStash(STASH);
    const bindings = env as Env;
    const deps = createDependencies(() => NOW);
    const proposals = createProposals(bindings, deps);
    const writes = createWrites(bindings, deps);

    await writes.put(STASH, "same.md", { body: "same", expectedVersion: null });
    const same = await proposals.createProposal(STASH, {
      path: "same.md",
      body: "same",
      baseVersion: 1,
      author: "fallback-author",
      message: "fallback-message",
    });
    await expect(
      proposals.approveProposal(STASH, same.value.id, { author: "", message: "" }, "admin"),
    ).resolves.toMatchObject({ appliedVersion: 2 });
    expect((await counts("same.md")).versions).toBe(2);
    await expect(
      env.DB.prepare(
        "SELECT author, message FROM versions WHERE stash_name = ? AND path = ? AND version = 2",
      )
        .bind(STASH, "same.md")
        .first(),
    ).resolves.toEqual({ author: "", message: "" });

    await writes.put(STASH, "deleted.md", { body: "old", expectedVersion: null });
    await writes.delete(STASH, "deleted.md", { expectedVersion: 1 });
    const replacement = await proposals.createProposal(STASH, {
      path: "deleted.md",
      body: "replacement",
      baseVersion: 2,
      author: "fallback-author",
      message: "fallback-message",
    });
    await expect(
      proposals.approveProposal(STASH, replacement.value.id, {}, "tok_writer"),
    ).resolves.toMatchObject({ status: "applied", appliedVersion: 3 });
    await expect(
      env.DB.prepare("SELECT head_version, deleted FROM files WHERE stash_name = ? AND path = ?")
        .bind(STASH, "deleted.md")
        .first(),
    ).resolves.toMatchObject({ head_version: 3, deleted: 0 });
    await expect(proposals.getProposal(STASH, replacement.value.id)).resolves.toMatchObject({
      decidedBy: "tok_writer",
    });
    await expect(
      env.DB.prepare(
        "SELECT author, message FROM versions WHERE stash_name = ? AND path = ? AND version = 3",
      )
        .bind(STASH, "deleted.md")
        .first(),
    ).resolves.toEqual({ author: "fallback-author", message: "fallback-message" });
  });

  it("keeps null-base and moved-head refusals open without leaked rows", async () => {
    await seedStash(STASH);
    const bindings = env as Env;
    const deps = createDependencies(() => NOW);
    const proposals = createProposals(bindings, deps);
    const writes = createWrites(bindings, deps);

    for (const [path, tombstone] of [
      ["live-null.md", false],
      ["tombstone-null.md", true],
    ] as const) {
      const candidate = await proposals.createProposal(STASH, {
        path,
        body: "candidate",
        baseVersion: null,
      });
      await writes.put(STASH, path, { body: "winner", expectedVersion: null });
      if (tombstone) await writes.delete(STASH, path, { expectedVersion: 1 });
      const before = await counts(path);
      const error = await expectCode(
        proposals.approveProposal(STASH, candidate.value.id, {}, "admin"),
        "stale",
      );
      expect(error.current).toMatchObject({ version: tombstone ? 2 : 1, deleted: tombstone });
      expect(await counts(path)).toEqual(before);
      await expect(proposals.getProposal(STASH, candidate.value.id)).resolves.toMatchObject({
        status: "open",
        body: "candidate",
      });
    }

    await writes.put(STASH, "deleted-after-base.md", { body: "base", expectedVersion: null });
    const candidate = await proposals.createProposal(STASH, {
      path: "deleted-after-base.md",
      body: "candidate",
      baseVersion: 1,
    });
    await writes.delete(STASH, "deleted-after-base.md", { expectedVersion: 1 });
    const before = await counts("deleted-after-base.md");
    const error = await expectCode(
      proposals.approveProposal(STASH, candidate.value.id, {}, "admin"),
      "stale",
    );
    expect(error.current).toMatchObject({ version: 2, deleted: true, kind: "delete" });
    expect(await counts("deleted-after-base.md")).toEqual(before);

    const missingBase = await proposals.createProposal(STASH, {
      path: "missing-base.md",
      body: "candidate",
      baseVersion: 1,
    });
    const missingError = await expectCode(
      proposals.approveProposal(STASH, missingBase.value.id, {}, "admin"),
      "stale",
    );
    expect(missingError.current).toBeUndefined();
    expect(await counts("missing-base.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 0,
      files: 0,
    });
  });

  it("enforces expiry equality for approval but permits idempotent rejection", async () => {
    let clock = NOW;
    await seedStash(STASH);
    const proposals = createProposals(
      env as Env,
      createDependencies(() => clock),
    );
    const created = await proposals.createProposal(STASH, {
      path: "expired.md",
      body: "candidate",
      baseVersion: null,
      expiresAt: new Date(NOW + 1).toISOString(),
    });
    clock = NOW + 1;
    const before = await counts("expired.md");
    await expectCode(
      proposals.approveProposal(STASH, created.value.id, {}, "admin"),
      "proposal-expired",
    );
    expect(await counts("expired.md")).toEqual(before);

    const rejected = await proposals.rejectProposal(
      STASH,
      created.value.id,
      { reason: "expired candidate" },
      "tok_writer",
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      decidedBy: "tok_writer",
      decisionReason: "expired candidate",
    });
    clock += 1;
    await expect(
      proposals.rejectProposal(STASH, created.value.id, { reason: "ignored" }, "admin"),
    ).resolves.toEqual(rejected);
    await expectCode(
      proposals.approveProposal(STASH, created.value.id, {}, "admin"),
      "proposal-closed",
    );

    const afterBoundary = await proposals.createProposal(STASH, {
      path: "after-expiry.md",
      body: "candidate",
      baseVersion: null,
      expiresAt: new Date(clock + 1).toISOString(),
    });
    clock += 2;
    await expectCode(
      proposals.approveProposal(STASH, afterBoundary.value.id, {}, "admin"),
      "proposal-expired",
    );
    expect(await counts("after-expiry.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 0,
      files: 0,
    });
  });

  it("allows exactly one double-approval append and returns the same winner twice", async () => {
    await seedStash(STASH);
    const creator = createProposals(
      env as Env,
      createDependencies(() => NOW),
    );
    const created = await creator.createProposal(STASH, {
      path: "double.md",
      body: "candidate",
      baseVersion: null,
    });
    const proposals = createProposals(
      env as Env,
      dependencies(() => NOW, twoPartyBarrier()),
    );
    const results = await Promise.all([
      proposals.approveProposal(STASH, created.value.id, { author: "first" }, "tok_a"),
      proposals.approveProposal(STASH, created.value.id, { author: "second" }, "tok_b"),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "applied", appliedVersion: 1 });
    expect(await counts("double.md")).toEqual({ proposals: 1, blobs: 1, versions: 1, files: 1 });
    const row = await proposals.getProposal(STASH, created.value.id);
    expect(["tok_a", "tok_b"]).toContain(row?.decidedBy);
  });

  it("fences approve against direct puts in both controlled orderings", async () => {
    await seedStash(STASH);
    const bindings = env as Env;
    const baseDeps = createDependencies(() => NOW);
    const creator = createProposals(bindings, baseDeps);
    const baseWrites = createWrites(bindings, baseDeps);

    await baseWrites.put(STASH, "put-first.md", { body: "base", expectedVersion: null });
    const putFirst = await creator.createProposal(STASH, {
      path: "put-first.md",
      body: "candidate",
      baseVersion: 1,
    });
    const winnerWrites = createWrites(bindings, baseDeps);
    const approveAfterPut = createProposals(
      bindings,
      dependencies(
        () => NOW,
        async () => {
          await winnerWrites.put(STASH, "put-first.md", { body: "winner", expectedVersion: 1 });
        },
      ),
    );
    await expectCode(
      approveAfterPut.approveProposal(STASH, putFirst.value.id, {}, "admin"),
      "stale",
    );
    expect(await counts("put-first.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 2,
      files: 1,
    });

    await baseWrites.put(STASH, "approve-first.md", { body: "base", expectedVersion: null });
    const approveFirst = await creator.createProposal(STASH, {
      path: "approve-first.md",
      body: "candidate",
      baseVersion: 1,
    });
    const approving = createProposals(
      bindings,
      dependencies(() => NOW),
    );
    const losingWrite = createWrites(bindings, {
      ...baseDeps,
      onBeforeCommit: async () => {
        await approving.approveProposal(STASH, approveFirst.value.id, {}, "admin");
      },
    });
    const loser = await losingWrite.put(STASH, "approve-first.md", {
      body: "loser",
      expectedVersion: 1,
    });
    expect(loser).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(await counts("approve-first.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 2,
      files: 1,
    });
    await expect(
      env.DB.prepare("SELECT 1 FROM blobs WHERE stash_name = ? AND body = ?")
        .bind(STASH, "loser")
        .first(),
    ).resolves.toBeNull();
  });

  it("fences approve and reject in both controlled orderings", async () => {
    await seedStash(STASH);
    const bindings = env as Env;
    const creator = createProposals(
      bindings,
      createDependencies(() => NOW),
    );

    const rejectedFirst = await creator.createProposal(STASH, {
      path: "reject-first.md",
      body: "candidate",
      baseVersion: null,
    });
    const rejecting = createProposals(
      bindings,
      dependencies(() => NOW),
    );
    const approveLoser = createProposals(
      bindings,
      dependencies(
        () => NOW,
        async () => {
          await rejecting.rejectProposal(STASH, rejectedFirst.value.id, { reason: "no" }, "tok_r");
        },
      ),
    );
    await expectCode(
      approveLoser.approveProposal(STASH, rejectedFirst.value.id, {}, "tok_a"),
      "proposal-closed",
    );
    expect(await counts("reject-first.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 0,
      files: 0,
    });
    await expect(creator.getProposal(STASH, rejectedFirst.value.id)).resolves.toMatchObject({
      status: "rejected",
      decidedBy: "tok_r",
      decisionReason: "no",
    });

    const approvedFirst = await creator.createProposal(STASH, {
      path: "approve-first-decision.md",
      body: "candidate",
      baseVersion: null,
    });
    const approving = createProposals(
      bindings,
      dependencies(() => NOW),
    );
    const rejectLoser = createProposals(
      bindings,
      dependencies(
        () => NOW,
        async () => {
          await approving.approveProposal(STASH, approvedFirst.value.id, {}, "tok_a");
        },
      ),
    );
    await expectCode(
      rejectLoser.rejectProposal(STASH, approvedFirst.value.id, { reason: "too late" }, "tok_r"),
      "proposal-closed",
    );
    expect(await counts("approve-first-decision.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 1,
      files: 1,
    });
  });

  it("reuses a spilled candidate blob without any approval R2 write", async () => {
    await seedStash(STASH);
    const createCalls: BlobCallCounts = { get: 0, put: 0 };
    const creator = createProposals(
      wrapBlobs(env as Env, { count: createCalls }),
      createDependencies(() => NOW),
    );
    const created = await creator.createProposal(STASH, {
      path: "spilled.md",
      body: "x".repeat(R2_SPILL_BYTES + 1),
      baseVersion: null,
    });
    expect(createCalls.put).toBe(1);

    const approveCalls: BlobCallCounts = { get: 0, put: 0 };
    const proposals = createProposals(
      wrapBlobs(env as Env, { count: approveCalls, failPut: true }),
      dependencies(() => NOW),
    );
    await expect(
      proposals.approveProposal(STASH, created.value.id, {}, "admin"),
    ).resolves.toMatchObject({ status: "applied", hash: created.value.hash });
    expect(approveCalls).toEqual({ get: 0, put: 0 });
    expect((await counts("spilled.md")).blobs).toBe(1);
  });

  it("conceals unknown/deleted proposals and leaks no transition when deletion wins", async () => {
    await seedStash(STASH);
    const creator = createProposals(
      env as Env,
      createDependencies(() => NOW),
    );
    const missing = "prp_1810000000000deadbeef";
    await expect(creator.approveProposal(STASH, missing, {}, "admin")).resolves.toBeNull();
    await expect(creator.rejectProposal(STASH, missing, {}, "admin")).resolves.toBeNull();

    const created = await creator.createProposal(STASH, {
      path: "deleted-stash.md",
      body: "candidate",
      baseVersion: null,
    });
    const deleting = createProposals(
      env as Env,
      dependencies(
        () => NOW,
        async () => {
          await env.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?")
            .bind(NOW, STASH)
            .run();
        },
      ),
    );
    await expectCode(deleting.approveProposal(STASH, created.value.id, {}, "admin"), "not-found");
    expect((await counts("deleted-stash.md")).versions).toBe(0);
    const stored = await env.DB.prepare("SELECT status FROM proposals WHERE id = ?")
      .bind(created.value.id)
      .first<{ status: string }>();
    expect(stored).toEqual({ status: "open" });
    expect(await counts("deleted-stash.md")).toEqual({
      proposals: 1,
      blobs: 1,
      versions: 0,
      files: 0,
    });
    await expectCode(creator.rejectProposal(STASH, created.value.id, {}, "admin"), "not-found");
  });
});
