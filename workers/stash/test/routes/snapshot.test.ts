import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { SELECT_SNAPSHOT_FILES } from "../../src/d1/sql/reads.js";
import { request, resetDatabase, seedStash } from "../helpers/app.js";

const STASH = "route-snapshot";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-admin");
  return request(app, `${BASE}${path}`, { ...init, headers });
}

async function put(
  path: string,
  body: string,
  expectedVersion: number | null,
): Promise<{
  commitId: string;
  version: number;
  changeId: number;
}> {
  const response = await api(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, expectedVersion }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function deleteFile(
  path: string,
  expectedVersion: number,
): Promise<{ commitId: string; version: number; changeId: number }> {
  const response = await api(`/delete/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function createCommit(entries: Array<{ path: string; body: string }>): Promise<{
  id: string;
  firstChangeId: number;
  lastChangeId: number;
  entries: Array<{ changeId: number }>;
}> {
  const response = await api("/commits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entries: entries.map(({ path, body }) => ({ op: "put", path, expectedVersion: null, body })),
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function rollback(
  path: string,
  expectedVersion: number,
  toVersion: number,
): Promise<{ commitId: string }> {
  const response = await api(`/rollback/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion, toVersion }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function snapshotAt(at: string, query = ""): Promise<Response> {
  return api(`/snapshot?at=${encodeURIComponent(at)}${query}`);
}

async function snapshot(commitId: string, query = ""): Promise<Response> {
  return snapshotAt(`commit:${commitId}`, query);
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("snapshot route reads", () => {
  it("reconstructs state at every persisted commit, including rollback and late paths", async () => {
    const first = await put("docs/readme.txt", "one", null);
    const second = await put("docs/readme.txt", "two", 1);
    const third = await deleteFile("docs/readme.txt", 2);
    const fourth = await rollback("docs/readme.txt", 3, 1);
    const fifth = await put("late.txt", "late", null);

    const firstSnapshot = await snapshot(first.commitId);
    await expect(firstSnapshot.json()).resolves.toMatchObject({
      at: { commitId: first.commitId, changeId: expect.any(Number) },
      files: [{ path: "docs/readme.txt", headVersion: 1, deleted: false }],
      nextAfter: null,
    });

    const secondSnapshot = await snapshot(second.commitId);
    await expect(secondSnapshot.json()).resolves.toMatchObject({
      files: [{ path: "docs/readme.txt", headVersion: 2, deleted: false }],
    });

    const thirdSnapshot = await snapshot(third.commitId);
    await expect(thirdSnapshot.json()).resolves.toMatchObject({ files: [], nextAfter: null });
    const thirdWithDeleted = await snapshot(third.commitId, "&includeDeleted=true");
    await expect(thirdWithDeleted.json()).resolves.toMatchObject({
      files: [{ path: "docs/readme.txt", headVersion: 3, deleted: true, hash: null }],
    });
    const thirdWithDeletedAtChange = await snapshotAt(
      `change:${third.changeId}`,
      "&includeDeleted=true",
    );
    await expect(thirdWithDeletedAtChange.json()).resolves.toMatchObject({
      at: { commitId: third.commitId, changeId: third.changeId },
      files: [{ path: "docs/readme.txt", headVersion: 3, deleted: true, hash: null }],
    });

    const fourthSnapshot = await snapshot(fourth.commitId);
    await expect(fourthSnapshot.json()).resolves.toMatchObject({
      files: [{ path: "docs/readme.txt", headVersion: 4, deleted: false }],
    });

    const fifthSnapshot = await snapshot(fifth.commitId);
    await expect(fifthSnapshot.json()).resolves.toMatchObject({
      files: [
        { path: "docs/readme.txt", headVersion: 4, deleted: false },
        { path: "late.txt", headVersion: 1, deleted: false },
      ],
    });
  });

  it("floors change cursors to the previous sealed commit boundary", async () => {
    await put("one.txt", "one", null);
    const second = await put("two.txt", "two", null);
    const third = await createCommit([
      { path: "three.txt", body: "three" },
      { path: "four.txt", body: "four" },
    ]);

    expect(third.firstChangeId).toBe(second.changeId + 1);
    expect(third.lastChangeId).toBeGreaterThan(third.firstChangeId);

    const exact = await snapshotAt(`change:${second.changeId}`);
    expect(exact.status).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({
      at: { commitId: second.commitId, changeId: second.changeId },
    });

    const between = await snapshotAt(`change:${third.firstChangeId}`);
    expect(between.status).toBe(200);
    await expect(between.json()).resolves.toMatchObject({
      at: { commitId: second.commitId, changeId: second.changeId },
      files: [{ path: "one.txt" }, { path: "two.txt" }],
    });

    const aboveNewest = await snapshotAt(`change:${third.lastChangeId + 100}`);
    expect(aboveNewest.status).toBe(200);
    await expect(aboveNewest.json()).resolves.toMatchObject({
      at: { commitId: third.id, changeId: third.lastChangeId },
      files: [
        { path: "four.txt" },
        { path: "one.txt" },
        { path: "three.txt" },
        { path: "two.txt" },
      ],
    });

    const belowFirst = await snapshotAt("change:0");
    expect(belowFirst.status).toBe(404);
    await expect(belowFirst.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });

  it("returns 404 for a change cursor when the stash has no sealed commits", async () => {
    const response = await snapshotAt("change:1");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });

  it("applies prefix, delimiter, and keyset pagination to snapshot state", async () => {
    await put("site/a.css", "a", null);
    const second = await put("site/nested/b.css", "b", null);
    await put("site-old/x.css", "old", null);

    const bounded = await snapshot(second.commitId, "&prefix=site%2F");
    await expect(bounded.json()).resolves.toMatchObject({
      files: [{ path: "site/a.css" }, { path: "site/nested/b.css" }],
    });
    const boundedAtChange = await snapshotAt(`change:${second.changeId}`, "&prefix=site%2F");
    await expect(boundedAtChange.json()).resolves.toMatchObject({
      at: { commitId: second.commitId, changeId: second.changeId },
      files: [{ path: "site/a.css" }, { path: "site/nested/b.css" }],
    });

    const delimited = await snapshot(second.commitId, "&prefix=site%2F&delimiter=%2F");
    await expect(delimited.json()).resolves.toMatchObject({
      files: [{ path: "site/a.css" }],
      commonPrefixes: ["site/nested/"],
      nextAfter: null,
    });
    const delimitedAtChange = await snapshotAt(
      `change:${second.changeId}`,
      "&prefix=site%2F&delimiter=%2F",
    );
    await expect(delimitedAtChange.json()).resolves.toMatchObject({
      at: { commitId: second.commitId, changeId: second.changeId },
      files: [{ path: "site/a.css" }],
      commonPrefixes: ["site/nested/"],
      nextAfter: null,
    });

    const page = await snapshot(second.commitId, "&prefix=site%2F&limit=1");
    const body = await page.json<{ files: { path: string }[]; nextAfter: string | null }>();
    expect(body.files.map(({ path }) => path)).toEqual(["site/a.css"]);
    expect(body.nextAfter).toBe("site/a.css");
    const next = await snapshot(
      second.commitId,
      `&prefix=site%2F&limit=1&after=${encodeURIComponent(body.nextAfter ?? "")}`,
    );
    await expect(next.json()).resolves.toMatchObject({
      files: [{ path: "site/nested/b.css" }],
      nextAfter: null,
    });
    const nextAtChange = await snapshotAt(
      `change:${second.changeId}`,
      `&prefix=site%2F&limit=1&after=${encodeURIComponent(body.nextAfter ?? "")}`,
    );
    await expect(nextAtChange.json()).resolves.toMatchObject({
      at: { commitId: second.commitId, changeId: second.changeId },
      files: [{ path: "site/nested/b.css" }],
      nextAfter: null,
    });
  });

  it("conceals unknown and unsealed commits", async () => {
    const unknown = await snapshot("cmt_missing");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "not-found" } });

    await env.DB.prepare(
      `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
       VALUES ('cmt_unsealed', ?, 'put', 1, 'test', 1)`,
    )
      .bind(STASH)
      .run();
    const unsealed = await snapshot("cmt_unsealed");
    expect(unsealed.status).toBe(404);
    await expect(unsealed.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });

  it("uses the versions covering index for the correlated per-file seek", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${SELECT_SNAPSHOT_FILES}`)
      .bind(100, STASH, 0, null, null, null, null, null, null, null, 1)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    expect(details).toMatch(/SEARCH v USING COVERING INDEX .*versions/);
    expect(details).not.toMatch(/SCAN v/);
    expect(SELECT_SNAPSHOT_FILES).toContain("JOIN versions AS s");
    expect(SELECT_SNAPSHOT_FILES).toContain("SELECT v.id");
    expect(SELECT_SNAPSHOT_FILES).not.toMatch(/GROUP BY.*path/i);
  });
});
