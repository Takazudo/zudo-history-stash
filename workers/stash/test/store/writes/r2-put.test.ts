import { env } from "cloudflare:workers";
import { R2_SPILL_BYTES, sha256Hex } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { blobKey, parseBlobKey } from "../../../src/d1/blobs.js";
import { createWrites } from "../../../src/d1/writes.js";
import { resetDatabase } from "../../helpers/app.js";
import { wrapBlobs, type BlobCallCounts } from "../../helpers/env.js";
import { generation, generationFactory } from "../../helpers/blob-generations.js";
import { counts, expectError, setup } from "./helpers.js";

interface StoredBlobRow {
  hash: string;
  body: string | null;
  r2_key: string | null;
  size_bytes: number;
}

function spilledBody(fill: string): string {
  return fill.repeat(R2_SPILL_BYTES + 1);
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

async function storedBlobs(stash: string): Promise<StoredBlobRow[]> {
  const result = await env.DB.prepare(
    "SELECT hash, body, r2_key, size_bytes FROM blobs WHERE stash_name = ? ORDER BY hash",
  )
    .bind(stash)
    .all<StoredBlobRow>();
  return result.results;
}

beforeEach(resetDatabase);

describe("R2-backed put writes", () => {
  it("keeps the exact boundary inline and stores spilled creates and updates as R2 pointers", async () => {
    const generationValue = generation(1);
    const initial = await setup({ createBlobGeneration: () => generationValue });
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), initial.deps);
    const inlineBody = "i".repeat(R2_SPILL_BYTES);

    const created = await writes.put(initial.stash, "boundary.txt", {
      body: inlineBody,
      expectedVersion: null,
    });
    expect(created).toMatchObject({ ok: true, value: { version: 1, size: R2_SPILL_BYTES } });
    expect(calls).toEqual({ get: 0, put: 0 });
    await expect(storedBlobs(initial.stash)).resolves.toEqual([
      expect.objectContaining({ body: inlineBody, r2_key: null, size_bytes: R2_SPILL_BYTES }),
    ]);

    const body = spilledBody("s");
    const hash = await sha256Hex(body);
    const key = blobKey(initial.stash, hash, generationValue);
    const updated = await writes.put(initial.stash, "boundary.txt", {
      body,
      expectedVersion: 1,
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { version: 2, hash, size: R2_SPILL_BYTES + 1 },
    });
    expect(calls).toEqual({ get: 0, put: 1 });

    const rows = await storedBlobs(initial.stash);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      hash,
      body: null,
      r2_key: key,
      size_bytes: R2_SPILL_BYTES + 1,
    });
    await expect(env.BLOBS.head(key)).resolves.toMatchObject({ key, size: R2_SPILL_BYTES + 1 });
  });

  it("does not upload for stale, exists, or unchanged preflight exits", async () => {
    const initial = await setup();
    const body = spilledBody("h");
    await initial.writes.put(initial.stash, "head.txt", { body, expectedVersion: null });
    const before = await counts(initial.stash);
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), initial.deps);

    expectError(
      await writes.put(initial.stash, "head.txt", {
        body: spilledBody("s"),
        expectedVersion: 2,
      }),
      "stale",
    );
    expectError(
      await writes.put(initial.stash, "head.txt", {
        body: spilledBody("e"),
        expectedVersion: null,
      }),
      "exists",
    );
    await expect(
      writes.put(initial.stash, "head.txt", {
        body,
        expectedVersion: 1,
        skipIfUnchanged: true,
      }),
    ).resolves.toMatchObject({ ok: true, value: { unchanged: true, version: 1 } });

    expect(calls).toEqual({ get: 0, put: 0 });
    expect(await counts(initial.stash)).toEqual(before);
    const row = (await storedBlobs(initial.stash))[0];
    await expect(env.BLOBS.list({ prefix: `v2/${initial.stash}/` })).resolves.toMatchObject({
      objects: [expect.objectContaining({ key: row?.r2_key })],
    });
  });

  it("replays a sequential idempotent request without a second upload", async () => {
    const initial = await setup();
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), initial.deps);
    const input = { body: spilledBody("r"), expectedVersion: null } as const;

    const first = await writes.put(initial.stash, "replay.txt", input, {
      idempotencyKey: "spilled-replay",
    });
    const replay = await writes.put(initial.stash, "replay.txt", input, {
      idempotencyKey: "spilled-replay",
    });

    expect(first).toMatchObject({ ok: true, statusCode: 201 });
    expect(replay).toMatchObject({ ok: true, statusCode: 201, replayed: true });
    if (!first.ok || !replay.ok) throw new Error("Expected successful put and replay");
    expect(replay.value).toEqual(first.value);
    expectError(
      await writes.put(
        initial.stash,
        "replay.txt",
        { body: spilledBody("x"), expectedVersion: null },
        { idempotencyKey: "spilled-replay" },
      ),
      "idempotency-key-reused",
    );
    expect(calls).toEqual({ get: 0, put: 1 });
    expect(await counts(initial.stash)).toEqual({
      blobs: 1,
      versions: 1,
      files: 1,
      idempotency: 1,
    });
  });

  it("converges concurrent same-key uploads on one ledger entry and version", async () => {
    const generations = [generation(10), generation(11)] as const;
    const initial = await setup({ createBlobGeneration: generationFactory(...generations) });
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), {
      ...initial.deps,
      onBeforeCommit: twoPartyBarrier(),
    });
    const input = { body: spilledBody("k"), expectedVersion: null } as const;

    const results = await Promise.all([
      writes.put(initial.stash, "same-key.txt", input, { idempotencyKey: "same-key" }),
      writes.put(initial.stash, "same-key.txt", input, { idempotencyKey: "same-key" }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    if (!results[0]?.ok || !results[1]?.ok) throw new Error("Expected converged writes");
    expect(results[0].value).toEqual(results[1].value);
    expect(calls).toEqual({ get: 0, put: 2 });
    expect(await counts(initial.stash)).toEqual({
      blobs: 1,
      versions: 1,
      files: 1,
      idempotency: 1,
    });
    const listed = await env.BLOBS.list({ prefix: `v2/${initial.stash}/` });
    const hash = await sha256Hex(input.body);
    expect(listed.objects.map(({ key }) => key).sort()).toEqual(
      generations.map((value) => blobKey(initial.stash, hash, value)).sort(),
    );
    const [row] = await storedBlobs(initial.stash);
    expect(listed.objects.some((object) => object.key === row?.r2_key)).toBe(true);
  });

  it("leaves only the losing object orphaned after a distinct-content create race", async () => {
    const generations = [generation(20), generation(21)] as const;
    const initial = await setup({ createBlobGeneration: generationFactory(...generations) });
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), {
      ...initial.deps,
      onBeforeCommit: twoPartyBarrier(),
    });
    const firstBody = spilledBody("a");
    const secondBody = spilledBody("b");

    const results = await Promise.all([
      writes.put(initial.stash, "race.txt", { body: firstBody, expectedVersion: null }),
      writes.put(initial.stash, "race.txt", { body: secondBody, expectedVersion: null }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loser = results.find((result) => !result.ok);
    if (loser === undefined) throw new Error("Expected one losing put");
    expectError(loser, "exists");
    expect(calls).toEqual({ get: 0, put: 2 });
    expect(await counts(initial.stash)).toEqual({
      blobs: 1,
      versions: 1,
      files: 1,
      idempotency: 0,
    });

    const rows = await storedBlobs(initial.stash);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: null });
    expect(parseBlobKey(rows[0]!.r2_key ?? "")).toMatchObject({
      format: "v2",
      stash: initial.stash,
      hash: rows[0]!.hash,
    });
    const listed = await env.BLOBS.list({ prefix: `v2/${initial.stash}/` });
    expect(listed.objects).toHaveLength(2);
    expect(new Set(listed.objects.map(({ key }) => key)).size).toBe(2);
    expect(listed.objects.filter(({ key }) => key !== rows[0]!.r2_key)).toHaveLength(1);
  });

  it("does not enter the commit hook or D1 batch when the upload fails", async () => {
    const initial = await setup();
    const calls: BlobCallCounts = { get: 0, put: 0 };
    let hookCalls = 0;
    const writes = createWrites(wrapBlobs(initial.env, { count: calls, failPut: true }), {
      ...initial.deps,
      onBeforeCommit: () => {
        hookCalls += 1;
      },
    });

    await expect(
      writes.put(initial.stash, "failure.txt", {
        body: spilledBody("f"),
        expectedVersion: null,
      }),
    ).rejects.toThrow("Injected R2 put failure");
    expect(hookCalls).toBe(0);
    expect(calls).toEqual({ get: 0, put: 1 });
    expect(await counts(initial.stash)).toEqual({
      blobs: 0,
      versions: 0,
      files: 0,
      idempotency: 0,
    });
    await expect(env.BLOBS.list({ prefix: `v2/${initial.stash}/` })).resolves.toMatchObject({
      objects: [],
    });
  });

  it("rolls back to a spilled version without reading or writing R2", async () => {
    const initial = await setup();
    const body = spilledBody("z");
    const first = await initial.writes.put(initial.stash, "rollback.txt", {
      body,
      expectedVersion: null,
    });
    await initial.writes.put(initial.stash, "rollback.txt", {
      body: "inline update",
      expectedVersion: 1,
    });
    if (!first.ok || "unchanged" in first.value) throw new Error("Expected spilled version");
    const calls: BlobCallCounts = { get: 0, put: 0 };
    const writes = createWrites(wrapBlobs(initial.env, { count: calls }), initial.deps);

    const result = await writes.rollback(initial.stash, "rollback.txt", {
      expectedVersion: 2,
      toVersion: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { version: 3, rollbackOf: 1, hash: first.value.hash },
    });
    expect(calls).toEqual({ get: 0, put: 0 });
    expect(await counts(initial.stash)).toEqual({
      blobs: 2,
      versions: 3,
      files: 1,
      idempotency: 0,
    });
  });
});
