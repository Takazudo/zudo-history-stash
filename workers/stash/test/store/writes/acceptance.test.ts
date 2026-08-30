import { env } from "cloudflare:workers";
import { IDEMPOTENCY_TTL_DAYS, MAX_BODY_BYTES, RunGcBody } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { createWrites } from "../../../src/d1/writes.js";
import { commitBatch } from "../../../src/d1/sql/commits.js";
import { createGcEngine } from "../../../src/gc.js";
import { counts, expectError, setup } from "./helpers.js";

describe("stash writes", () => {
  it("creates one sealed commit per changed write and none for an unchanged put", async () => {
    const { stash, writes } = await setup();
    const put = await writes.put(stash, "committed.txt", { body: "one", expectedVersion: null });
    if (!put.ok || "unchanged" in put.value) throw new Error("Expected committed put");
    const unchanged = await writes.put(stash, "committed.txt", {
      body: "one",
      expectedVersion: 1,
      skipIfUnchanged: true,
    });
    expect(unchanged).toMatchObject({ ok: true, value: { unchanged: true } });
    const deleted = await writes.delete(stash, "committed.txt", { expectedVersion: 1 });
    if (!deleted.ok) throw new Error("Expected committed delete");
    const rollback = await writes.rollback(stash, "committed.txt", {
      expectedVersion: 2,
      toVersion: 1,
    });
    if (!rollback.ok) throw new Error("Expected committed rollback");

    const commits = await env.DB.prepare(
      `SELECT id, source, entry_count, change_count, sealed, first_change_id, last_change_id
       FROM commits WHERE stash_name = ? ORDER BY first_change_id`,
    )
      .bind(stash)
      .all();
    expect(commits.results).toEqual([
      {
        id: put.value.commitId,
        source: "put",
        entry_count: 1,
        change_count: 1,
        sealed: 1,
        first_change_id: put.value.changeId,
        last_change_id: put.value.changeId,
      },
      {
        id: deleted.value.commitId,
        source: "delete",
        entry_count: 1,
        change_count: 1,
        sealed: 1,
        first_change_id: deleted.value.changeId,
        last_change_id: deleted.value.changeId,
      },
      {
        id: rollback.value.commitId,
        source: "rollback",
        entry_count: 1,
        change_count: 1,
        sealed: 1,
        first_change_id: rollback.value.changeId,
        last_change_id: rollback.value.changeId,
      },
    ]);
  });

  it("preserves byte-exact bodies and reports the inserted version id", async () => {
    const { stash, writes } = await setup();
    const bodies = ["日本語", "line1\r\nline2", "trailing\n", ""];
    let expectedVersion: number | null = null;
    for (const body of bodies) {
      const result = await writes.put(stash, "exact.txt", { body, expectedVersion });
      expect(result.ok).toBe(true);
      if (!result.ok || "unchanged" in result.value) throw new Error("put failed");
      const row = await env.DB.prepare(
        `SELECT v.id, b.body FROM versions v JOIN blobs b
         ON b.stash_name = v.stash_name AND b.hash = v.blob_hash
         WHERE v.stash_name = ? AND v.path = ? AND v.version = ?`,
      )
        .bind(stash, "exact.txt", result.value.version)
        .first<{ id: number; body: string }>();
      expect(row).toEqual({ id: result.value.changeId, body });
      expectedVersion = result.value.version;
    }
    const tooLarge = await writes.put(stash, "large.txt", {
      body: "x".repeat(MAX_BODY_BYTES + 1),
      expectedVersion: null,
    });
    expectError(tooLarge, "payload-too-large");
  });

  it("returns validation instead of throwing for malformed store-level put input", async () => {
    const { stash, writes } = await setup();
    const result = await writes.put(stash, "malformed.txt", { expectedVersion: null } as never);
    expectError(result, "validation");
  });

  it("checks CAS before skip and returns complete current values", async () => {
    const { stash, writes } = await setup();
    const first = await writes.put(stash, "cas.txt", {
      body: "same",
      expectedVersion: null,
      author: "owner",
    });
    expect(first.ok).toBe(true);
    const stale = await writes.put(stash, "cas.txt", {
      body: "same",
      expectedVersion: 2,
      skipIfUnchanged: true,
    });
    expectError(stale, "stale");
    if (stale.ok) throw new Error("expected stale");
    expect(stale.current).toMatchObject({
      version: 1,
      deleted: false,
      kind: "put",
      author: "owner",
    });
    expect(stale.current?.hash).toMatch(/^sha256-/);
    expect(stale.current?.createdAt).toMatch(/Z$/);
    const exists = await writes.put(stash, "cas.txt", {
      body: "same",
      expectedVersion: null,
      skipIfUnchanged: true,
    });
    expectError(exists, "exists");
    const unchanged = await writes.put(stash, "cas.txt", {
      body: "same",
      expectedVersion: 1,
      skipIfUnchanged: true,
    });
    expect(unchanged).toMatchObject({
      ok: true,
      statusCode: 200,
      value: { unchanged: true, version: 1 },
    });
    const metadataChange = await writes.put(stash, "cas.txt", {
      body: "same",
      expectedVersion: 1,
      contentType: "text/markdown; charset=utf-8",
      skipIfUnchanged: true,
    });
    expect(metadataChange).toMatchObject({
      ok: true,
      statusCode: 201,
      value: { version: 2 },
    });
  });

  it("covers deletion, tombstone resurrection, and missing outcomes", async () => {
    const { stash, writes } = await setup();
    expectError(await writes.delete(stash, "missing.txt", { expectedVersion: 1 }), "not-found");
    expectError(
      await writes.rollback(stash, "missing.txt", { expectedVersion: 1, toVersion: 1 }),
      "not-found",
    );
    await writes.put(stash, "life.txt", { body: "v1", expectedVersion: null });
    expectError(await writes.delete(stash, "life.txt", { expectedVersion: 2 }), "stale");
    const deleted = await writes.delete(stash, "life.txt", { expectedVersion: 1 });
    expect(deleted.ok).toBe(true);
    const already = await writes.delete(stash, "life.txt", { expectedVersion: 2 });
    expectError(already, "already-deleted");
    const exists = await writes.put(stash, "life.txt", { body: "x", expectedVersion: null });
    expectError(exists, "exists");
    if (exists.ok) throw new Error("expected exists");
    expect(exists.current?.deleted).toBe(true);
    const resurrected = await writes.put(stash, "life.txt", { body: "v3", expectedVersion: 2 });
    expect(resurrected.ok).toBe(true);
    expectError(
      await writes.rollback(stash, "life.txt", { expectedVersion: 3, toVersion: 99 }),
      "version-not-found",
    );

    await writes.put(stash, "rollback-resurrect.txt", { body: "live", expectedVersion: null });
    await writes.delete(stash, "rollback-resurrect.txt", { expectedVersion: 1 });
    const rollbackResurrection = await writes.rollback(stash, "rollback-resurrect.txt", {
      expectedVersion: 2,
      toVersion: 1,
    });
    expect(rollbackResurrection).toMatchObject({
      ok: true,
      value: { version: 3, rollbackOf: 1 },
    });
  });

  it("rolls back zero-copy, appends forever, and rejects tombstone targets", async () => {
    const { stash, writes } = await setup();
    await writes.put(stash, "history.txt", { body: "one", expectedVersion: null });
    await writes.put(stash, "history.txt", { body: "two", expectedVersion: 1 });
    await writes.delete(stash, "history.txt", { expectedVersion: 2 });
    await writes.put(stash, "history.txt", { body: "three", expectedVersion: 3 });
    const before = await counts(stash);
    const rollback = await writes.rollback(stash, "history.txt", {
      expectedVersion: 4,
      toVersion: 1,
    });
    expect(rollback).toMatchObject({
      ok: true,
      value: { version: 5, rollbackOf: 1, identicalToHead: false },
    });
    expect((await counts(stash)).blobs).toBe(before.blobs);
    const identical = await writes.rollback(stash, "history.txt", {
      expectedVersion: 5,
      toVersion: 1,
    });
    expect(identical).toMatchObject({ ok: true, value: { identicalToHead: true } });
    const restoreThree = await writes.rollback(stash, "history.txt", {
      expectedVersion: 6,
      toVersion: 4,
    });
    expect(restoreThree).toMatchObject({ ok: true, value: { rollbackOf: 4 } });
    expectError(
      await writes.rollback(stash, "history.txt", { expectedVersion: 7, toVersion: 3 }),
      "rollback-target-tombstone",
    );
    const rows = await env.DB.prepare(
      "SELECT version, kind, rollback_of FROM versions WHERE stash_name = ? ORDER BY version",
    )
      .bind(stash)
      .all<{ version: number; kind: string; rollback_of: number | null }>();
    expect(rows.results.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.results[4]).toMatchObject({ kind: "rollback", rollback_of: 1 });
  });

  it("leaks no rows when an injected competitor moves the head", async () => {
    const initial = await setup();
    await initial.writes.put(initial.stash, "race.txt", { body: "base", expectedVersion: null });
    const competitor = createWrites(initial.env, initial.deps);
    let calls = 0;
    let afterWinner: Awaited<ReturnType<typeof counts>> | undefined;
    const outer = createWrites(initial.env, {
      ...initial.deps,
      onBeforeCommit: async () => {
        calls += 1;
        await competitor.put(initial.stash, "race.txt", {
          body: "winner",
          expectedVersion: 1,
        });
        afterWinner = await counts(initial.stash);
      },
    });
    const before = await counts(initial.stash);
    const result = await outer.put(
      initial.stash,
      "race.txt",
      { body: "loser-unique-body", expectedVersion: 1 },
      { idempotencyKey: "loser-key" },
    );
    expect(calls).toBe(1);
    expectError(result, "stale");
    const after = await counts(initial.stash);
    expect(after).toEqual(afterWinner);
    expect(after).toEqual({
      blobs: before.blobs + 1,
      versions: before.versions + 1,
      files: before.files,
      idempotency: before.idempotency,
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM commits WHERE stash_name = ?")
        .bind(initial.stash)
        .first(),
    ).resolves.toEqual({ count: 2 });
    expect(
      await env.DB.prepare("SELECT 1 FROM blobs WHERE stash_name = ? AND body = ?")
        .bind(initial.stash, "loser-unique-body")
        .first(),
    ).toBeNull();
  });

  it("classifies a concurrent delete loser as stale before tombstone state", async () => {
    const initial = await setup();
    await initial.writes.put(initial.stash, "delete-race.txt", {
      body: "base",
      expectedVersion: null,
    });
    const competitor = createWrites(initial.env, initial.deps);
    let afterWinner: Awaited<ReturnType<typeof counts>> | undefined;
    const outer = createWrites(initial.env, {
      ...initial.deps,
      onBeforeCommit: async () => {
        await competitor.delete(initial.stash, "delete-race.txt", { expectedVersion: 1 });
        afterWinner = await counts(initial.stash);
      },
    });
    const result = await outer.delete(initial.stash, "delete-race.txt", {
      expectedVersion: 1,
    });
    expectError(result, "stale");
    if (result.ok) throw new Error("expected stale delete");
    expect(result.current).toMatchObject({ version: 2, deleted: true, kind: "delete" });
    expect(await counts(initial.stash)).toEqual(afterWinner);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM commits WHERE stash_name = ?")
        .bind(initial.stash)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("allows exactly one real concurrent CAS writer", async () => {
    const { stash, writes } = await setup();
    await writes.put(stash, "parallel.txt", { body: "base", expectedVersion: null });
    const before = await counts(stash);
    const results = await Promise.all([
      writes.put(stash, "parallel.txt", { body: "a", expectedVersion: 1 }),
      writes.put(stash, "parallel.txt", { body: "b", expectedVersion: 1 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(await counts(stash)).toEqual({
      blobs: before.blobs + 1,
      versions: before.versions + 1,
      files: before.files,
      idempotency: before.idempotency,
    });
  });

  it("keeps the SQL fence closed for a tombstone rollback target", async () => {
    const { stash, writes } = await setup();
    await writes.put(stash, "hole.txt", { body: "one", expectedVersion: null });
    await writes.delete(stash, "hole.txt", { expectedVersion: 1 });
    const db = env.DB.withSession("first-primary");
    const before = await counts(stash);
    const results = await db.batch(
      commitBatch(db, {
        row: {
          id: "cmt_tombstone_refusal",
          stash_name: stash,
          source: "rollback",
          source_id: null,
          author: "",
          message: "",
          meta_json: "{}",
          entry_count: 1,
          reverts_commit_id: null,
          idempotency_key: null,
          request_hash: null,
          created_by: "test",
          created_at: 123,
        },
        entries: [
          {
            op: "rollback",
            path: "hole.txt",
            expectedVersion: 2,
            version: 3,
            toVersion: 2,
            author: "",
            message: "Rollback to v2",
            metaJson: "{}",
            createdAt: 123,
          },
        ],
      }),
    );
    expect(results.at(-1)?.meta.changes).toBe(0);
    expect(await counts(stash)).toEqual(before);
  });

  it("replays ledger results, canonicalizes meta, and rejects key reuse", async () => {
    const { stash, writes } = await setup();
    const input = {
      body: "ledger",
      expectedVersion: null,
      meta: { z: 1, nested: { b: true, a: false }, a: 2 },
    };
    const first = await writes.put(stash, "ledger.txt", input, { idempotencyKey: "same" });
    expect(first).toMatchObject({ ok: true, statusCode: 201 });
    const replay = await writes.put(
      stash,
      "ledger.txt",
      { ...input, meta: { a: 2, nested: { a: false, b: true }, z: 1 } },
      { idempotencyKey: "same" },
    );
    expect(replay).toMatchObject({ ok: true, statusCode: 201, replayed: true });
    if (!first.ok || !replay.ok) throw new Error("ledger writes failed");
    expect(replay.value).toEqual(first.value);
    expectError(
      await writes.put(
        stash,
        "ledger.txt",
        { ...input, contentType: "text/markdown" },
        { idempotencyKey: "same" },
      ),
      "idempotency-key-reused",
    );
    const unchanged = await writes.put(
      stash,
      "ledger.txt",
      { body: "ledger", expectedVersion: 1, skipIfUnchanged: true },
      { idempotencyKey: "unchanged" },
    );
    expect(unchanged).toMatchObject({ ok: true, value: { unchanged: true } });
    expect(
      await env.DB.prepare("SELECT 1 FROM idempotency WHERE stash_name = ? AND key = ?")
        .bind(stash, "unchanged")
        .first(),
    ).toBeNull();
  });

  it("allows a single-path idempotency key to be reused after its ledger row expires", async () => {
    const createdAt = 1_700_000_000_000;
    const { stash, writes, deps, env: workerEnv } = await setup({ now: () => createdAt });
    const first = await writes.put(
      stash,
      "expiring-ledger.txt",
      { body: "before expiry", expectedVersion: null },
      { idempotencyKey: "expiring-key" },
    );
    expect(first).toMatchObject({ ok: true, value: { version: 1 } });
    await expect(
      workerEnv.DB.prepare(
        "SELECT idempotency_key, request_hash FROM commits WHERE stash_name = ? AND source = 'put'",
      )
        .bind(stash)
        .first(),
    ).resolves.toEqual({ idempotency_key: null, request_hash: null });

    const afterExpiry = createdAt + IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000 + 1;
    const gc = await createGcEngine(workerEnv, { now: () => afterExpiry }).run(
      RunGcBody.parse({ kind: "ledger", maxObjects: 10 }),
    );
    expect(gc).toMatchObject({ deleted: 1, error: null });
    await expect(
      workerEnv.DB.prepare("SELECT 1 FROM idempotency WHERE stash_name = ? AND key = ?")
        .bind(stash, "expiring-key")
        .first(),
    ).resolves.toBeNull();

    const writesAfterExpiry = createWrites(workerEnv, { ...deps, now: () => afterExpiry });
    const reused = await writesAfterExpiry.put(
      stash,
      "expiring-ledger.txt",
      { body: "after expiry", expectedVersion: 1 },
      { idempotencyKey: "expiring-key" },
    );
    expect(reused).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it("makes concurrent same-key calls converge on winner plus replay", async () => {
    const { stash, writes } = await setup();
    const input = { body: "concurrent-ledger", expectedVersion: null } as const;
    const results = await Promise.all([
      writes.put(stash, "same-key.txt", input, { idempotencyKey: "concurrent" }),
      writes.put(stash, "same-key.txt", input, { idempotencyKey: "concurrent" }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    if (!results[0]?.ok || !results[1]?.ok) throw new Error("same-key calls failed");
    expect(results[0].value).toEqual(results[1].value);
    expect((await counts(stash)).versions).toBe(1);
  });

  it("reconstructs delete and rollback replay shapes from version rows", async () => {
    const { stash, writes } = await setup();
    await writes.put(stash, "op-ledger.txt", { body: "one", expectedVersion: null });
    await writes.put(stash, "op-ledger.txt", { body: "two", expectedVersion: 1 });
    const rollbackInput = { expectedVersion: 2, toVersion: 1 };
    const rollback = await writes.rollback(stash, "op-ledger.txt", rollbackInput, {
      idempotencyKey: "rollback-op",
    });
    const rollbackReplay = await writes.rollback(stash, "op-ledger.txt", rollbackInput, {
      idempotencyKey: "rollback-op",
    });
    expect(rollbackReplay).toMatchObject({ ok: true, statusCode: 201, replayed: true });
    if (!rollback.ok || !rollbackReplay.ok) throw new Error("rollback replay failed");
    expect(rollbackReplay.value).toEqual(rollback.value);

    const deleteInput = { expectedVersion: 3 };
    const deleted = await writes.delete(stash, "op-ledger.txt", deleteInput, {
      idempotencyKey: "delete-op",
    });
    const deleteReplay = await writes.delete(stash, "op-ledger.txt", deleteInput, {
      idempotencyKey: "delete-op",
    });
    expect(deleteReplay).toMatchObject({ ok: true, statusCode: 200, replayed: true });
    if (!deleted.ok || !deleteReplay.ok) throw new Error("delete replay failed");
    expect(deleteReplay.value).toEqual(deleted.value);
  });
});
