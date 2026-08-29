import { createExecutionContext } from "cloudflare:test";
import { StashEventSchema, type StashEvent } from "@takazudo/zudo-history-stash-core";
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

function recordingEventsEnv(): {
  bindings: ReturnType<typeof createTestEnv>["env"];
  batches: StashEvent[][];
  names: string[];
} {
  const base = createTestEnv().env;
  const batches: StashEvent[][] = [];
  const names: string[] = [];
  const namespace = new Proxy(base.STASH_EVENTS, {
    get(target, property, receiver) {
      if (property === "getByName") {
        return (name: string) => {
          names.push(name);
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(stubTarget, stubProperty, stubReceiver) {
              if (stubProperty === "fetch") {
                return async (input: Request): Promise<Response> => {
                  batches.push(StashEventSchema.array().parse(await input.json()));
                  return new Response(null, { status: 204 });
                };
              }
              const value = Reflect.get(stubTarget, stubProperty, stubReceiver);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...base, STASH_EVENTS: namespace }, batches, names };
}

describe("commit routes", () => {
  it("publishes one ordered live event batch and emits nothing for replay or refusal", async () => {
    const stash = "commit-route-events";
    await seedStash(stash);
    const { bindings, batches, names } = recordingEventsEnv();
    const body = {
      entries: [
        { op: "put", path: "one.txt", expectedVersion: null, body: "one" },
        { op: "put", path: "two.txt", expectedVersion: null, body: "two" },
      ],
    } as const;
    const created = await api(stash, "", { method: "POST", body, key: "events-create" }, bindings);
    expect(created.status).toBe(201);
    const result = await created.json<{
      id: string;
      firstChangeId: number;
      lastChangeId: number;
      entries: Array<{ changeId: number }>;
    }>();
    expect(names).toEqual([stash]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      expect.objectContaining({
        type: "change",
        commitId: result.id,
        changeId: result.entries[0]?.changeId,
        path: "one.txt",
        origin: "commit-tests",
      }),
      expect.objectContaining({
        type: "change",
        commitId: result.id,
        changeId: result.entries[1]?.changeId,
        path: "two.txt",
        origin: "commit-tests",
      }),
      {
        type: "commit",
        commitId: result.id,
        stash,
        entryCount: 2,
        firstChangeId: result.firstChangeId,
        lastChangeId: result.lastChangeId,
        origin: "commit-tests",
      },
    ]);

    const replayed = await api(stash, "", { method: "POST", body, key: "events-create" }, bindings);
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");

    const refused = await api(
      stash,
      "",
      {
        method: "POST",
        body: {
          entries: [{ op: "put", path: "one.txt", expectedVersion: 99, body: "refused" }],
        },
      },
      bindings,
    );
    expect(refused.status).toBe(409);

    const invalid = await api(
      stash,
      "",
      {
        method: "POST",
        body: {
          entries: [
            { op: "put", path: "same.txt", expectedVersion: null, body: "one" },
            { op: "put", path: "same.txt", expectedVersion: null, body: "two" },
          ],
        },
      },
      bindings,
    );
    expect(invalid.status).toBe(400);
    expect(names).toEqual([stash]);
    expect(batches).toHaveLength(1);
  });

  it("publishes an ordered live batch only for a newly persisted revert", async () => {
    const stash = "commit-revert-events";
    await seedStash(stash);
    const { bindings, batches } = recordingEventsEnv();
    const created = await api(
      stash,
      "",
      {
        method: "POST",
        body: {
          entries: [
            { op: "put", path: "one.txt", expectedVersion: null, body: "one" },
            { op: "put", path: "two.txt", expectedVersion: null, body: "two" },
          ],
        },
      },
      bindings,
    );
    const commit = await created.json<{ id: string }>();
    const beforeRevert = batches.length;

    const reverted = await api(
      stash,
      `/${commit.id}/revert`,
      { method: "POST", body: {}, key: "revert-events" },
      bindings,
    );
    expect(reverted.status).toBe(201);
    const result = await reverted.json<{
      id: string;
      firstChangeId: number;
      lastChangeId: number;
      entries: Array<{ changeId: number }>;
    }>();
    expect(batches).toHaveLength(beforeRevert + 1);
    expect(batches.at(-1)).toEqual([
      expect.objectContaining({
        type: "change",
        commitId: result.id,
        changeId: result.entries[0]?.changeId,
        path: "one.txt",
        origin: "commit-tests",
      }),
      expect.objectContaining({
        type: "change",
        commitId: result.id,
        changeId: result.entries[1]?.changeId,
        path: "two.txt",
        origin: "commit-tests",
      }),
      {
        type: "commit",
        commitId: result.id,
        stash,
        entryCount: 2,
        firstChangeId: result.firstChangeId,
        lastChangeId: result.lastChangeId,
        origin: "commit-tests",
      },
    ]);

    const replay = await api(
      stash,
      `/${commit.id}/revert`,
      { method: "POST", body: {}, key: "revert-events" },
      bindings,
    );
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(batches).toHaveLength(beforeRevert + 1);
  });

  it("creates and replays a commit while classifying validation, conflict, and size errors", async () => {
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
    expect(binary.status).toBe(201);
    await expect(binary.json()).resolves.toMatchObject({
      entries: [{ path: "binary.dat", representation: "binary", storageTier: "d1", size: 1 }],
    });
  });

  it("atomically commits mixed text, binary bytes, and a persisted copy source", async () => {
    const stash = "commit-mixed-binary";
    await seedStash(stash);
    await put(stash, "logo.png", "old-logo", null);
    const hero = Uint8Array.from({ length: 40 * 1024 }, (_, index) => index % 251);
    let binary = "";
    for (const byte of hero) binary += String.fromCharCode(byte);

    const response = await api(stash, "", {
      method: "POST",
      body: {
        entries: [
          { op: "put", path: "index.html", expectedVersion: null, body: "<main />" },
          { op: "put", path: "style.css", expectedVersion: null, body: "main{}" },
          {
            op: "put",
            path: "hero.png",
            expectedVersion: null,
            representation: "binary",
            contentType: "image/png",
            bytesBase64: btoa(binary),
          },
          {
            op: "copy",
            path: "logo-old.png",
            expectedVersion: null,
            from: { path: "logo.png", version: 1 },
          },
        ],
      },
    });
    expect(response.status).toBe(201);
    const commit = await response.json<{ id: string }>();
    const stored = await api(stash, `/${commit.id}`);
    await expect(stored.json()).resolves.toMatchObject({
      entryCount: 4,
      entries: [
        { path: "index.html", op: "put", representation: "text" },
        { path: "style.css", op: "put", representation: "text" },
        {
          path: "hero.png",
          op: "put",
          representation: "binary",
          storageTier: "d1",
          contentType: "image/png",
        },
        {
          path: "logo-old.png",
          op: "copy",
          copiedFrom: { path: "logo.png", version: 1 },
        },
      ],
    });

    const raw = await request(app, `http://stash.test/v1/stashes/${stash}/raw/hero.png`, {
      headers: bearer("test-admin"),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(hero);
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

  it("collapses an imported path to one inverse entry and restores its pre-import absence", async () => {
    const stash = "commit-revert-import";
    await seedStash(stash);
    const imported = await request(app, `http://stash.test/v1/stashes/${stash}/import`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "history.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body: "import one", createdAt: 1 },
          { kind: "delete", body: null, createdAt: 2 },
          { kind: "put", body: "import three", createdAt: 3 },
        ],
      }),
    });
    expect(imported.status).toBe(201);
    const commit = await imported.json<{ commitId: string }>();

    const reverted = await api(stash, `/${commit.commitId}/revert`, {
      method: "POST",
      body: {},
    });
    expect(reverted.status).toBe(201);
    await expect(reverted.json()).resolves.toMatchObject({
      source: "revert",
      revertsCommitId: commit.commitId,
      entries: [{ path: "history.txt", op: "delete", version: 4, rollbackOf: null }],
    });
    await expect(
      createTestEnv()
        .env.DB.prepare(
          `SELECT f.head_version, f.deleted, v.blob_hash
         FROM files AS f JOIN versions AS v
           ON v.stash_name = f.stash_name AND v.path = f.path AND v.version = f.head_version
         WHERE f.stash_name = ? AND f.path = ?`,
        )
        .bind(stash, "history.txt")
        .first(),
    ).resolves.toEqual({ head_version: 4, deleted: 1, blob_hash: null });
  });

  it("restores the version preceding a multi-version import", async () => {
    const stash = "commit-revert-import-existing";
    await seedStash(stash);
    const bindings = createTestEnv().env;
    const seeded = await createStashStore(bindings, {
      now: () => 1_000,
      createId: () => "import-revert-base",
    }).writes.put(stash, "history.txt", {
      body: "before import",
      expectedVersion: null,
    });
    expect(seeded).toMatchObject({ ok: true, value: { version: 1 } });
    const imported = await request(
      app,
      `http://stash.test/v1/stashes/${stash}/import`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "history.txt",
          expectedVersion: 1,
          versions: [
            { kind: "put", body: "import two", createdAt: 1_001 },
            { kind: "delete", body: null, createdAt: 1_002 },
            { kind: "put", body: "import four", createdAt: 1_003 },
          ],
        }),
      },
      bindings,
    );
    expect(imported.status).toBe(201);
    const commit = await imported.json<{ commitId: string }>();

    const reverted = await api(
      stash,
      `/${commit.commitId}/revert`,
      { method: "POST", body: {} },
      bindings,
    );
    expect(reverted.status).toBe(201);
    await expect(reverted.json()).resolves.toMatchObject({
      source: "revert",
      revertsCommitId: commit.commitId,
      entries: [{ path: "history.txt", op: "rollback", version: 5, rollbackOf: 1 }],
    });
    await expect(
      bindings.DB.prepare(
        `SELECT f.head_version, f.deleted, b.body
         FROM files AS f
         JOIN versions AS v ON v.stash_name = f.stash_name AND v.path = f.path
           AND v.version = f.head_version
         LEFT JOIN blobs AS b ON b.stash_name = v.stash_name AND b.hash = v.blob_hash
         WHERE f.stash_name = ? AND f.path = ?`,
      )
        .bind(stash, "history.txt")
        .first(),
    ).resolves.toEqual({ head_version: 5, deleted: 0, body: "before import" });
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
