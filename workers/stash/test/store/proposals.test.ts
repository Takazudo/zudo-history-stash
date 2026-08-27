import { env } from "cloudflare:workers";
import {
  DIFF_MAX_BYTES,
  MAX_BODY_BYTES,
  MAX_META_BYTES,
  R2_SPILL_BYTES,
  StashError,
  canonicalJson,
  utf8ByteLength,
} from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { blobKey } from "../../src/d1/blobs.js";
import { createProposals, type ProposalDependencies } from "../../src/d1/proposals.js";
import { createStashStore } from "../../src/d1/store.js";
import { createWrites } from "../../src/d1/writes.js";
import type { Env } from "../../src/env.js";
import { resetDatabase, seedStash } from "../helpers/app.js";
import { generation, generationFactory } from "../helpers/blob-generations.js";
import { wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const STASH = "proposal-store";

function idFactory(): () => string {
  let sequence = 0;
  return () => (sequence += 1).toString(16).padStart(8, "0");
}

function deps(overrides: Partial<ProposalDependencies> = {}): ProposalDependencies {
  return {
    now: () => NOW,
    createId: idFactory(),
    createBlobGeneration: generationFactory(
      generation(101),
      generation(102),
      generation(103),
      generation(104),
      generation(105),
      generation(106),
    ),
    ...overrides,
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(StashError);
  expect((error as StashError).code).toBe(code);
}

async function expectRejectedCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expectCode(error, code);
  }
}

