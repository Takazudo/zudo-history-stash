import {
  BODY_LIMIT_BYTES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_BODY_BYTES,
  ROUTES,
  sha256Hex,
  type GcRunResult,
  type RouteId,
} from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { createStashClient } from "../../src/client.js";
import { parseStashEventStream } from "../../src/sse.js";
import {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  FAKE_SUPPORTED_ROUTE_IDS,
  createFakeStash,
} from "../../src/testing/index.js";
import type { FakeChangeSetRow } from "../../src/testing/types.js";

const ADMIN = "fake-admin";

function request(
  fake: ReturnType<typeof createFakeStash>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ADMIN}`);
  return fake.fetch(`https://fake.invalid${path}`, { ...init, headers });
}

async function errorCode(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { code?: unknown } };
  return body.error?.code;
}

const UNSUPPORTED_SAMPLES: Record<
  Exclude<RouteId, (typeof CONFORMANCE_SUPPORTED_ROUTE_IDS)[number]>,
  { method: string; path: string }
> = {
  health: { method: "GET", path: "/v1/health" },
  importHistory: { method: "POST", path: "/v1/stashes/demo/import" },
  listChanges: { method: "GET", path: "/v1/changes" },
};

const EMPTY_DIFF_ROUTES = [
  { method: "GET", path: "/v1/stashes/demo/diff", routeId: "getDiff" },
  { method: "GET", path: "/v1/stashes/demo/diff/", routeId: "getDiff" },
  { method: "POST", path: "/v1/stashes/demo/diff", routeId: "diffCandidate" },
  { method: "POST", path: "/v1/stashes/demo/diff/", routeId: "diffCandidate" },
] as const;

describe("fake route boundary", () => {
  it("pins the implementation and trace to the exact supported route set", () => {
    expect(new Set(FAKE_SUPPORTED_ROUTE_IDS)).toEqual(new Set(CONFORMANCE_SUPPORTED_ROUTE_IDS));
    expect(ROUTES.filter((route) => !FAKE_SUPPORTED_ROUTE_IDS.includes(route.id))).toHaveLength(
      Object.keys(UNSUPPORTED_SAMPLES).length,
    );
  });

  it.each(Object.entries(UNSUPPORTED_SAMPLES))(
    "returns documented 501 for unsupported %s",
    async (_routeId, sample) => {
      const fake = createFakeStash({ adminToken: ADMIN });
      const response = await request(fake, sample.path, { method: sample.method });
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "not-implemented" },
      });
    },
  );

  it("returns 501 for an unknown route rather than pretending to be a full server", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    const response = await request(fake, "/v1/not-a-real-route");
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe("not-implemented");
  });
});

describe("fake universal commit attribution", () => {
  it("matches Worker principal attribution for legacy writes and upload completion", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const writeToken = await fake.mintToken("demo", "write", { label: "writer" });
    const makeClient = (token: string) =>
      createStashClient({
        baseUrl: "https://fake.invalid",
        token,
        fetch: fake.fetch,
        idempotencyKey: () => crypto.randomUUID(),
      });
    const admin = makeClient(ADMIN);
    const writer = makeClient(writeToken);
    const me = await writer.me();
    expect(me).toMatchObject({ ok: true, value: { principal: "stash" } });
    if (!me.ok || me.value.principal !== "stash") throw new Error("Expected stash principal");

    const adminPut = await admin.files("demo").put("admin.txt", {
      body: "one",
      expectedVersion: null,
    });
    if (!adminPut.ok || "unchanged" in adminPut.value) throw new Error("Admin put failed");
    await expect(admin.commits("demo").get(adminPut.value.commitId)).resolves.toMatchObject({
      ok: true,
      value: { createdBy: "admin" },
    });

    const secondPut = await admin.files("demo").put("admin.txt", {
      body: "two",
      expectedVersion: 1,
    });
    if (!secondPut.ok) throw new Error("Second admin put failed");
    const rollback = await admin
      .files("demo")
      .rollback("admin.txt", { expectedVersion: 2, toVersion: 1 });
    if (!rollback.ok) throw new Error("Admin rollback failed");
    await expect(admin.commits("demo").get(rollback.value.commitId)).resolves.toMatchObject({
      ok: true,
      value: { createdBy: "admin" },
    });

    const tokenPut = await writer.files("demo").put("token.txt", {
      body: "token",
      expectedVersion: null,
    });
    if (!tokenPut.ok) throw new Error("Token put failed");
    const deleted = await writer.files("demo").delete("token.txt", { expectedVersion: 1 });
    if (!deleted.ok) throw new Error("Token delete failed");
    await expect(admin.commits("demo").get(deleted.value.commitId)).resolves.toMatchObject({
      ok: true,
      value: { createdBy: me.value.tokenId },
    });

    const uploaded = await writer.files("demo").upload("token.bin", new Uint8Array([0, 1, 2]), {
      expectedVersion: null,
      representation: "binary",
      contentType: "application/octet-stream",
      author: "upload author",
      message: "upload message",
      meta: { source: "session" },
    });
    if (!uploaded.ok || "unchanged" in uploaded.value) throw new Error("Token upload failed");
    await expect(admin.commits("demo").get(uploaded.value.commitId)).resolves.toMatchObject({
      ok: true,
      value: {
        author: "upload author",
        message: "upload message",
        meta: { source: "session" },
        createdBy: me.value.tokenId,
      },
    });
    await expect(admin.files("demo").history("token.bin")).resolves.toMatchObject({
      ok: true,
      value: {
        versions: [
          {
            author: "upload author",
            message: "upload message",
            meta: { source: "session" },
          },
        ],
      },
    });
  });

  it("preserves JSON upload attribution and rejects divergent session-create replay", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: ADMIN,
      fetch: fake.fetch,
      idempotencyKey: () => crypto.randomUUID(),
    });
    const uploaded = await client.files("demo").upload("json.txt", "json body", {
      expectedVersion: null,
      representation: "text",
      contentType: "text/plain",
      mode: "json",
      author: "json author",
      message: "json message",
      meta: { source: "json" },
    });
    expect(uploaded).toMatchObject({ ok: true });
    await expect(client.files("demo").history("json.txt")).resolves.toMatchObject({
      ok: true,
      value: {
        versions: [
          {
            author: "json author",
            message: "json message",
            meta: { source: "json" },
          },
        ],
      },
    });

    const create = (author: string) =>
      request(fake, "/v1/stashes/demo/uploads/session.bin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "fake-upload-create-attribution",
        },
        body: JSON.stringify({
          expectedVersion: null,
          size: 3,
          representation: "binary",
          contentType: "application/octet-stream",
          mode: "single",
          author,
        }),
      });
    const first = await create("first author");
    expect(first.status).toBe(201);
    const diverged = await create("different author");
    expect(diverged.status).toBe(422);
    expect(await errorCode(diverged)).toBe("idempotency-key-reused");
  });

  it("rejects a session-create replay with a different skip-if-unchanged flag", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const create = (skipIfUnchanged: boolean) =>
      request(fake, "/v1/stashes/demo/uploads/session.bin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "fake-upload-create-skip",
        },
        body: JSON.stringify({
          expectedVersion: null,
          size: 3,
          representation: "binary",
          contentType: "application/octet-stream",
          mode: "single",
          skipIfUnchanged,
        }),
      });
    const first = await create(false);
    expect(first.status).toBe(201);
    const diverged = await create(true);
    expect(diverged.status).toBe(422);
    expect(await errorCode(diverged)).toBe("idempotency-key-reused");
  });

  it("materializes text when identical binary bytes were stored first", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: ADMIN,
      fetch: fake.fetch,
      idempotencyKey: () => crypto.randomUUID(),
    });
    const bytesBase64 = btoa("same bytes");
    await expect(
      client.commits("demo").create({
        entries: [
          {
            op: "put",
            path: "binary.bin",
            expectedVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64,
          },
          {
            op: "put",
            path: "text.txt",
            expectedVersion: null,
            body: "same bytes",
            contentType: "text/plain",
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(client.files("demo").get("text.txt")).resolves.toMatchObject({
      ok: true,
      value: { representation: "text", body: "same bytes" },
    });
    await expect(client.files("demo").raw.get("binary.bin")).resolves.toMatchObject({ ok: true });
  });
});

describe("fake head-mode revert parity", () => {
  it("skips later tombstones consistently and rejects a mode-divergent replay", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: ADMIN,
      fetch: fake.fetch,
      idempotencyKey: () => crypto.randomUUID(),
    });
    const files = client.files("demo");
    const commits = client.commits("demo");
    await expect(
      files.put("updated.txt", { body: "before update", expectedVersion: null }),
    ).resolves.toMatchObject({ ok: true });
    const target = await commits.create({
      entries: [
        { op: "put", path: "created.txt", expectedVersion: null, body: "created" },
        { op: "put", path: "updated.txt", expectedVersion: 1, body: "after update" },
      ],
    });
    if (!target.ok) throw new Error("Head-mode revert target failed");
    await expect(
      commits.create({
        entries: [{ op: "delete", path: "created.txt", expectedVersion: 1 }],
      }),
    ).resolves.toMatchObject({ ok: true });

    const first = await commits.revert(
      target.value.id,
      { onto: "head" },
      { idempotencyKey: "fake-head-revert" },
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        entries: [{ path: "updated.txt", op: "rollback", version: 3, rollbackOf: 1 }],
        skipped: [{ path: "created.txt", reason: "already-deleted" }],
      },
    });
    const replayed = await commits.revert(
      target.value.id,
      { onto: "head" },
      { idempotencyKey: "fake-head-revert" },
    );
    expect(replayed).toEqual({ ...first, replayed: true });

    const modeTarget = await commits.create({
      entries: [{ op: "put", path: "mode.txt", expectedVersion: null, body: "mode" }],
    });
    if (!modeTarget.ok) throw new Error("Mode-divergence target failed");
    await expect(
      commits.revert(modeTarget.value.id, {}, { idempotencyKey: "fake-revert-mode" }),
    ).resolves.toMatchObject({ ok: true });
    const diverged = await commits.revert(
      modeTarget.value.id,
      { onto: "head" },
      { idempotencyKey: "fake-revert-mode" },
    );
    expect(diverged).toMatchObject({
      ok: false,
      error: { status: 422, code: "idempotency-key-reused" },
    });
  });
});

