import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE_SET_DELETE_ROW_CHUNK_SIZE,
  buildChangeSetDeletes,
  selectChangeSetPage,
  type ChangeSetPhase,
} from "../../src/d1/sql/gc.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

const cutoff = 100;
const owner = "change-set-gc-test";
const generation = 7;

function changeSetId(value: number): string {
  return `chs_${String(value).padStart(13, "0")}aaaaaaaa`;
}

async function seedChangeSet(input: {
  id: string;
  stash?: string;
  status: "open" | "applied" | "rejected";
  expiresAt: number;
  decidedAt?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO change_sets
      (id, stash_name, status, expires_at, created_by, created_at, decided_at)
     VALUES (?, ?, ?, ?, 'test', 0, ?)`,
  )
    .bind(
      input.id,
      input.stash ?? "live-stash",
      input.status,
      input.expiresAt,
      input.decidedAt ?? null,
    )
    .run();
}

async function seedEntry(changeSetId: string, path = "entry.txt"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO change_set_entries (change_set_id, stash_name, path, op)
     VALUES (?, 'live-stash', ?, 'delete')`,
  )
    .bind(changeSetId, path)
    .run();
}

async function rowsFor(
  phase: ChangeSetPhase,
  afterId = "",
  limit = 100,
): Promise<{ id: string }[]> {
  const rows = await env.DB.prepare(selectChangeSetPage(phase))
    .bind(cutoff, afterId, limit)
    .all<{ id: string }>();
  return rows.results;
}

async function seedLease(): Promise<void> {
  await env.DB.prepare(
    `UPDATE gc_jobs SET lease_owner = ?, lease_generation = ? WHERE kind = 'content'`,
  )
    .bind(owner, generation)
    .run();
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash("live-stash");
  await seedStash("deleted-stash");
  await env.DB.prepare("UPDATE stashes SET deleted_at = 1 WHERE name = 'deleted-stash'").run();
});

describe("change-set retention SQL", () => {
  it("selects expired open rows by keyset, including the boundary and deleted stashes", async () => {
    const eligible = changeSetId(1);
    const applied = changeSetId(2);
    const boundary = changeSetId(3);
    const tooNew = changeSetId(4);
    const deletedStash = changeSetId(5);
    await seedChangeSet({ id: eligible, status: "open", expiresAt: cutoff - 1 });
    await seedChangeSet({ id: applied, status: "applied", expiresAt: 0 });
    await seedChangeSet({ id: boundary, status: "open", expiresAt: cutoff });
    await seedChangeSet({ id: tooNew, status: "open", expiresAt: cutoff + 1 });
    await seedChangeSet({
      id: deletedStash,
      stash: "deleted-stash",
      status: "open",
      expiresAt: 0,
    });

    await expect(rowsFor("expired")).resolves.toEqual([
      { id: eligible },
      { id: boundary },
      { id: deletedStash },
    ]);
    await expect(rowsFor("expired", eligible, 1)).resolves.toEqual([{ id: boundary }]);
    await expect(rowsFor("expired", boundary)).resolves.toEqual([{ id: deletedStash }]);
  });

  it("selects rejected rows by decision time with an expiry fallback", async () => {
    const decided = changeSetId(1);
    const nullDecision = changeSetId(2);
    const tooNew = changeSetId(3);
    const open = changeSetId(4);
    const applied = changeSetId(5);
    await seedChangeSet({
      id: decided,
      status: "rejected",
      expiresAt: cutoff + 10,
      decidedAt: cutoff,
    });
    await seedChangeSet({
      id: nullDecision,
      status: "rejected",
      expiresAt: cutoff - 1,
      decidedAt: null,
    });
    await seedChangeSet({
      id: tooNew,
      status: "rejected",
      expiresAt: 0,
      decidedAt: cutoff + 1,
    });
    await seedChangeSet({ id: open, status: "open", expiresAt: 0 });
    await seedChangeSet({ id: applied, status: "applied", expiresAt: 0 });

    await expect(rowsFor("rejected")).resolves.toEqual([{ id: decided }, { id: nullDecision }]);
  });

  it("chunks delete statements and identifies only parent results", () => {
    expect(() =>
      buildChangeSetDeletes(env.DB, {
        phase: "expired",
        rows: [],
        cutoff,
        kind: "content",
        owner,
        generation,
      }),
    ).toThrow("buildChangeSetDeletes requires at least one row");

    const oneChunk = buildChangeSetDeletes(env.DB, {
      phase: "expired",
      rows: [{ id: changeSetId(1) }],
      cutoff,
      kind: "content",
      owner,
      generation,
    });
    expect(oneChunk.statements).toHaveLength(2);
    expect(oneChunk.parentIndexes).toEqual([1]);

    const twoChunks = buildChangeSetDeletes(env.DB, {
      phase: "rejected",
      rows: Array.from({ length: CHANGE_SET_DELETE_ROW_CHUNK_SIZE + 1 }, (_, index) => ({
        id: changeSetId(index + 1),
      })),
      cutoff,
      kind: "content",
      owner,
      generation,
    });
    expect(twoChunks.statements).toHaveLength(4);
    expect(twoChunks.parentIndexes).toEqual([1, 3]);
  });

  it("deletes entries before an eligible parent under the active lease", async () => {
    const id = changeSetId(1);
    await seedChangeSet({ id, status: "open", expiresAt: cutoff });
    await seedEntry(id);
    await seedLease();
    const batch = buildChangeSetDeletes(env.DB, {
      phase: "expired",
      rows: [{ id }],
      cutoff,
      kind: "content",
      owner,
      generation,
    });

    const results = await env.DB.batch(batch.statements);

    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.meta.changes).toBe(1);
    await expect(
      env.DB.prepare("SELECT 1 FROM change_set_entries WHERE change_set_id = ?").bind(id).first(),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT 1 FROM change_sets WHERE id = ?").bind(id).first(),
    ).resolves.toBeNull();
  });

  it("skips a parent whose entry remains without aborting the batch", async () => {
    const id = changeSetId(1);
    await seedChangeSet({ id, status: "open", expiresAt: cutoff });
    await seedEntry(id);
    await seedLease();
    const batch = buildChangeSetDeletes(env.DB, {
      phase: "expired",
      rows: [{ id }],
      cutoff,
      kind: "content",
      owner,
      generation,
    });

    const results = await env.DB.batch([batch.statements[1]!]);

    expect(results[0]?.meta.changes).toBe(0);
    await expect(
      env.DB.prepare("SELECT 1 FROM change_set_entries WHERE change_set_id = ?").bind(id).first(),
    ).resolves.not.toBeNull();
    await expect(
      env.DB.prepare("SELECT 1 FROM change_sets WHERE id = ?").bind(id).first(),
    ).resolves.not.toBeNull();
  });
});
