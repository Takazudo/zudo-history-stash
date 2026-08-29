import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { createStashStore } from "../../src/d1/store.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const STASH = "route-history";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

async function get(path: string, token = "test-admin"): Promise<Response> {
  return request(app, `${BASE}${path}`, { headers: bearer(token) });
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("file history route", () => {
  it("returns newest-first metadata without bodies and paginates with before", async () => {
    const store = createStashStore(createTestEnv().env);
    await store.writes.put(STASH, "docs/history.txt", {
      body: "ZHS_HISTORY_BODY_MUST_NOT_LEAK_ONE",
      expectedVersion: null,
      author: "alice",
      meta: { step: 1 },
    });
    await store.writes.put(STASH, "docs/history.txt", {
      body: "ZHS_HISTORY_BODY_MUST_NOT_LEAK_TWO",
      expectedVersion: 1,
      author: "bob",
      meta: { step: 2 },
    });
    await store.writes.rollback(STASH, "docs/history.txt", {
      expectedVersion: 2,
      toVersion: 1,
      author: "carol",
    });

    const first = await get("/history/docs/history.txt?limit=2");
    expect(first.status).toBe(200);
    const text = await first.text();
    expect(text).not.toContain("ZHS_HISTORY_BODY_MUST_NOT_LEAK");
    const firstPage = JSON.parse(text) as {
      path: string;
      headVersion: number;
      deleted: boolean;
      total: number;
      versions: {
        version: number;
        kind: string;
        rollbackOf: number | null;
        hash: string | null;
        size: number;
        author: string;
        message: string;
        meta: Record<string, unknown>;
        createdAt: string;
      }[];
      nextBefore: number | null;
    };
    expect(firstPage).toMatchObject({
      path: "docs/history.txt",
      headVersion: 3,
      deleted: false,
      total: 3,
      versions: [
        { version: 3, kind: "rollback", rollbackOf: 1 },
        { version: 2, kind: "put", rollbackOf: null },
      ],
      nextBefore: 2,
    });
    expect(firstPage.versions[0]).toMatchObject({
      version: 3,
      kind: "rollback",
      hash: expect.stringMatching(/^sha256-/),
      size: "ZHS_HISTORY_BODY_MUST_NOT_LEAK_ONE".length,
      rollbackOf: 1,
      author: "carol",
      message: "Rollback to v1",
      meta: {},
      createdAt: expect.stringMatching(/Z$/),
      representation: "text",
      contentAccess: "inline",
      contentType: "text/plain; charset=utf-8",
      byteSize: "ZHS_HISTORY_BODY_MUST_NOT_LEAK_ONE".length,
      etag: expect.stringMatching(/^sha256-/),
    });

    const second = await get(`/history/docs/history.txt?limit=2&before=${firstPage.nextBefore}`);
    await expect(second.json()).resolves.toMatchObject({
      total: 3,
      versions: [{ version: 1, kind: "put", rollbackOf: null }],
      nextBefore: null,
    });
  });

  it("reports tombstoned heads and rejects missing, invalid, and malformed queries", async () => {
    const store = createStashStore(createTestEnv().env);
    await store.writes.put(STASH, "deleted.txt", { body: "one", expectedVersion: null });
    await store.writes.delete(STASH, "deleted.txt", { expectedVersion: 1 });

    await expect((await get("/history/deleted.txt")).json()).resolves.toMatchObject({
      path: "deleted.txt",
      headVersion: 2,
      deleted: true,
      total: 2,
      versions: [
        { version: 2, kind: "delete", hash: null, size: 0 },
        { version: 1, kind: "put" },
      ],
      nextBefore: null,
    });

    await expectCode(await get("/history/missing.txt"), 404, "not-found");
    await expectCode(await get("/history/a%2F..%2Fb"), 400, "invalid-path");
    await expectCode(await get("/history/deleted.txt?limit=201"), 400, "validation");
    await expectCode(await get("/history/deleted.txt?before=0"), 400, "validation");
    await expectCode(await get("/history/deleted.txt?unknown=1"), 400, "validation");
  });
});

describe("per-stash changes route", () => {
  it("supports ascending since and descending before cursors with hasMore", async () => {
    const store = createStashStore(createTestEnv().env);
    const results = [
      await store.writes.put(STASH, "a.txt", { body: "a1", expectedVersion: null }),
      await store.writes.put(STASH, "b.txt", { body: "b1", expectedVersion: null }),
      await store.writes.put(STASH, "a.txt", { body: "a2", expectedVersion: 1 }),
      await store.writes.delete(STASH, "b.txt", { expectedVersion: 1 }),
    ];
    const ids = results.map((result) => {
      if (!result.ok || "unchanged" in result.value) throw new Error("fixture write failed");
      return result.value.changeId;
    });

    const ascending = await get("/changes?since=0&limit=2");
    const ascendingPage = await ascending.json<{
      changes: {
        changeId: number;
        stash: string;
        path: string;
        version: number;
        kind: string;
        author: string;
        message: string;
        size: number;
        createdAt: string;
      }[];
      nextSince: number | null;
      hasMore: boolean;
    }>();
    expect(ascendingPage).toEqual({
      changes: [
        expect.objectContaining({ changeId: ids[0], stash: STASH, path: "a.txt" }),
        expect.objectContaining({ changeId: ids[1], stash: STASH, path: "b.txt" }),
      ],
      nextSince: ids[1],
      hasMore: true,
    });
    expect(ascendingPage.changes[0]).toMatchObject({
      changeId: ids[0],
      stash: STASH,
      path: "a.txt",
      version: 1,
      kind: "put",
      author: "",
      message: "",
      size: 2,
      createdAt: expect.stringMatching(/Z$/),
      representation: "text",
      contentAccess: "inline",
      contentType: "text/plain; charset=utf-8",
      byteSize: 2,
      etag: expect.stringMatching(/^sha256-/),
    });
    const ascendingNext = await get(`/changes?since=${ascendingPage.nextSince}&limit=2`);
    await expect(ascendingNext.json()).resolves.toMatchObject({
      changes: [{ changeId: ids[2] }, { changeId: ids[3] }],
      nextSince: null,
      hasMore: false,
    });

    const descending = await get(`/changes?before=${(ids[3] ?? 0) + 1}&limit=2`);
    await expect(descending.json()).resolves.toMatchObject({
      changes: [{ changeId: ids[3] }, { changeId: ids[2] }],
      nextBefore: ids[2],
      hasMore: true,
    });
    const newest = await get("/changes?limit=2");
    await expect(newest.json()).resolves.toMatchObject({
      changes: [{ changeId: ids[3] }, { changeId: ids[2] }],
      nextBefore: ids[2],
      hasMore: true,
    });
  });

  it("validates mutually exclusive cursors, bounds, capability, and stash concealment", async () => {
    await expectCode(await get("/changes?since=1&before=2"), 400, "validation");
    await expectCode(await get("/changes?limit=201"), 400, "validation");
    await expectCode(await get("/changes?since=-1"), 400, "validation");

    const read = await mintToken(STASH, "read");
    expect((await get("/changes", read.token)).status).toBe(200);
    expect((await get("/history/missing.txt", read.token)).status).toBe(404);

    await seedStash("foreign-history");
    const foreign = await mintToken("foreign-history", "read");
    await expectCode(await get("/changes", foreign.token), 404, "not-found");
    await expectCode(await get("/history/missing.txt", foreign.token), 404, "not-found");
  });
});