describe("fake snapshot cursors and commit diff ranges", () => {
  it("floors change snapshots to the resolved commit and keeps commit selectors working", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");

    const first = await request(fake, "/v1/stashes/demo/files/docs/first.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "first", expectedVersion: null }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { commitId: string; changeId: number };
    const batch = await request(fake, "/v1/stashes/demo/commits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { op: "put", path: "docs/second.txt", expectedVersion: null, body: "second" },
          { op: "put", path: "docs/third.txt", expectedVersion: null, body: "third" },
        ],
      }),
    });
    expect(batch.status).toBe(201);
    const batchBody = (await batch.json()) as { id: string };
    const firstCommit = fake.state.commits.get(firstBody.commitId);
    const batchCommit = fake.state.commits.get(batchBody.id);
    if (firstCommit === undefined || batchCommit === undefined) {
      throw new Error("missing snapshot commit fixture");
    }
    expect(batchCommit.firstChangeId).toBeGreaterThan(firstCommit.lastChangeId);

    const floored = await request(
      fake,
      `/v1/stashes/demo/snapshot?at=change:${batchCommit.firstChangeId}`,
    );
    expect(floored.status).toBe(200);
    await expect(floored.json()).resolves.toMatchObject({
      at: { commitId: firstCommit.id, changeId: firstCommit.lastChangeId },
      files: [{ path: "docs/first.txt" }],
    });

    const noCommit = await request(fake, "/v1/stashes/demo/snapshot?at=change:0");
    expect(noCommit.status).toBe(404);
    expect(await errorCode(noCommit)).toBe("not-found");

    const byCommit = await request(fake, `/v1/stashes/demo/snapshot?at=commit:${firstCommit.id}`);
    expect(byCommit.status).toBe(200);
    await expect(byCommit.json()).resolves.toMatchObject({
      at: { commitId: firstCommit.id, changeId: firstCommit.lastChangeId },
    });
  });

  it("collapses range versions, applies prefix filters, and validates range cursors", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");

    const put = async (path: string, body: string, expectedVersion: number | null) => {
      const response = await request(fake, `/v1/stashes/demo/files/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, expectedVersion }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { commitId: string; version: number };
    };

    const base = await put("docs/readme.txt", "before", null);
    await put("docs/readme.txt", "middle", 1);
    await put("other.txt", "unrelated", null);
    const target = await put("docs/readme.txt", "after", 2);

    const range = await request(
      fake,
      `/v1/stashes/demo/commits/${target.commitId}/diff?from=commit:${base.commitId}&prefix=docs`,
    );
    expect(range.status).toBe(200);
    await expect(range.json()).resolves.toMatchObject({
      truncated: false,
      entries: [
        {
          path: "docs/readme.txt",
          op: "put",
          from: { version: 1 },
          to: { version: 3 },
        },
      ],
    });

    const equal = await request(
      fake,
      `/v1/stashes/demo/commits/${target.commitId}/diff?from=commit:${target.commitId}`,
    );
    expect(equal.status).toBe(200);
    await expect(equal.json()).resolves.toEqual({ entries: [], truncated: false });

    const missing = await request(
      fake,
      `/v1/stashes/demo/commits/${target.commitId}/diff?from=commit:missing`,
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not-found");

    const newer = await request(
      fake,
      `/v1/stashes/demo/commits/${base.commitId}/diff?from=commit:${target.commitId}`,
    );
    expect(newer.status).toBe(400);
    await expect(newer.json()).resolves.toEqual({
      error: {
        code: "validation",
        message: "from must not be newer than the target commit.",
      },
    });
  });
});

describe("fake expected-last-change fences", () => {
  const put = async (fake: ReturnType<typeof createFakeStash>, path: string, body = path) => {
    const response = await request(fake, `/v1/stashes/demo/files/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, expectedVersion: null }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { changeId: number };
  };

  const createCommit = async (
    fake: ReturnType<typeof createFakeStash>,
    input: Record<string, unknown>,
  ) => {
    const path = typeof input.path === "string" ? input.path : "site/candidate.txt";
    const { path: _path, ...fence } = input;
    return request(fake, "/v1/stashes/demo/commits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [{ op: "put", path, expectedVersion: null, body: "candidate" }],
        ...fence,
      }),
    });
  };

  it("scopes commit fences by prefix while preserving whole-stash future strictness", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const site = await put(fake, "site/base.txt");
    await put(fake, "docs/base.txt");

    const scoped = await createCommit(fake, {
      expectedLastChangeId: site.changeId,
      expectedLastChangePrefix: "site",
    });
    expect(scoped.status).toBe(201);

    const prefixStale = await createCommit(fake, {
      path: "site/candidate-stale.txt",
      expectedLastChangeId: site.changeId,
      expectedLastChangePrefix: "site/",
    });
    expect(prefixStale.status).toBe(409);
    expect(await errorCode(prefixStale)).toBe("stale");

    const wholeFuture = await createCommit(fake, { path: "whole.txt", expectedLastChangeId: 100 });
    expect(wholeFuture.status).toBe(409);
    expect(await errorCode(wholeFuture)).toBe("stale");

    const prefixFuture = await createCommit(fake, {
      path: "site/future.txt",
      expectedLastChangeId: 100,
      expectedLastChangePrefix: "site",
    });
    expect(prefixFuture.status).toBe(201);

    const prefixWithoutId = await createCommit(fake, {
      path: "site/no-id.txt",
      expectedLastChangePrefix: "site",
    });
    expect(prefixWithoutId.status).toBe(400);
    expect(await errorCode(prefixWithoutId)).toBe("validation");

    const invalidPrefix = await createCommit(fake, {
      path: "site/invalid.txt",
      expectedLastChangeId: 0,
      expectedLastChangePrefix: "site//bad",
    });
    expect(invalidPrefix.status).toBe(400);
    expect(await errorCode(invalidPrefix)).toBe("invalid-path");
  });

  it("stores a change-set prefix and re-evaluates it at approval", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const site = await put(fake, "site/base.txt");
    await put(fake, "docs/base.txt");
    const created = await request(fake, "/v1/stashes/demo/change-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [{ op: "put", path: "site/review.txt", baseVersion: null, body: "review" }],
        expectedLastChangeId: site.changeId,
        expectedLastChangePrefix: "site/",
      }),
    });
    expect(created.status).toBe(201);
    const row = [...fake.state.changeSets.values()][0];
    expect(row?.expectedLastChangePrefix).toBe("site/");

    await put(fake, "docs/after.txt");
    const createdBody = (await created.json()) as { id: string };
    const approved = await request(fake, `/v1/stashes/demo/change-sets/${createdBody.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approved.status).toBe(200);

    const staleFake = createFakeStash({ adminToken: ADMIN });
    staleFake.createStash("demo");
    const staleSite = await put(staleFake, "site/base.txt");
    const staleCreated = await request(staleFake, "/v1/stashes/demo/change-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [{ op: "put", path: "site/review.txt", baseVersion: null, body: "review" }],
        expectedLastChangeId: staleSite.changeId,
        expectedLastChangePrefix: "site",
      }),
    });
    expect(staleCreated.status).toBe(201);
    await put(staleFake, "site/after.txt");
    const staleBody = (await staleCreated.json()) as { id: string };
    const refused = await request(
      staleFake,
      `/v1/stashes/demo/change-sets/${staleBody.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("commit-conflict");
    expect([...staleFake.state.changeSets.values()][0]?.status).toBe("open");
  });
});

