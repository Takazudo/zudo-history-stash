import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createStashStore } from "../../src/d1/store.js";
import { StashRpc } from "../../src/rpc.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const app = createApp({ now: () => 1_800_000_000_000 });

beforeEach(resetDatabase);

async function api(
  stash: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; key?: string; token?: string } = {},
  bindings = createTestEnv().env,
): Promise<Response> {
  const headers = new Headers(bearer(options.token ?? "test-admin"));
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
  headers.set("X-Stash-Client-Id", "commit-tests");
  return request(
    app,
    `http://stash.test/v1/stashes/${stash}/commits${path}`,
    {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    bindings,
  );
}

async function put(stash: string, path: string, body: string, expectedVersion: number | null) {
  return createStashStore(createTestEnv().env).writes.put(stash, path, {
    body,
    expectedVersion,
  });
}

describe("commit routes", () => {
  it("creates and replays a commit while classifying validation, conflict, size, and binary errors", async () => {
    const stash = "commit-errors";
    await seedStash(stash);
    await put(stash, "existing.txt", "before\n", null);
    const body = {
      entries: [{ op: "put", path: "new.txt", expectedVersion: null, body: "new\n" }],
    } as const;
    const created = await api(stash, "", { method: "POST", body, key: "create-key" });
    expect(created.status).toBe(201);
    expect(created.headers.get("Idempotent-Replayed")).toBeNull();
    const value = await created.json<{ id: string; entries: unknown[] }>();
    expect(value.entries).toHaveLength(1);

    const replayed = await api(stash, "", { method: "POST", body, key: "create-key" });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replayed.json()).resolves.toEqual(value);

    const duplicate = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "same.txt", expectedVersion: null, body: "one" },
          { op: "put", path: "same.txt", expectedVersion: null, body: "two" },
        ],
      },
    });
    expect(duplicate.status).toBe(400);

    const conflict = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "existing.txt", expectedVersion: 99, body: "wrong" },
          { op: "put", path: "other.txt", expectedVersion: null, body: "other" },
        ],
      },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "commit-conflict" },
      conflicts: [{ path: "existing.txt", expectedVersion: 99, current: { version: 1 } }],
    });

    const tooLarge = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "large.txt", expectedVersion: null, body: "x".repeat(5_000_001) },
        ],
      },
    });
    expect(tooLarge.status).toBe(413);

    const binary = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          {
            op: "put",
            path: "binary.dat",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AA==",
          },
        ],
      },
    });
    expect(binary.status).toBe(422);
    await expect(binary.json()).resolves.toMatchObject({
      error: { code: "unsupported-representation" },
    });
  });

  it("uses the write limiter for commit creation", async () => {
    const stash = "commit-limited";
    await seedStash(stash);
    const token = await mintToken(stash, "write");
    const response = await api(
      stash,
      "",
      {
        method: "POST",
        token: token.token,
        body: { entries: [{ op: "put", path: "a.txt", expectedVersion: null, body: "a" }] },
      },
      createTestEnv({
        env: { RL_WRITE: { limit: () => Promise.resolve({ success: false }) } },
      }).env,
    );
    expect(response.status).toBe(429);
  });

  it("gets every imported version row and pages/filter commits with an opaque cursor", async () => {
    const stash = "commit-list";
    await seedStash(stash);
    const imported = await request(app, `http://stash.test/v1/stashes/${stash}/import`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "history.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body: "one\n", createdAt: 1 },
          { kind: "put", body: "two\n", createdAt: 2 },
          { kind: "delete", body: null, createdAt: 3 },
        ],
      }),
    });
    expect(imported.status).toBe(201);
    const importedValue = await imported.json<{ commitId: string }>();
    const record = await api(stash, `/${importedValue.commitId}`);
    expect(record.status).toBe(200);
    await expect(record.json()).resolves.toMatchObject({
      id: importedValue.commitId,
      entryCount: 3,
      entries: [
        { path: "history.txt", version: 1 },
        { path: "history.txt", version: 2 },
        { path: "history.txt", version: 3 },
      ],
    });

    const created = await api(stash, "", {
      method: "POST",
      body: { entries: [{ op: "put", path: "other.txt", expectedVersion: null, body: "x" }] },
    });
    expect(created.status).toBe(201);
    const first = await api(stash, "?limit=1");
    const firstPage = await first.json<{
      commits: { id: string }[];
      nextAfter: string | null;
      total: number;
    }>();
    expect(firstPage.commits).toHaveLength(1);
    expect(firstPage.nextAfter).not.toBeNull();
    expect(firstPage.total).toBe(2);
    const second = await api(stash, `?limit=1&after=${encodeURIComponent(firstPage.nextAfter!)}`);
    const secondPage = await second.json<{ commits: { id: string }[]; total: number }>();
    expect(secondPage.total).toBe(2);
    expect(new Set([firstPage.commits[0]?.id, secondPage.commits[0]?.id])).toEqual(
      new Set([importedValue.commitId, (await created.clone().json<{ id: string }>()).id]),
    );
    const filtered = await api(stash, "?path=history.txt");
    await expect(filtered.json()).resolves.toMatchObject({
      commits: [{ id: importedValue.commitId }],
      total: 1,
    });
  });

  it("diffs creation, update, and deletion entries against their prior versions", async () => {
    const stash = "commit-diff";
    await seedStash(stash);
    await put(stash, "updated.txt", "before update\n", null);
    await put(stash, "deleted.txt", "before delete\n", null);
    const created = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "created.txt", expectedVersion: null, body: "created\n" },
          { op: "put", path: "updated.txt", expectedVersion: 1, body: "after update\n" },
          { op: "delete", path: "deleted.txt", expectedVersion: 1 },
        ],
      },
    });
    const commit = await created.json<{ id: string }>();
    const diff = await api(stash, `/${commit.id}/diff?context=1`);
    expect(diff.status).toBe(200);
    const value = await diff.json<{
      entries: Array<{
        path: string;
        from: unknown;
        to: unknown;
        diff: { state: string; stats?: unknown };
      }>;
      truncated: boolean;
    }>();
    expect(value.truncated).toBe(false);
    expect(value.entries).toHaveLength(3);
    expect(value.entries[0]).toMatchObject({
      path: "created.txt",
      from: null,
      to: { version: 1 },
      diff: { state: "ready", stats: { added: 1, removed: 0 } },
    });
    expect(value.entries[2]).toMatchObject({
      path: "deleted.txt",
      from: { version: 1 },
      to: { version: 2, hash: null },
      diff: { state: "ready", stats: { added: 0, removed: 1 } },
    });
    const filtered = await api(stash, `/${commit.id}/diff?path=updated.txt`);
    await expect(filtered.json()).resolves.toMatchObject({
      entries: [{ path: "updated.txt" }],
      truncated: false,
    });
  });

  it("limits inline diff entries and short-circuits binary and oversized content", async () => {
    const stash = "commit-diff-limits";
    await seedStash(stash);
    const created = await api(stash, "", {
      method: "POST",
      body: {
        entries: Array.from({ length: 9 }, (_, index) => ({
          op: "put",
          path: `entry-${String(index)}.txt`,
          expectedVersion: null,
          body: `body-${String(index)}\n`,
        })),
      },
    });
    const commit = await created.json<{ id: string }>();
    const db = createTestEnv().env.DB;
    await db
      .prepare(
        "UPDATE versions SET representation = 'binary' WHERE stash_name = ? AND commit_id = ? AND path = 'entry-0.txt'",
      )
      .bind(stash, commit.id)
      .run();
    const bindings = createTestEnv({ env: { DIFF_MAX_BYTES: "1" } }).env;
    const diff = await api(stash, `/${commit.id}/diff`, {}, bindings);
    const value = await diff.json<{
      entries: Array<{ path: string; diff: { state: string } }>;
      truncated: boolean;
    }>();
    expect(value.entries).toHaveLength(8);
    expect(value.truncated).toBe(true);
    expect(value.entries[0]).toEqual({
      path: "entry-0.txt",
      op: "put",
      from: null,
      to: expect.objectContaining({ version: 1 }),
      diff: { state: "binary" },
    });
    expect(value.entries[1]?.diff).toEqual({ state: "oversized" });
    const filtered = await api(stash, `/${commit.id}/diff?path=entry-8.txt`, {}, bindings);
    await expect(filtered.json()).resolves.toMatchObject({
      entries: [{ path: "entry-8.txt", diff: { state: "oversized" } }],
      truncated: false,
    });
  });

  it("reverts create, put, and delete atomically and conflicts after later head movement", async () => {
    const stash = "commit-revert";
    await seedStash(stash);
    await put(stash, "updated.txt", "before update\n", null);
    await put(stash, "deleted.txt", "before delete\n", null);
    const created = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "created.txt", expectedVersion: null, body: "created\n" },
          { op: "put", path: "updated.txt", expectedVersion: 1, body: "after update\n" },
          { op: "delete", path: "deleted.txt", expectedVersion: 1 },
        ],
      },
    });
    const commit = await created.json<{ id: string }>();
    const reverted = await api(stash, `/${commit.id}/revert`, {
      method: "POST",
      body: {},
      key: "revert-key",
    });
    expect(reverted.status).toBe(201);
    const revertValue = await reverted.json<{
      source: string;
      revertsCommitId: string;
      message: string;
      entries: Array<{ path: string; op: string; rollbackOf: number | null }>;
    }>();
    expect(revertValue).toMatchObject({
      source: "revert",
      revertsCommitId: commit.id,
      message: `Revert ${commit.id}`,
      entries: [
        { path: "created.txt", op: "delete", rollbackOf: null },
        { path: "updated.txt", op: "rollback", rollbackOf: 1 },
        { path: "deleted.txt", op: "rollback", rollbackOf: 1 },
      ],
    });
    const db = createTestEnv().env.DB;
    await expect(
      db
        .prepare("SELECT path, head_version, deleted FROM files WHERE stash_name = ? ORDER BY path")
        .bind(stash)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { path: "created.txt", head_version: 2, deleted: 1 },
        { path: "deleted.txt", head_version: 3, deleted: 0 },
        { path: "updated.txt", head_version: 3, deleted: 0 },
      ],
    });
    const replay = await api(stash, `/${commit.id}/revert`, {
      method: "POST",
      body: {},
      key: "revert-key",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");

    const moved = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "x.txt", expectedVersion: null, body: "x" },
          { op: "put", path: "y.txt", expectedVersion: null, body: "y" },
        ],
      },
    });
    const movedCommit = await moved.json<{ id: string }>();
    await put(stash, "x.txt", "later", 1);
    const refused = await api(stash, `/${movedCommit.id}/revert`, {
      method: "POST",
      body: {},
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "commit-conflict" } });
    await expect(
      db
        .prepare("SELECT head_version FROM files WHERE stash_name = ? AND path = 'y.txt'")
        .bind(stash)
        .first(),
    ).resolves.toEqual({ head_version: 1 });
  });

  it("refuses a revert whose derived delete entries are all already tombstoned", async () => {
    const stash = "commit-revert-skipped";
    await seedStash(stash);
    const imported = await request(app, `http://stash.test/v1/stashes/${stash}/import`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "deleted.txt",
        expectedVersion: null,
        versions: [{ kind: "delete", body: null, createdAt: 1 }],
      }),
    });
    expect(imported.status).toBe(201);
    const commit = await imported.json<{ commitId: string }>();
    const response = await api(stash, `/${commit.commitId}/revert`, {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "validation", message: "nothing to revert" },
    });
  });

  it("exposes exact HTTP behavior through all five named RPC methods", async () => {
    const stash = "commit-rpc";
    await seedStash(stash);
    const rpc = new StashRpc(createExecutionContext(), createTestEnv().env);
    const created = await rpc.createCommit(
      "test-admin",
      stash,
      { entries: [{ op: "put", path: "rpc.txt", expectedVersion: null, body: "rpc\n" }] },
      "rpc-create",
    );
    expect(created.status).toBe(201);
    const value = await created.json<{ id: string }>();
    expect((await rpc.getCommit("test-admin", stash, value.id)).status).toBe(200);
    expect((await rpc.listCommits("test-admin", stash)).status).toBe(200);
    expect((await rpc.getCommitDiff("test-admin", stash, value.id)).status).toBe(200);
    expect((await rpc.revertCommit("test-admin", stash, value.id, {}, "rpc-revert")).status).toBe(
      201,
    );
  });
});