async function rowCount(table: "proposals" | "blobs", stash = STASH): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
    .bind(stash)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function setup(overrides: Partial<ProposalDependencies> = {}) {
  await seedStash(STASH);
  const proposalDeps = deps(overrides);
  const bindings = env as Env;
  return {
    bindings,
    proposalDeps,
    proposals: createProposals(bindings, proposalDeps),
    writes: createWrites(bindings, proposalDeps),
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

describe("proposal store", () => {
  it("creates and gets an exact spilled candidate with default and explicit expiry", async () => {
    await seedStash(STASH);
    const proposalDeps = deps();
    const proposals = createStashStore(env as Env, proposalDeps).proposals;
    const body = "候".repeat(R2_SPILL_BYTES + 1);
    const created = await proposals.createProposal(STASH, {
      path: "docs/candidate.md",
      body,
      baseVersion: null,
      author: "bot",
      message: "review this",
      meta: { source: "test" },
    });

    expect(created).toMatchObject({
      value: {
        id: "prp_180000000000000000001",
        stash: STASH,
        path: "docs/candidate.md",
        baseVersion: null,
        author: "bot",
        message: "review this",
        meta: { proposalId: "prp_180000000000000000001", source: "test" },
        size: utf8ByteLength(body),
        status: "open",
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 14 * DAY_MS).toISOString(),
      },
    });
    expect(created.value.hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    await expect(proposals.getProposal(STASH, created.value.id)).resolves.toEqual({
      ...created.value,
      body,
    });

    const stored = await env.DB.prepare(
      `SELECT p.blob_hash, p.meta_json, b.body, b.r2_key, b.size_bytes
       FROM proposals p JOIN blobs b ON b.stash_name = p.stash_name AND b.hash = p.blob_hash
       WHERE p.id = ?`,
    )
      .bind(created.value.id)
      .first<{
        blob_hash: string;
        meta_json: string;
        body: string | null;
        r2_key: string | null;
        size_bytes: number;
      }>();
    expect(stored).toMatchObject({ body: null, size_bytes: utf8ByteLength(body) });
    expect(stored?.r2_key).toMatch(new RegExp(`^v2/${STASH}/${created.value.hash}/`));
    await expect(env.BLOBS.head(stored?.r2_key ?? "")).resolves.toMatchObject({
      key: stored?.r2_key,
      size: utf8ByteLength(body),
    });

    const explicit = new Date(NOW + DAY_MS).toISOString();
    const second = await proposals.createProposal(STASH, {
      path: "docs/explicit.md",
      body: "explicit",
      baseVersion: null,
      expiresAt: explicit,
    });
    expect(second.value.expiresAt).toBe(explicit);

    const precise = explicit.replace(".000Z", ".0000Z");
    const third = await proposals.createProposal(STASH, {
      path: "docs/precise.md",
      body: "precise",
      baseVersion: null,
      expiresAt: precise,
    });
    expect(third.value.expiresAt).toBe(explicit);
  });

  it("rejects caller-owned proposalId and meta that only exceeds the limit after stamping", async () => {
    const { proposals } = await setup();
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "owned.md",
        body: "candidate",
        baseVersion: null,
        meta: { proposalId: "caller" },
      }),
      "validation",
    );

    const emptyBytes = utf8ByteLength(canonicalJson({ padding: "" }));
    const exactInputMeta = { padding: "x".repeat(MAX_META_BYTES - emptyBytes) };
    expect(utf8ByteLength(canonicalJson(exactInputMeta))).toBe(MAX_META_BYTES);
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "stamped-too-large.md",
        body: "candidate",
        baseVersion: null,
        meta: exactInputMeta,
      }),
      "validation",
    );
    expect(await rowCount("proposals")).toBe(0);
    expect(await rowCount("blobs")).toBe(0);
  });

  it("validates body and timestamp boundaries before persistence", async () => {
    const { proposals } = await setup();
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "malformed.md",
        body: "\uD800",
        baseVersion: null,
      }),
      "body-not-well-formed",
    );
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "oversized.md",
        body: "x".repeat(MAX_BODY_BYTES + 1),
        baseVersion: null,
      }),
      "payload-too-large",
    );
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "invalid-calendar.md",
        body: "candidate",
        baseVersion: null,
        expiresAt: "2027-02-29T00:00:00.000Z",
      }),
      "validation",
    );
    expect(await rowCount("proposals")).toBe(0);
    expect(await rowCount("blobs")).toBe(0);
  });

  it("replays a real same-key create and rejects a different canonical request", async () => {
    await seedStash(STASH);
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const proposalDeps = deps();
    const bindings = wrapBlobs(env as Env, { count: calls });
    const proposals = createProposals(bindings, proposalDeps);
    const input = {
      path: "retry.md",
      body: "r".repeat(R2_SPILL_BYTES + 1),
      baseVersion: null,
    } as const;
    const first = await proposals.createProposal(STASH, input, { idempotencyKey: "retry-key" });
    const replay = await proposals.createProposal(STASH, input, { idempotencyKey: "retry-key" });

    expect(replay).toEqual({ value: first.value, replayed: true });
    expect(calls.put).toBe(1);
    await expectRejectedCode(
      proposals.createProposal(
        STASH,
        { ...input, body: "different" },
        { idempotencyKey: "retry-key" },
      ),
      "idempotency-key-reused",
    );
    expect(await rowCount("proposals")).toBe(1);
    expect(await rowCount("blobs")).toBe(1);
  });

  it("replays the same key at exact expiry without another R2 write", async () => {
    await seedStash(STASH);
    let clock = NOW;
    let idCalls = 0;
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(env as Env, { count: calls });
    const proposals = createProposals(bindings, {
      ...deps(),
      now: () => clock,
      createId: () => {
        idCalls += 1;
        return idCalls.toString(16).padStart(8, "0");
      },
    });
    const input = {
      path: "expired-replay.md",
      body: "e".repeat(R2_SPILL_BYTES + 1),
      baseVersion: null,
    } as const;
    const first = await proposals.createProposal(STASH, input, {
      idempotencyKey: "expired-replay-key",
    });
    expect(first.value.status).toBe("open");
    expect(calls.put).toBe(1);
    expect(idCalls).toBe(1);

    clock = Date.parse(first.value.expiresAt);
    bindings.PROPOSAL_TTL_DAYS = "invalid-after-create";
    const replay = await proposals.createProposal(STASH, input, {
      idempotencyKey: "expired-replay-key",
    });
    expect(replay).toMatchObject({
      replayed: true,
      value: { id: first.value.id, status: "expired", expiresAt: first.value.expiresAt },
    });
    expect(calls.put).toBe(1);
    expect(idCalls).toBe(1);
    expect(await rowCount("proposals")).toBe(1);
    expect(await rowCount("blobs")).toBe(1);
  });

  it("lets one concurrent same-key batch win and reconstructs one replay", async () => {
    const barrier = twoPartyBarrier();
    const { bindings, proposalDeps } = await setup({ onBeforeCommit: barrier });
    const proposals = createProposals(bindings, proposalDeps);
    const input = { path: "parallel.md", body: "candidate", baseVersion: null } as const;
    const results = await Promise.all([
      proposals.createProposal(STASH, input, { idempotencyKey: "parallel-key" }),
      proposals.createProposal(STASH, input, { idempotencyKey: "parallel-key" }),
    ]);

    expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
    expect(results[0]?.value).toEqual(results[1]?.value);
    expect(await rowCount("proposals")).toBe(1);
    expect(await rowCount("blobs")).toBe(1);
  });

  it("returns one winner and one key-reused loser for concurrent different bodies", async () => {
    const barrier = twoPartyBarrier();
    const { bindings, proposalDeps } = await setup({ onBeforeCommit: barrier });
    const proposals = createProposals(bindings, proposalDeps);
    const results = await Promise.allSettled([
      proposals.createProposal(
        STASH,
        { path: "parallel-different.md", body: "candidate-a", baseVersion: null },
        { idempotencyKey: "parallel-different-key" },
      ),
      proposals.createProposal(
        STASH,
        { path: "parallel-different.md", body: "candidate-b", baseVersion: null },
        { idempotencyKey: "parallel-different-key" },
      ),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof proposals.createProposal>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectCode(rejected[0]?.reason, "idempotency-key-reused");
    expect(await rowCount("proposals")).toBe(1);
    expect(await rowCount("blobs")).toBe(1);
    const winner = fulfilled[0]?.value.value;
    if (winner === undefined) throw new Error("Expected one concurrent proposal winner");
    await expect(proposals.getProposal(STASH, winner.id)).resolves.toMatchObject({
      body: expect.stringMatching(/^candidate-[ab]$/),
    });
  });

  it("converges spilled same-body races while retaining only the winning generation reference", async () => {
    await seedStash(STASH);
    const generations = [generation(201), generation(202)] as const;
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(env as Env, { count: calls });
    const proposals = createProposals(bindings, {
      now: () => NOW,
      createId: idFactory(),
      createBlobGeneration: generationFactory(...generations),
      onBeforeCommit: twoPartyBarrier(),
    });
    const body = "s".repeat(R2_SPILL_BYTES + 1);
    const input = { path: "parallel-spilled.md", body, baseVersion: null } as const;
    const results = await Promise.all([
      proposals.createProposal(STASH, input, { idempotencyKey: "parallel-spilled-key" }),
      proposals.createProposal(STASH, input, { idempotencyKey: "parallel-spilled-key" }),
    ]);

    expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
    expect(results[0]?.value).toEqual(results[1]?.value);
    expect(calls.put).toBe(2);
    expect(await rowCount("proposals")).toBe(1);
    expect(await rowCount("blobs")).toBe(1);

    const winner = results[0]?.value;
    if (winner === undefined) throw new Error("Expected converged proposal results");
    const stored = await env.DB.prepare(
      "SELECT r2_key FROM blobs WHERE stash_name = ? AND hash = ?",
    )
      .bind(STASH, winner.hash)
      .first<{ r2_key: string }>();
    const generationKeys = generations.map((value) => blobKey(STASH, winner.hash, value));
    expect(generationKeys).toContain(stored?.r2_key);
    const committed = await env.BLOBS.get(stored?.r2_key ?? "");
    if (committed === null) throw new Error("Expected the winning R2 generation");
    await expect(committed.text()).resolves.toBe(body);

    const listed = await env.BLOBS.list({ prefix: `v2/${STASH}/${winner.hash}/` });
    expect(listed.objects.map(({ key }) => key).sort()).toEqual([...generationKeys].sort());
    expect(listed.objects.filter(({ key }) => key !== stored?.r2_key)).toHaveLength(1);
  });

  it("keeps both create statements fenced when the stash is deleted before commit", async () => {
    const { bindings } = await setup();
    const proposals = createProposals(bindings, {
      ...deps(),
      onBeforeCommit: async () => {
        await env.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?")
          .bind(NOW, STASH)
          .run();
      },
    });
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "lost-race.md",
        body: "candidate",
        baseVersion: null,
      }),
      "not-found",
    );
    expect(await rowCount("proposals")).toBe(0);
    expect(await rowCount("blobs")).toBe(0);
  });

  it("paginates identical timestamps by descending id without gaps and preserves filtered total", async () => {
    const { proposals } = await setup();
    for (const path of ["one.md", "two.md", "three.md"]) {
      await proposals.createProposal(STASH, { path, body: path, baseVersion: null });
    }

    const first = await proposals.listProposals(STASH, { status: "all", limit: 2 });
    expect(first.proposals.map(({ id }) => id)).toEqual([
      "prp_180000000000000000003",
      "prp_180000000000000000002",
    ]);
    expect(first).toMatchObject({ total: 3, nextAfter: expect.any(String) });
    const second = await proposals.listProposals(STASH, {
      status: "all",
      limit: 2,
      after: first.nextAfter ?? undefined,
    });
    expect(second.proposals.map(({ id }) => id)).toEqual(["prp_180000000000000000001"]);
    expect(second).toMatchObject({ total: 3, nextAfter: null });
    await expectRejectedCode(
      proposals.listProposals(STASH, { status: "all", after: "not-a-cursor" }),
      "validation",
    );
  });

  it("computes strict expiry and applies every status and path filter to total", async () => {
    let clock = NOW;
    const { bindings } = await setup();
    const proposals = createProposals(bindings, { ...deps(), now: () => clock });
    const open = await proposals.createProposal(STASH, {
      path: "shared.md",
      body: "open",
      baseVersion: null,
    });
    const expires = await proposals.createProposal(STASH, {
      path: "shared.md",
      body: "expires",
      baseVersion: null,
      expiresAt: new Date(NOW + 1).toISOString(),
    });
    const applied = await proposals.createProposal(STASH, {
      path: "applied.md",
      body: "applied",
      baseVersion: null,
    });
    const rejected = await proposals.createProposal(STASH, {
      path: "rejected.md",
      body: "rejected",
      baseVersion: null,
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE proposals SET status = 'applied' WHERE id = ?").bind(applied.value.id),
      env.DB.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").bind(
        rejected.value.id,
      ),
    ]);
    clock = NOW + 1;

    await expect(proposals.listProposals(STASH)).resolves.toMatchObject({
      proposals: [{ id: open.value.id, status: "open" }],
      total: 1,
    });
    await expect(proposals.listProposals(STASH, { status: "expired" })).resolves.toMatchObject({
      proposals: [{ id: expires.value.id, status: "expired" }],
      total: 1,
    });
    await expect(proposals.listProposals(STASH, { status: "applied" })).resolves.toMatchObject({
      proposals: [{ id: applied.value.id, status: "applied" }],
      total: 1,
    });
    await expect(proposals.listProposals(STASH, { status: "rejected" })).resolves.toMatchObject({
      proposals: [{ id: rejected.value.id, status: "rejected" }],
      total: 1,
    });
    const all = await proposals.listProposals(STASH, { status: "all" });
    expect(all.total).toBe(4);
    expect(all.proposals.find(({ id }) => id === expires.value.id)?.status).toBe("expired");
    await expect(
      proposals.listProposals(STASH, { status: "all", path: "shared.md" }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it("keeps base-to-candidate diff immutable while current and stale follow a competing put", async () => {
    const { proposals, writes } = await setup();
    await writes.put(STASH, "moving.md", { body: "base\n", expectedVersion: null });
    const proposal = await proposals.createProposal(STASH, {
      path: "moving.md",
      body: "candidate\n",
      baseVersion: 1,
    });
    const before = await proposals.getProposalDiff(STASH, proposal.value.id, { context: 1 });
    expect(before).toMatchObject({
      state: "ready",
      base: { version: 1, deleted: false },
      candidate: { hash: proposal.value.hash, size: proposal.value.size },
      current: { version: 1 },
      stale: false,
    });

    await writes.put(STASH, "moving.md", { body: "competitor\n", expectedVersion: 1 });
    const after = await proposals.getProposalDiff(STASH, proposal.value.id, { context: 1 });
    expect(after).toMatchObject({ current: { version: 2 }, stale: true });
    expect(after && { ...after, current: null, stale: false }).toEqual(
      before && { ...before, current: null, stale: false },
    );
  });

  it("diffs null and tombstone bases and short-circuits an oversized candidate", async () => {
    const { proposals, writes } = await setup();
    const fromEmpty = await proposals.createProposal(STASH, {
      path: "new.md",
      body: "new candidate\n",
      baseVersion: null,
    });
    await expect(proposals.getProposalDiff(STASH, fromEmpty.value.id)).resolves.toMatchObject({
      state: "ready",
      base: { version: null, hash: null, deleted: false },
      current: null,
      stale: false,
    });

    await writes.put(STASH, "deleted.md", { body: "old\n", expectedVersion: null });
    await writes.delete(STASH, "deleted.md", { expectedVersion: 1 });
    const fromTombstone = await proposals.createProposal(STASH, {
      path: "deleted.md",
      body: "replacement\n",
      baseVersion: 2,
    });
    await expect(proposals.getProposalDiff(STASH, fromTombstone.value.id)).resolves.toMatchObject({
      state: "ready",
      base: { version: 2, hash: null, deleted: true },
      current: { version: 2, deleted: true },
      stale: false,
    });

    const oversized = await proposals.createProposal(STASH, {
      path: "large.md",
      body: "x".repeat(DIFF_MAX_BYTES + 1),
      baseVersion: null,
    });
    await expect(proposals.getProposalDiff(STASH, oversized.value.id)).resolves.toEqual({
      state: "oversized",
      reason: "bytes",
      base: { version: null, hash: null, deleted: false },
      candidate: { hash: oversized.value.hash, size: DIFF_MAX_BYTES + 1 },
      current: null,
      stale: false,
    });
  });

  it("conceals missing and deleted stashes and never crosses proposal ownership", async () => {
    const { proposals } = await setup();
    const created = await proposals.createProposal(STASH, {
      path: "private.md",
      body: "private",
      baseVersion: null,
    });
    await seedStash("other-stash");
    await expect(proposals.getProposal("other-stash", created.value.id)).resolves.toBeNull();
    await expectRejectedCode(
      proposals.createProposal("missing-stash", {
        path: "missing.md",
        body: "missing",
        baseVersion: null,
      }),
      "not-found",
    );

    await env.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?").bind(NOW, STASH).run();
    await expectRejectedCode(proposals.listProposals(STASH), "not-found");
    await expectRejectedCode(proposals.getProposal(STASH, created.value.id), "not-found");
    await expectRejectedCode(proposals.getProposalDiff(STASH, created.value.id), "not-found");
    await expectRejectedCode(
      proposals.createProposal(STASH, {
        path: "after-delete.md",
        body: "candidate",
        baseVersion: null,
      }),
      "not-found",
    );
  });
});