describe("fake live events", () => {
  it("authenticates the route and emits replay followed by its authoritative ready checkpoint", async () => {
    const now = Date.parse("2026-08-28T01:02:03.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const token = await fake.mintToken("demo", "read");
    const created = await request(fake, "/v1/stashes/demo/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Stash-Client-Id": "before-connect" },
      body: JSON.stringify({ body: "a", expectedVersion: null }),
    });
    expect(created.status).toBe(201);

    const response = await fake.fetch("https://fake.invalid/v1/stashes/demo/events?since=0", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    if (response.body === null) throw new Error("missing fake event body");
    const iterator = parseStashEventStream(response.body)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        id: "1",
        event: {
          type: "change",
          changeId: 1,
          origin: null,
          path: "a.md",
          createdAt: "2026-08-28T01:02:03.000Z",
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { event: { type: "ready", head: 1, checkpoint: 1 } },
    });
    expect(fake.events.subscriberCount("demo")).toBe(1);

    fake.events.emit("demo", { type: "ready", head: 1, checkpoint: 1 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: { type: "ready" } } });
    fake.events.rotate("demo", "replay-limit");
    await expect(iterator.next()).resolves.toMatchObject({
      value: { event: { type: "reconnect", reason: "replay-limit" } },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(fake.events.subscriberCount("demo")).toBe(0);

    expect((await fake.fetch("https://fake.invalid/v1/stashes/demo/events")).status).toBe(401);
    expect(
      (
        await fake.fetch("https://fake.invalid/v1/stashes/demo/events?since=-1", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
  });

  it("supports clean close, body failure, cancellation, and reset with one stable controller", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    const events = fake.events;
    fake.createStash("demo");

    const clean = await request(fake, "/v1/stashes/demo/events");
    if (clean.body === null) throw new Error("missing clean event body");
    const cleanIterator = parseStashEventStream(clean.body)[Symbol.asyncIterator]();
    await cleanIterator.next();
    fake.events.close("demo");
    await expect(cleanIterator.next()).resolves.toEqual({ done: true, value: undefined });

    const failed = await request(fake, "/v1/stashes/demo/events");
    if (failed.body === null) throw new Error("missing failed event body");
    const failedIterator = parseStashEventStream(failed.body)[Symbol.asyncIterator]();
    await failedIterator.next();
    fake.events.error("demo", new TypeError("offline"));
    await expect(failedIterator.next()).rejects.toThrow("stash event stream could not be decoded");
    expect(fake.events.subscriberCount("demo")).toBe(0);

    const cancelled = await request(fake, "/v1/stashes/demo/events");
    expect(fake.events.subscriberCount("demo")).toBe(1);
    await cancelled.body?.cancel();
    expect(fake.events.subscriberCount("demo")).toBe(0);

    const resetResponse = await request(fake, "/v1/stashes/demo/events");
    if (resetResponse.body === null) throw new Error("missing reset event body");
    const reader = resetResponse.body.getReader();
    await reader.read();
    fake.reset();
    expect(fake.events).toBe(events);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(fake.events.subscriberCount("demo")).toBe(0);
  });

  it("drops a non-canonical identity supplied by a raw fake mutation request", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const response = await request(fake, "/v1/stashes/demo/events");
    if (response.body === null) throw new Error("missing fake event body");
    const iterator = parseStashEventStream(response.body)[Symbol.asyncIterator]();
    await iterator.next();

    const created = await request(fake, "/v1/stashes/demo/files/raw.md", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "raw-invalid-origin",
        "X-Stash-Client-Id": "x".repeat(65),
      },
      body: JSON.stringify({ body: "raw", expectedVersion: null }),
    });
    expect(created.status).toBe(201);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { event: { type: "change", path: "raw.md", origin: null } },
    });
    await iterator.return?.();
    expect(fake.events.subscriberCount("demo")).toBe(0);
  });
});

describe("inspectable state and fixture helpers", () => {
  it("exposes each table and reset clears them without replacing state", async () => {
    const fake = createFakeStash({ adminToken: ADMIN, now: () => 1_700_000_000_000 });
    const exposed = fake.state;
    expect(fake.createStash("demo")).toBe("demo");
    const token = await fake.mintToken("demo", "write");

    const response = await fake.fetch("https://fake.invalid/v1/stashes/demo/files/a.txt", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "fixture",
      },
      body: JSON.stringify({ body: "hello", expectedVersion: null }),
    });
    expect(response.status).toBe(201);
    expect(exposed.stashes.size).toBe(1);
    expect(exposed.tokens.size).toBe(1);
    expect(exposed.blobs.get("demo")?.size).toBe(1);
    expect(exposed.r2Objects.size).toBe(0);
    expect(exposed.files.get("demo")?.size).toBe(1);
    expect(exposed.versions).toHaveLength(1);
    expect(exposed.commits.size).toBe(1);
    expect(exposed.idempotency.get("demo")?.size).toBe(1);

    fake.reset();
    expect(fake.state).toBe(exposed);
    expect(exposed.stashes.size).toBe(0);
    expect(exposed.tokens.size).toBe(0);
    expect(exposed.blobs.size).toBe(0);
    expect(exposed.r2Objects.size).toBe(0);
    expect(exposed.files.size).toBe(0);
    expect(exposed.versions).toHaveLength(0);
    expect(exposed.commits.size).toBe(0);
    expect(exposed.changeSets.size).toBe(0);
    expect(exposed.idempotency.size).toBe(0);
    expect(exposed.gcJobs.get("r2-orphans")).toMatchObject({
      nextCursor: null,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseUntil: null,
    });
    expect(exposed.gcRuns).toHaveLength(0);
  });
});

describe("stash administration routes", () => {
  it("creates, gets, and keyset-paginates strict stash records", async () => {
    const timestamp = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    const alpha = await request(fake, "/v1/stashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "alpha",
        description: "Alpha stash",
        meta: { owner: "viewer" },
      }),
    });
    expect(alpha.status).toBe(201);
    await expect(alpha.json()).resolves.toEqual({
      name: "alpha",
      description: "Alpha stash",
      meta: { owner: "viewer" },
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    });
    fake.createStash("beta");
    fake.createStash("gamma");

    const first = await request(fake, "/v1/stashes?limit=1");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      stashes: [
        {
          name: "alpha",
          description: "Alpha stash",
          fileCount: 0,
          deletedFileCount: 0,
          lastChangeId: null,
          lastChangeAt: null,
          createdAt: "2026-08-26T00:00:00.000Z",
          deletedAt: null,
          restoreUntil: null,
          restorable: false,
        },
      ],
      nextAfter: "alpha",
    });
    const second = await request(fake, "/v1/stashes?limit=1&after=alpha");
    await expect(second.json()).resolves.toMatchObject({
      stashes: [{ name: "beta" }],
      nextAfter: "beta",
    });

    const detail = await request(fake, "/v1/stashes/alpha");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      name: "alpha",
      meta: { owner: "viewer" },
    });
    const duplicate = await request(fake, "/v1/stashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("exists");
  });

  it("validates admin inputs and reports missing stashes without leaking access", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    const missing = await request(fake, "/v1/stashes/missing");
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not-found");

    for (const path of ["/v1/stashes?limit=201", "/v1/stashes?unexpected=true"]) {
      const invalid = await request(fake, path);
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("validation");
    }

    const unauthenticated = await fake.fetch("https://fake.invalid/v1/stashes");
    expect(unauthenticated.status).toBe(401);
    expect(await errorCode(unauthenticated)).toBe("unauthorized");
  });

  it("soft-deletes, conceals, restores at the grace boundary, and never recycles names", async () => {
    let now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const readToken = await fake.mintToken("demo", "read");
    const writeToken = await fake.mintToken("demo", "write");

    const deleted = await request(fake, "/v1/stashes/demo", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      name: string;
      deletedAt: string;
      revokedTokens: number;
      restoreUntil: string;
    };
    expect(deletedBody).toEqual({
      name: "demo",
      deletedAt: "2026-08-26T00:00:00.000Z",
      revokedTokens: 2,
      restoreUntil: "2026-09-25T00:00:00.000Z",
    });
    expect(fake.state.stashes.get("demo")?.deletedAt).toBe(now);
    expect([...fake.state.tokens.values()].every((token) => token.revokedAt === now)).toBe(true);

    const hiddenList = await request(fake, "/v1/stashes");
    expect(hiddenList.status).toBe(200);
    await expect(hiddenList.json()).resolves.toEqual({ stashes: [], nextAfter: null });
    const included = await request(fake, "/v1/stashes?includeDeleted=true");
    await expect(included.json()).resolves.toMatchObject({
      stashes: [{ name: "demo", deletedAt: deletedBody.deletedAt, restorable: true }],
    });
    const hiddenDetail = await request(fake, "/v1/stashes/demo");
    expect(hiddenDetail.status).toBe(200);
    await expect(hiddenDetail.json()).resolves.toMatchObject({
      name: "demo",
      deletedAt: deletedBody.deletedAt,
      restoreUntil: deletedBody.restoreUntil,
      restorable: true,
    });

    for (const path of ["/v1/stashes/demo/files/a.txt", "/v1/stashes/demo/tokens"]) {
      const concealed = await request(fake, path);
      expect(concealed.status).toBe(404);
      expect(await errorCode(concealed)).toBe("not-found");
    }
    for (const token of [readToken, writeToken]) {
      const rejected = await fake.fetch("https://fake.invalid/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(rejected.status).toBe(401);
      expect(await errorCode(rejected)).toBe("unauthorized");
    }

    const restored = await request(fake, "/v1/stashes/demo/restore", { method: "POST" });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      name: "demo",
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    });
    const stillRevoked = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect(stillRevoked.status).toBe(401);
    const replacement = await fake.mintToken("demo", "read");
    expect(replacement).toMatch(/^zhs_/);
    const duplicate = await request(fake, "/v1/stashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("exists");

    fake.createStash("boundary");
    now += 1;
    const boundaryDelete = await request(fake, "/v1/stashes/boundary", { method: "DELETE" });
    expect(boundaryDelete.status).toBe(200);
    const restoreUntil = now + 30 * 86_400_000;
    now = restoreUntil - 1;
    expect((await request(fake, "/v1/stashes/boundary/restore", { method: "POST" })).status).toBe(
      200,
    );
    const secondDelete = await request(fake, "/v1/stashes/boundary", { method: "DELETE" });
    expect(secondDelete.status).toBe(200);
    now = restoreUntil + 30 * 86_400_000;
    const expiredRestore = await request(fake, "/v1/stashes/boundary/restore", { method: "POST" });
    expect(expiredRestore.status).toBe(404);
    expect(await errorCode(expiredRestore)).toBe("not-found");
  });

  it("runs dry GC pages without mutation, uses UUID page runs, and reports busy leases", async () => {
    let now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const old = now - 900_001;
    const hashA = `sha256-${"a".repeat(64)}`;
    const hashB = `sha256-${"b".repeat(64)}`;
    fake.state.blobs.set(
      "demo",
      new Map([
        [hashA, { stash: "demo", hash: hashA, body: "a", r2Key: null, size: 1, createdAt: old }],
        [hashB, { stash: "demo", hash: hashB, body: "b", r2Key: null, size: 1, createdAt: old }],
      ]),
    );
    const keyA = `v2/demo/${hashA}/00000000-0000-4000-8000-000000000001`;
    const keyB = `v2/demo/${hashB}/00000000-0000-4000-8000-000000000002`;
    fake.state.r2Objects.set(keyA, {
      key: keyA,
      stash: "demo",
      hash: hashA,
      size: 1,
      createdAt: old,
    });
    fake.state.r2Objects.set(keyB, {
      key: keyB,
      stash: "demo",
      hash: hashB,
      size: 1,
      createdAt: old,
    });
    const before = Array.from(fake.state.blobs.get("demo")?.keys() ?? []);
    const beforeR2 = Array.from(fake.state.r2Objects.keys());
    const first = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", dryRun: true, maxObjects: 1 }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      runId: string;
      jobId: string;
      kind: string;
      dryRun: boolean;
      scanned: number;
      eligible: number;
      deleted: number;
      cursor: string | null;
      finishedAt: string | null;
    };
    expect(firstBody).toMatchObject({
      jobId: "r2-orphans",
      kind: "r2-orphans",
      dryRun: true,
      scanned: 1,
      eligible: 1,
      deleted: 0,
    });
    expect(firstBody.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstBody.finishedAt).toBe("2026-08-26T00:00:00.000Z");
    expect(firstBody.cursor).toEqual(expect.any(String));
    expect(Array.from(fake.state.blobs.get("demo")?.keys() ?? [])).toEqual(before);
    expect(Array.from(fake.state.r2Objects.keys())).toEqual(beforeR2);
    expect(fake.state.gcJobs.get("r2-orphans")?.nextCursor).toBeNull();

    const second = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "r2-orphans",
        dryRun: true,
        maxObjects: 1,
        cursor: firstBody.cursor,
      }),
    });
    const secondBody = (await second.json()) as typeof firstBody;
    expect(second.status).toBe(200);
    expect(secondBody.runId).not.toBe(firstBody.runId);
    expect(secondBody.scanned).toBe(1);
    expect(secondBody.cursor).toBeNull();
    expect(Array.from(fake.state.blobs.get("demo")?.keys() ?? [])).toEqual(before);
    expect(Array.from(fake.state.r2Objects.keys())).toEqual(beforeR2);

    const nonDry = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", maxObjects: 500 }),
    });
    expect(nonDry.status).toBe(200);
    const nonDryBody = (await nonDry.json()) as {
      runId: string;
      deleted: number;
      cursor: string | null;
    };
    expect(nonDryBody).toMatchObject({
      jobId: "r2-orphans",
      kind: "r2-orphans",
      dryRun: false,
      deleted: 2,
      cursor: null,
    });
    expect(fake.state.blobs.get("demo")?.size).toBe(2);
    expect(fake.state.r2Objects.size).toBe(0);

    const job = fake.state.gcJobs.get("ledger");
    if (job === undefined) throw new Error("missing ledger fake job");
    job.leaseOwner = "held-by-fixture";
    job.leaseUntil = now + 1;
    const busy = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ledger", dryRun: true }),
    });
    expect(busy.status).toBe(409);
    expect(await errorCode(busy)).toBe("gc-busy");
    now += 1;
    const available = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ledger", dryRun: true }),
    });
    expect(available.status).toBe(200);
    const runs = await request(fake, "/v1/admin/gc/runs?kind=r2-orphans&limit=200");
    expect(runs.status).toBe(200);
    const runRows = (await runs.json()) as { runs: Array<{ runId: string; kind: string }> };
    expect(runRows.runs.length).toBe(3);
    expect(runRows.runs.every((run) => run.kind === "r2-orphans")).toBe(true);
    expect(runRows.runs[0]?.runId).toBe(nonDryBody.runId);
  });

  it("caps R2 pages at 24 and continues without skipping while ledger keeps its limit", async () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const old = now - 900_001;
    const objectKeys = Array.from({ length: 25 }, (_, index) => {
      const hash = `sha256-${String(index).padStart(2, "0")}${"a".repeat(62)}`;
      return `v2/demo/${hash}/00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    });
    fake.state.blobs.set(
      "demo",
      new Map(
        objectKeys.map((key, index) => {
          const hash = key.split("/")[2] ?? "";
          return [
            hash,
            {
              stash: "demo",
              hash,
              body: String(index),
              r2Key: null,
              size: 1,
              createdAt: old,
            },
          ];
        }),
      ),
    );
    const ledgerRows = new Map();
    for (const [index, key] of objectKeys.entries()) {
      const hash = key.split("/")[2] ?? "";
      fake.state.r2Objects.set(key, {
        key,
        stash: "demo",
        hash,
        size: 1,
        createdAt: old,
      });
      const ledgerKey = `ledger-${String(index).padStart(2, "0")}`;
      ledgerRows.set(ledgerKey, {
        stash: "demo",
        key: ledgerKey,
        requestHash: `request-${String(index)}`,
        path: `docs/${String(index)}.txt`,
        version: 1,
        statusCode: 200,
        createdAt: old,
      });
    }
    fake.state.idempotency.set("demo", ledgerRows);
    const logicalBefore = JSON.stringify([...fake.state.blobs.entries()]);

    const dryFirst = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", dryRun: true, maxObjects: 500 }),
    });
    expect(dryFirst.status).toBe(200);
    const dryFirstBody = (await dryFirst.json()) as {
      runId: string;
      scanned: number;
      eligible: number;
      deleted: number;
      cursor: string | null;
    };
    expect(dryFirstBody).toMatchObject({ scanned: 24, eligible: 24, deleted: 0 });
    expect(dryFirstBody.cursor).toEqual(expect.any(String));
    expect(fake.state.gcJobs.get("r2-orphans")?.nextCursor).toBeNull();
    expect([...fake.state.r2Objects.keys()]).toEqual(objectKeys);

    const dryContinuation = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "r2-orphans",
        dryRun: true,
        maxObjects: 500,
        cursor: dryFirstBody.cursor,
      }),
    });
    expect(dryContinuation.status).toBe(200);
    await expect(dryContinuation.json()).resolves.toMatchObject({
      scanned: 1,
      eligible: 1,
      deleted: 0,
      cursor: null,
    });
    expect(fake.state.r2Objects.size).toBe(25);
    expect(JSON.stringify([...fake.state.blobs.entries()])).toBe(logicalBefore);

    const nonDryFirst = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", maxObjects: 500 }),
    });
    expect(nonDryFirst.status).toBe(200);
    const nonDryFirstBody = (await nonDryFirst.json()) as {
      runId: string;
      scanned: number;
      deleted: number;
      cursor: string | null;
    };
    expect(nonDryFirstBody).toMatchObject({ scanned: 24, deleted: 24 });
    expect(nonDryFirstBody.cursor).toEqual(expect.any(String));
    expect(nonDryFirstBody.runId).not.toBe(dryFirstBody.runId);
    expect([...fake.state.r2Objects.keys()]).toEqual([objectKeys[24]]);

    const nonDryContinuation = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "r2-orphans",
        maxObjects: 500,
        cursor: nonDryFirstBody.cursor,
      }),
    });
    expect(nonDryContinuation.status).toBe(200);
    const nonDryContinuationBody = (await nonDryContinuation.json()) as {
      runId: string;
      scanned: number;
      deleted: number;
      cursor: string | null;
    };
    expect(nonDryContinuationBody).toMatchObject({
      scanned: 1,
      deleted: 1,
      cursor: null,
    });
    expect(nonDryContinuationBody.runId).not.toBe(nonDryFirstBody.runId);
    expect(nonDryFirstBody.scanned + nonDryContinuationBody.scanned).toBe(25);
    expect(nonDryFirstBody.deleted + nonDryContinuationBody.deleted).toBe(25);
    expect(fake.state.r2Objects.size).toBe(0);
    expect(JSON.stringify([...fake.state.blobs.entries()])).toBe(logicalBefore);

    const ledger = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ledger", dryRun: true, maxObjects: 500 }),
    });
    expect(ledger.status).toBe(200);
    await expect(ledger.json()).resolves.toMatchObject({
      scanned: 25,
      eligible: 0,
      deleted: 0,
      cursor: null,
    });
  });

  it("reclaims past-retention change sets while retaining recent and applied rows", async () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const retentionWindow = 900_000;
    const changeSet = (
      id: string,
      overrides: Pick<FakeChangeSetRow, "status" | "expiresAt" | "decidedAt">,
    ): FakeChangeSetRow => ({
      id,
      stash: "demo",
      status: "open",
      author: "fixture",
      message: "fixture",
      meta: {},
      expiresAt: now,
      createdBy: "fixture",
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      commitId: null,
      expectedLastChangeId: null,
      expectedLastChangePrefix: null,
      idempotencyKey: null,
      requestHash: null,
      entries: [],
      ...overrides,
    });
    const rows = [
      changeSet("chs_0000000000001aaaaaaaa", {
        expiresAt: now - retentionWindow - 1,
        decidedAt: null,
        status: "open",
      }),
      changeSet("chs_0000000000002aaaaaaaa", {
        expiresAt: now + 86_400_000,
        decidedAt: now - retentionWindow - 1,
        status: "rejected",
      }),
      changeSet("chs_0000000000003aaaaaaaa", {
        expiresAt: now - retentionWindow + 1,
        decidedAt: null,
        status: "open",
      }),
      changeSet("chs_0000000000004aaaaaaaa", {
        expiresAt: now + 86_400_000,
        decidedAt: now - retentionWindow + 1,
        status: "rejected",
      }),
      changeSet("chs_0000000000005aaaaaaaa", {
        expiresAt: now - retentionWindow - 1,
        decidedAt: now - retentionWindow - 1,
        status: "applied",
      }),
    ];
    for (const row of rows) fake.state.changeSets.set(row.id, row);

    const first = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "change-sets", maxObjects: 2 }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      scanned: number;
      eligible: number;
      deleted: number;
      cursor: string | null;
    };
    expect(firstBody).toMatchObject({ scanned: 2, eligible: 2, deleted: 2 });
    expect(firstBody.cursor).toEqual(expect.any(String));
    expect(fake.state.changeSets.has(rows[0]!.id)).toBe(false);
    expect(fake.state.changeSets.has(rows[1]!.id)).toBe(false);

    const second = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "change-sets", maxObjects: 500, cursor: firstBody.cursor }),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      scanned: 3,
      eligible: 0,
      deleted: 0,
      cursor: null,
    });
    expect([...fake.state.changeSets.keys()]).toEqual(rows.slice(2).map(({ id }) => id));
  });

  it("validates opaque cursors, uses a strict age boundary, and preserves logical history", async () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const minAge = 900_000;
    const boundary = now - minAge;
    const old = now - minAge - 1;
    const boundaryHash = `sha256-${"c".repeat(64)}`;
    const referencedHash = `sha256-${"d".repeat(64)}`;
    const orphanHash = `sha256-${"e".repeat(64)}`;
    const boundaryKey = `v2/demo/${boundaryHash}/00000000-0000-4000-8000-000000000003`;
    const referencedKey = `v2/demo/${referencedHash}/00000000-0000-4000-8000-000000000004`;
    const losingGenerationKey = `v2/demo/${referencedHash}/00000000-0000-4000-8000-000000000006`;
    const orphanKey = `v2/demo/${orphanHash}/00000000-0000-4000-8000-000000000005`;
    const malformedKey = "third-party/demo/orphan";
    fake.state.blobs.set(
      "demo",
      new Map([
        [
          boundaryHash,
          {
            stash: "demo",
            hash: boundaryHash,
            body: "boundary",
            r2Key: null,
            size: 8,
            createdAt: boundary,
          },
        ],
        [
          referencedHash,
          {
            stash: "demo",
            hash: referencedHash,
            body: "referenced",
            r2Key: referencedKey,
            size: 10,
            createdAt: old,
          },
        ],
        [
          orphanHash,
          { stash: "demo", hash: orphanHash, body: "orphan", r2Key: null, size: 6, createdAt: old },
        ],
      ]),
    );
    fake.state.versions.push({
      changeId: 1,
      commitId: "cmt_fixture",
      stash: "demo",
      path: "referenced.txt",
      version: 1,
      kind: "put",
      hash: referencedHash,
      size: 10,
      contentType: "text/plain",
      rollbackOf: null,
      author: "fixture",
      message: "fixture",
      meta: {},
      createdAt: old,
    });
    fake.state.r2Objects.set(boundaryKey, {
      key: boundaryKey,
      stash: "demo",
      hash: boundaryHash,
      size: 8,
      createdAt: boundary,
    });
    fake.state.r2Objects.set(referencedKey, {
      key: referencedKey,
      stash: "demo",
      hash: referencedHash,
      size: 10,
      createdAt: old,
    });
    fake.state.r2Objects.set(losingGenerationKey, {
      key: losingGenerationKey,
      stash: "demo",
      hash: referencedHash,
      size: 10,
      createdAt: old,
    });
    fake.state.r2Objects.set(orphanKey, {
      key: orphanKey,
      stash: "demo",
      hash: orphanHash,
      size: 6,
      createdAt: old,
    });
    fake.state.r2Objects.set(malformedKey, {
      key: malformedKey,
      stash: "demo",
      hash: orphanHash,
      size: 6,
      createdAt: old,
    });
    expect(fake.state.blobs.get("demo")?.get(referencedHash)?.r2Key).toBe(referencedKey);
    expect(fake.state.r2Objects.has(losingGenerationKey)).toBe(true);
    const logicalBefore = JSON.stringify({
      blobs: [...(fake.state.blobs.get("demo")?.entries() ?? [])],
      versions: fake.state.versions,
    });
    const r2JobBefore = { ...fake.state.gcJobs.get("r2-orphans") };

    const malformed = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", dryRun: true, cursor: "not-a-fake-cursor" }),
    });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("validation");
    expect(fake.state.gcRuns).toHaveLength(0);
    expect(fake.state.gcJobs.get("r2-orphans")).toEqual(r2JobBefore);

    const first = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", dryRun: true, maxObjects: 2 }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      cursor: string | null;
      scanned: number;
      eligible: number;
    };
    expect(firstBody).toMatchObject({ scanned: 2, eligible: 0 });
    expect(firstBody.cursor).toEqual(expect.any(String));
    const ledgerJobBefore = { ...fake.state.gcJobs.get("ledger") };

    const mismatch = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "ledger", dryRun: true, cursor: firstBody.cursor }),
    });
    expect(mismatch.status).toBe(400);
    expect(await errorCode(mismatch)).toBe("validation");
    expect(fake.state.gcRuns).toHaveLength(1);
    expect(fake.state.gcJobs.get("ledger")).toEqual(ledgerJobBefore);

    const second = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "r2-orphans",
        dryRun: true,
        maxObjects: 2,
        cursor: firstBody.cursor,
      }),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ scanned: 2, eligible: 1, deleted: 0 });
    expect(
      JSON.stringify({
        blobs: [...(fake.state.blobs.get("demo")?.entries() ?? [])],
        versions: fake.state.versions,
      }),
    ).toBe(logicalBefore);

    const nonDry = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", maxObjects: 500 }),
    });
    expect(nonDry.status).toBe(200);
    await expect(nonDry.json()).resolves.toMatchObject({ eligible: 2, deleted: 2, cursor: null });
    expect(fake.state.r2Objects.has(orphanKey)).toBe(false);
    expect(fake.state.r2Objects.has(losingGenerationKey)).toBe(false);
    expect(fake.state.r2Objects.has(boundaryKey)).toBe(true);
    expect(fake.state.r2Objects.has(referencedKey)).toBe(true);
    expect(fake.state.r2Objects.has(malformedKey)).toBe(true);
    expect(
      JSON.stringify({
        blobs: [...(fake.state.blobs.get("demo")?.entries() ?? [])],
        versions: fake.state.versions,
      }),
    ).toBe(logicalBefore);

    const historyFake = createFakeStash({ adminToken: ADMIN });
    const makeRun = (kind: "r2-orphans" | "ledger", index: number): GcRunResult => {
      const startedAt = new Date(1_700_000_000_000 + index).toISOString();
      return {
        runId: `${kind}-${String(index).padStart(3, "0")}`,
        jobId: kind,
        kind,
        dryRun: true,
        scanned: 0,
        eligible: 0,
        deleted: 0,
        cursor: null,
        startedAt,
        finishedAt: startedAt,
        error: null,
      };
    };
    historyFake.state.gcRuns.push(
      ...Array.from({ length: 501 }, (_, index) => makeRun("r2-orphans", index)),
      ...Array.from({ length: 501 }, (_, index) => makeRun("ledger", index)),
    );
    const recent = await request(historyFake, "/v1/admin/gc/runs?kind=r2-orphans&limit=200");
    expect(recent.status).toBe(200);
    expect(historyFake.state.gcRuns.filter((run) => run.kind === "r2-orphans")).toHaveLength(500);
    expect(historyFake.state.gcRuns.filter((run) => run.kind === "ledger")).toHaveLength(500);
    expect(historyFake.state.gcRuns.some((run) => run.runId === "r2-orphans-000")).toBe(false);
    expect(historyFake.state.gcRuns.some((run) => run.runId === "ledger-000")).toBe(false);
    const recentRows = (await recent.json()) as { runs: Array<{ runId: string }> };
    expect(recentRows.runs.some((run) => run.runId === "r2-orphans-500")).toBe(true);
  });
});

describe("fake change-set ordering", () => {
  it("canonicalizes stored and public entries by path like the D1 Worker", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const created = await request(fake, "/v1/stashes/demo/change-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { op: "put", path: "sdk/review.txt", baseVersion: null, body: "review\n" },
          {
            op: "put",
            path: "sdk/review.bin",
            baseVersion: null,
            representation: "binary",
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      entries: Array<{ path: string }>;
    };
    expect(createdBody.entries.map(({ path }) => path)).toEqual([
      "sdk/review.bin",
      "sdk/review.txt",
    ]);
    expect([...fake.state.changeSets.values()][0]?.entries.map(({ path }) => path)).toEqual([
      "sdk/review.bin",
      "sdk/review.txt",
    ]);

    const diff = await request(fake, `/v1/stashes/demo/change-sets/${createdBody.id}/diff`);
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { entries: Array<{ path: string }> };
    expect(diffBody.entries.map(({ path }) => path)).toEqual(["sdk/review.bin", "sdk/review.txt"]);
  });

  it("rejects divergent change-set create replays with 422", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const create = (message: string) =>
      request(fake, "/v1/stashes/demo/change-sets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "fake-change-set-create",
        },
        body: JSON.stringify({
          entries: [{ op: "put", path: "review.txt", baseVersion: null, body: "review" }],
          message,
        }),
      });

    const first = await create("first message");
    expect(first.status).toBe(201);
    const diverged = await create("different message");
    expect(diverged.status).toBe(422);
    expect(await errorCode(diverged)).toBe("idempotency-key-reused");
  });
});

describe("token administration and capabilities", () => {
  it("stores only hashes, lists newest first, and resolves read/write principals", async () => {
    let timestamp = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    fake.createStash("demo");
    fake.createStash("foreign");
    const create = async (label: string, scope: "read" | "write") => {
      const response = await request(fake, "/v1/stashes/demo/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, scope }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as {
        id: string;
        token: string;
        label: string;
        scope: "read" | "write";
        createdAt: string;
      };
    };

    const reader = await create("Reader", "read");
    timestamp += 1;
    const writer = await create("Writer", "write");
    expect(reader.id).toMatch(/^tok_[0-9a-f]{32}$/);
    expect(reader.token).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);
    const storedReader = fake.state.tokens.get(reader.id);
    expect(storedReader?.tokenHash).toBe((await sha256Hex(reader.token)).slice("sha256-".length));
    expect(storedReader?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...fake.state.tokens.values()])).not.toContain(reader.token);

    const listed = await request(fake, "/v1/stashes/demo/tokens");
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { tokens: Array<Record<string, unknown>> };
    expect(listedBody).toEqual({
      tokens: [
        {
          id: writer.id,
          label: "Writer",
          scope: "write",
          createdAt: writer.createdAt,
          expiresAt: null,
          rotatedFrom: null,
          rotatedTo: null,
          revokedAt: null,
          lastUsedAt: null,
        },
        {
          id: reader.id,
          label: "Reader",
          scope: "read",
          createdAt: reader.createdAt,
          expiresAt: null,
          rotatedFrom: null,
          rotatedTo: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    });
    expect(JSON.stringify(listedBody)).not.toContain(reader.token);
    expect(JSON.stringify(listedBody)).not.toContain("tokenHash");

    const asToken = (token: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fake.fetch(`https://fake.invalid${path}`, { ...init, headers });
    };
    await expect((await asToken(reader.token, "/v1/me")).json()).resolves.toEqual({
      principal: "stash",
      stash: "demo",
      tokenId: reader.id,
      scope: "read",
      expiresAt: null,
    });
    expect((await asToken(reader.token, "/v1/stashes/demo")).status).toBe(200);
    expect((await asToken(reader.token, "/v1/stashes/foreign")).status).toBe(404);
    expect((await asToken(reader.token, "/v1/stashes")).status).toBe(404);
    expect((await asToken(reader.token, "/v1/stashes/demo/tokens")).status).toBe(404);

    const denied = await asToken(reader.token, "/v1/stashes/demo/files/read-only.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "denied", expectedVersion: null }),
    });
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("scope");
    const allowed = await asToken(writer.token, "/v1/stashes/demo/files/write.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "allowed", expectedVersion: null }),
    });
    expect(allowed.status).toBe(201);
  });

  it("mints absolute and TTL expiries and conceals expiry at the exact clock boundary", async () => {
    let now = Date.parse("2026-08-26T02:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");

    const ttl = await request(fake, "/v1/stashes/demo/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "TTL", scope: "read", ttlSeconds: 60 }),
    });
    expect(ttl.status).toBe(201);
    const ttlToken = (await ttl.json()) as {
      id: string;
      token: string;
      expiresAt: string | null;
    };
    expect(ttlToken.expiresAt).toBe("2026-08-26T02:01:00.000Z");
    expect(fake.state.tokens.get(ttlToken.id)?.expiresAt).toBe(now + 60_000);

    const explicitAt = now + 120_000;
    const explicit = await request(fake, "/v1/stashes/demo/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "write", expiresAt: new Date(explicitAt).toISOString() }),
    });
    expect(explicit.status).toBe(201);
    await expect(explicit.json()).resolves.toMatchObject({
      expiresAt: new Date(explicitAt).toISOString(),
    });

    const active = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${ttlToken.token}` },
    });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({ expiresAt: ttlToken.expiresAt });
    const lastUsedAt = fake.state.tokens.get(ttlToken.id)?.lastUsedAt;

    now += 60_000;
    const expired = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${ttlToken.token}` },
    });
    expect(expired.status).toBe(401);
    expect(await errorCode(expired)).toBe("unauthorized");
    expect(fake.state.tokens.get(ttlToken.id)?.lastUsedAt).toBe(lastUsedAt);

    for (const body of [
      { scope: "read", expiresAt: new Date(now).toISOString() },
      { scope: "read", expiresAt: new Date(now + 315_360_000_001).toISOString() },
      { scope: "read", expiresAt: new Date(now + 1_000).toISOString(), ttlSeconds: 1 },
    ]) {
      const invalid = await request(fake, "/v1/stashes/demo/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("validation");
    }

    const fixtureSecret = await fake.mintToken("demo", "read", { ttlSeconds: 30 });
    expect(fixtureSecret).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);
    expect(
      [...fake.state.tokens.values()].some(({ expiresAt }) => expiresAt === now + 30_000),
    ).toBe(true);
  });

  it("rotates once, inherits the original expiry, truncates grace, and exposes recovery metadata", async () => {
    let now = Date.parse("2026-08-26T03:00:00.000Z");
    const originalExpiry = now + 2 * 86_400_000;
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const created = await request(fake, "/v1/stashes/demo/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Writer",
        scope: "write",
        expiresAt: new Date(originalExpiry).toISOString(),
      }),
    });
    const predecessor = (await created.json()) as { id: string; token: string };

    const rotated = await request(fake, `/v1/stashes/demo/tokens/${predecessor.id}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graceSeconds: 300 }),
    });
    expect(rotated.status).toBe(201);
    const successor = (await rotated.json()) as {
      id: string;
      token: string;
      expiresAt: string | null;
      rotatedFrom: string | null;
      predecessor: { id: string; expiresAt: string | null };
    };
    expect(successor).toMatchObject({
      label: "Writer",
      scope: "write",
      expiresAt: new Date(originalExpiry).toISOString(),
      rotatedFrom: predecessor.id,
      predecessor: {
        id: predecessor.id,
        expiresAt: new Date(now + 300_000).toISOString(),
      },
    });
    expect(fake.state.tokens.get(predecessor.id)).toMatchObject({
      expiresAt: now + 300_000,
      rotatedTo: successor.id,
    });
    expect(fake.state.tokens.get(successor.id)).toMatchObject({
      expiresAt: originalExpiry,
      rotatedFrom: predecessor.id,
    });

    const retry = await request(fake, `/v1/stashes/demo/tokens/${predecessor.id}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({
      error: {
        code: "already-rotated",
        message: "Token was already rotated.",
        successorId: successor.id,
      },
    });

    now += 299_999;
    expect(
      (
        await fake.fetch("https://fake.invalid/v1/me", {
          headers: { Authorization: `Bearer ${predecessor.token}` },
        })
      ).status,
    ).toBe(200);
    now += 1;
    expect(
      (
        await fake.fetch("https://fake.invalid/v1/me", {
          headers: { Authorization: `Bearer ${predecessor.token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fake.fetch("https://fake.invalid/v1/me", {
          headers: { Authorization: `Bearer ${successor.token}` },
        })
      ).status,
    ).toBe(200);

    await fake.mintToken("demo", "read");
    const neverPredecessor = [...fake.state.tokens.values()].at(-1);
    if (neverPredecessor === undefined) throw new Error("missing never-expiring predecessor");
    const inheritedNull = await request(
      fake,
      `/v1/stashes/demo/tokens/${neverPredecessor.id}/rotate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graceSeconds: 0 }),
      },
    );
    expect(inheritedNull.status).toBe(201);
    await expect(inheritedNull.json()).resolves.toMatchObject({
      expiresAt: null,
      rotatedFrom: neverPredecessor.id,
      predecessor: { id: neverPredecessor.id, expiresAt: new Date(now).toISOString() },
    });
  });

  it("allows exactly one concurrent rotation and refuses missing, revoked, and expired tokens", async () => {
    let now = Date.parse("2026-08-26T04:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const predecessorSecret = await fake.mintToken("demo", "read");
    const predecessor = [...fake.state.tokens.values()][0];
    if (predecessor === undefined) throw new Error("missing predecessor fixture");
    expect(predecessorSecret).toMatch(/^zhs_/);

    const rotate = () =>
      request(fake, `/v1/stashes/demo/tokens/${predecessor.id}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graceSeconds: 0, ttlSeconds: 60 }),
      });
    const responses = await Promise.all([rotate(), rotate()]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winnerResponse = responses.find(({ status }) => status === 201);
    const loserResponse = responses.find(({ status }) => status === 409);
    if (winnerResponse === undefined || loserResponse === undefined) {
      throw new Error("rotation did not produce one winner and one loser");
    }
    const winner = (await winnerResponse.json()) as { id: string; expiresAt: string | null };
    await expect(loserResponse.json()).resolves.toMatchObject({
      error: { code: "already-rotated", successorId: winner.id },
    });
    expect(winner.expiresAt).toBe(new Date(now + 60_000).toISOString());
    expect(
      [...fake.state.tokens.values()].filter(({ rotatedFrom }) => rotatedFrom === predecessor.id),
    ).toHaveLength(1);

    const revokedSecret = await fake.mintToken("demo", "read");
    const revoked = [...fake.state.tokens.values()].at(-1);
    if (revoked === undefined) throw new Error("missing revoked fixture");
    await request(fake, `/v1/stashes/demo/tokens/${revoked.id}`, { method: "DELETE" });
    expect(revokedSecret).toMatch(/^zhs_/);

    const expiredSecret = await fake.mintToken("demo", "read", { ttlSeconds: 1 });
    const expired = [...fake.state.tokens.values()].at(-1);
    if (expired === undefined) throw new Error("missing expired fixture");
    expect(expiredSecret).toMatch(/^zhs_/);
    now += 1_000;

    const refused = await Promise.all([
      request(fake, "/v1/stashes/demo/tokens/tok_missing/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      request(fake, `/v1/stashes/demo/tokens/${revoked.id}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      request(fake, `/v1/stashes/demo/tokens/${expired.id}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    ]);
    expect(refused.map(({ status }) => status)).toEqual([404, 404, 409]);
    const missingRefusal = refused[0];
    const revokedRefusal = refused[1];
    const expiredRefusal = refused[2];
    if (
      missingRefusal === undefined ||
      revokedRefusal === undefined ||
      expiredRefusal === undefined
    ) {
      throw new Error("missing rotation refusal response");
    }
    expect(await errorCode(missingRefusal)).toBe("not-found");
    expect(await errorCode(revokedRefusal)).toBe("not-found");
    expect(await errorCode(expiredRefusal)).toBe("token-expired");
    expect(
      [...fake.state.tokens.values()].filter(
        ({ rotatedFrom }) => rotatedFrom === revoked.id || rotatedFrom === expired.id,
      ),
    ).toHaveLength(0);
  });

  it("revokes immediately and handles missing, foreign, and invalid token operations", async () => {
    const timestamp = Date.parse("2026-08-26T01:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    fake.createStash("demo");
    fake.createStash("foreign");
    const secret = await fake.mintToken("demo", "write");
    const row = [...fake.state.tokens.values()][0];
    if (row === undefined) throw new Error("fixture token was not stored");

    const revoke = await request(fake, `/v1/stashes/demo/tokens/${row.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);
    expect(await revoke.text()).toBe("");
    expect(row.revokedAt).toBe(timestamp);

    const rejected = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(rejected.status).toBe(401);
    expect(await errorCode(rejected)).toBe("unauthorized");
    const list = await request(fake, "/v1/stashes/demo/tokens");
    await expect(list.json()).resolves.toMatchObject({
      tokens: [{ id: row.id, revokedAt: "2026-08-26T01:00:00.000Z" }],
    });

    for (const path of [
      "/v1/stashes/demo/tokens/tok_missing",
      `/v1/stashes/foreign/tokens/${row.id}`,
    ]) {
      const missing = await request(fake, path, { method: "DELETE" });
      expect(missing.status).toBe(404);
      expect(await errorCode(missing)).toBe("not-found");
    }
    const missingCreate = await request(fake, "/v1/stashes/missing/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "read" }),
    });
    expect(missingCreate.status).toBe(404);
    expect((await request(fake, "/v1/stashes/missing/tokens")).status).toBe(404);

    for (const body of [{ scope: "admin" }, { label: "missing scope" }, { scope: "read", x: 1 }]) {
      const invalid = await request(fake, "/v1/stashes/demo/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("validation");
    }
  });
});

describe("rate-limit injection", () => {
  it("uses capability/principal/stash keys, short-circuits denials, and keeps admin exempt", async () => {
    const calls: Array<{ capability: string; key: string; routeId: RouteId }> = [];
    const denied = new Set<string>();
    let unavailable = false;
    const fake = createFakeStash({
      adminToken: ADMIN,
      rateLimit(input) {
        calls.push(input);
        if (unavailable) throw new Error("binding unavailable");
        return { success: !denied.has(`${input.capability}:${input.key}`) };
      },
    });
    fake.createStash("demo");
    const readerSecret = await fake.mintToken("demo", "read");
    const writerSecret = await fake.mintToken("demo", "write");
    const [reader, writer] = [...fake.state.tokens.values()];
    if (reader === undefined || writer === undefined) throw new Error("missing limiter fixtures");

    denied.add(`read:p:${reader.id}`);
    const principalLimited = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${readerSecret}` },
    });
    expect(principalLimited.status).toBe(429);
    expect(principalLimited.headers.get("Retry-After")).toBe("60");
    await expect(principalLimited.json()).resolves.toEqual({
      error: { code: "rate-limited", message: "The request was rate limited." },
    });
    expect(calls).toEqual([{ capability: "read", key: `p:${reader.id}`, routeId: "me" }]);

    calls.length = 0;
    denied.clear();
    denied.add("read:s:demo");
    const stashLimited = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${readerSecret}` },
    });
    expect(stashLimited.status).toBe(429);
    expect(calls).toEqual([
      { capability: "read", key: `p:${reader.id}`, routeId: "me" },
      { capability: "read", key: "s:demo", routeId: "me" },
    ]);

    calls.length = 0;
    const admin = await request(fake, "/v1/me");
    expect(admin.status).toBe(200);
    expect(calls).toEqual([]);

    denied.clear();
    unavailable = true;
    const failOpen = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${readerSecret}` },
    });
    expect(failOpen.status).toBe(200);
    expect(calls).toEqual([{ capability: "read", key: `p:${reader.id}`, routeId: "me" }]);

    unavailable = false;
    calls.length = 0;
    denied.add(`write:p:${writer.id}`);
    const writeLimited = await fake.fetch(
      "https://fake.invalid/v1/stashes/demo/files/rate-limited.txt",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${writerSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "must not persist", expectedVersion: null }),
      },
    );
    expect(writeLimited.status).toBe(429);
    expect(calls).toEqual([{ capability: "write", key: `p:${writer.id}`, routeId: "putFile" }]);
    expect(fake.state.files.size).toBe(0);
    expect(fake.state.versions).toHaveLength(0);
    expect(fake.state.blobs.size).toBe(0);
    expect(fake.state.idempotency.size).toBe(0);

    calls.length = 0;
    denied.clear();
    denied.add(`diff:p:${reader.id}`);
    const diffLimited = await fake.fetch(
      "https://fake.invalid/v1/stashes/demo/diff/rate-limited.txt?from=1&to=head",
      { headers: { Authorization: `Bearer ${readerSecret}` } },
    );
    expect(diffLimited.status).toBe(429);
    expect(calls).toEqual([{ capability: "diff", key: `p:${reader.id}`, routeId: "getDiff" }]);
  });

  it.each(EMPTY_DIFF_ROUTES)(
    "runs $method $path through the diff limiter before empty-path validation",
    async ({ method, path, routeId }) => {
      const calls: Array<{ capability: string; key: string; routeId: RouteId }> = [];
      let denied = true;
      const fake = createFakeStash({
        adminToken: ADMIN,
        rateLimit(input) {
          calls.push(input);
          return { success: !denied };
        },
      });
      fake.createStash("demo");
      const secret = await fake.mintToken("demo", "read");
      const token = [...fake.state.tokens.values()][0];
      if (token === undefined) throw new Error("missing empty-diff fixture");

      const send = () =>
        fake.fetch(`https://fake.invalid${path}`, {
          method,
          headers: { Authorization: `Bearer ${secret}` },
        });

      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(await errorCode(limited)).toBe("rate-limited");
      expect(calls).toEqual([{ capability: "diff", key: `p:${token.id}`, routeId }]);

      denied = false;
      calls.length = 0;
      const invalidPath = await send();
      expect(invalidPath.status).toBe(400);
      expect(await errorCode(invalidPath)).toBe("invalid-path");
      expect(calls).toEqual([
        { capability: "diff", key: `p:${token.id}`, routeId },
        { capability: "diff", key: "s:demo", routeId },
      ]);
    },
  );

  it("preserves nonempty stored-diff routing after accepting empty wildcard paths", async () => {
    const calls: Array<{ capability: string; key: string; routeId: RouteId }> = [];
    const fake = createFakeStash({
      adminToken: ADMIN,
      rateLimit(input) {
        calls.push(input);
        return { success: true };
      },
    });
    fake.createStash("demo");
    const secret = await fake.mintToken("demo", "read");
    const token = [...fake.state.tokens.values()][0];
    if (token === undefined) throw new Error("missing nonempty-diff fixture");

    const response = await fake.fetch(
      "https://fake.invalid/v1/stashes/demo/diff/missing.txt?from=1&to=head",
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not-found");
    expect(calls).toEqual([
      { capability: "diff", key: `p:${token.id}`, routeId: "getDiff" },
      { capability: "diff", key: "s:demo", routeId: "getDiff" },
    ]);
  });
});

describe("bearer parsing", () => {
  it("rejects basic, duplicated, and unknown bearer credentials", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    for (const authorization of [
      "Basic abc",
      `Bearer ${ADMIN}, Bearer ${ADMIN}`,
      `Bearer zhs_${"x".repeat(43)}`,
    ]) {
      const response = await fake.fetch("https://fake.invalid/v1/me", {
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthorized");
    }
  });
});

describe("validation and limits", () => {
  it("reuses strict core schemas for unknown fields and query limits", async () => {
    const fake = createFakeStash({
      adminToken: ADMIN,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });
    fake.createStash("demo");
    const unknown = await request(fake, "/v1/stashes/demo/files/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x", expectedVersion: null, unknown: true }),
    });
    expect(unknown.status).toBe(400);
    expect(await errorCode(unknown)).toBe("validation");

    const excessiveLimit = await request(fake, "/v1/stashes/demo/files?limit=201");
    expect(excessiveLimit.status).toBe(400);
    expect(await errorCode(excessiveLimit)).toBe("validation");
  });

  it("distinguishes Unicode, body-byte, request-byte, and key limits", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const put = async (body: unknown, headers: Record<string, string> = {}) =>
      request(fake, "/v1/stashes/demo/files/a.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const malformed = await put({ body: "\ud800", expectedVersion: null });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("body-not-well-formed");

    const tooLarge = await put({ body: "x".repeat(MAX_BODY_BYTES + 1), expectedVersion: null });
    expect(tooLarge.status).toBe(413);
    expect(await errorCode(tooLarge)).toBe("payload-too-large");

    const key = await put(
      { body: "x", expectedVersion: null },
      { "Idempotency-Key": "k".repeat(IDEMPOTENCY_KEY_MAX_CHARS + 1) },
    );
    expect(key.status).toBe(400);
    expect(await errorCode(key)).toBe("validation");

    const emptyKey = await put({ body: "x", expectedVersion: null }, { "Idempotency-Key": "" });
    expect(emptyKey.status).toBe(400);
    expect(await errorCode(emptyKey)).toBe("validation");

    const malformedContentType = await request(fake, "/v1/stashes/demo/files/content-type.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json;" },
      body: JSON.stringify({ body: "x", expectedVersion: null }),
    });
    expect(malformedContentType.status).toBe(400);
    expect(await errorCode(malformedContentType)).toBe("validation");

    const requestTooLarge = await request(fake, "/v1/stashes/demo/files/raw.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(BODY_LIMIT_BYTES + 1),
    });
    expect(requestTooLarge.status).toBe(413);
    expect(await errorCode(requestTooLarge)).toBe("payload-too-large");

    const escaped = await put({
      body: "\u0001".repeat(MAX_BODY_BYTES),
      expectedVersion: null,
    });
    expect(escaped.status).toBe(201);
    await expect(escaped.json()).resolves.toMatchObject({ size: MAX_BODY_BYTES });
  });
});
