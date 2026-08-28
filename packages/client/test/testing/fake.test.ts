import {
  BODY_LIMIT_BYTES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_BODY_BYTES,
  MAX_META_BYTES,
  R2_SPILL_BYTES,
  ROUTES,
  sha256Hex,
  type GcRunResult,
  type ProposalRecord,
  type RouteId,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { createStashClient } from "../../src/index.js";
import { parseStashEventStream } from "../../src/sse.js";
import {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  FAKE_SUPPORTED_ROUTE_IDS,
  createFakeStash,
} from "../../src/testing/index.js";

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

  it("emits only newly committed changes and proposal decisions with the valid client origin", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const token = await fake.mintToken("demo", "write");
    let keySerial = 0;
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "tab A!~",
      fetch: fake.fetch,
      idempotencyKey: () => `auto-${(keySerial += 1)}`,
    });
    const files = client.files("demo");
    const proposals = client.proposals("demo");
    const stream = files.events({ since: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "ready", head: null, checkpoint: 0 },
    });

    const firstInput = { body: "one", expectedVersion: null } as const;
    await files.put("a.md", firstInput, { idempotencyKey: "put-one" });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "change", changeId: 1, version: 1, origin: "tab A!~" },
    });
    await files.put("a.md", firstInput, { idempotencyKey: "put-one" });
    await files.put("a.md", { body: "one", expectedVersion: 1, skipIfUnchanged: true });
    await files.put("a.md", { body: "refused", expectedVersion: 99 });
    await files.put("a.md", { body: "two", expectedVersion: 1 });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "change", changeId: 2, version: 2, origin: "tab A!~" },
    });

    const created = await proposals.create(
      { path: "a.md", body: "candidate", baseVersion: 2 },
      { idempotencyKey: "proposal-one" },
    );
    if (!created.ok) throw new Error("proposal fixture failed");
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "proposal",
        proposalId: created.value.id,
        status: "open",
        origin: "tab A!~",
      },
    });
    await proposals.create(
      { path: "a.md", body: "candidate", baseVersion: 2 },
      { idempotencyKey: "proposal-one" },
    );
    await proposals.approve(created.value.id);
    const approvalEvents = [await iterator.next(), await iterator.next()].map(
      ({ value }) => value as StashEvent,
    );
    expect(approvalEvents).toEqual([
      expect.objectContaining({ type: "change", changeId: 3, version: 3, origin: "tab A!~" }),
      expect.objectContaining({
        type: "proposal",
        proposalId: created.value.id,
        status: "applied",
        origin: "tab A!~",
      }),
    ]);
    await proposals.approve(created.value.id);

    const rejected = await proposals.create({ path: "a.md", body: "later", baseVersion: 3 });
    if (!rejected.ok) throw new Error("rejection fixture failed");
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "proposal", proposalId: rejected.value.id, status: "open" },
    });
    await proposals.reject(rejected.value.id, { reason: "no" });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "proposal",
        proposalId: rejected.value.id,
        status: "rejected",
        origin: "tab A!~",
      },
    });
    await proposals.reject(rejected.value.id, { reason: "ignored replay" });
    await files.put("a.md", { body: "after decisions", expectedVersion: 3 });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "change", changeId: 4, version: 4 },
    });

    const stale = await proposals.create({ path: "a.md", body: "stale", baseVersion: 4 });
    if (!stale.ok) throw new Error("stale fixture failed");
    await iterator.next();
    await files.put("a.md", { body: "moved", expectedVersion: 4 });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "change", changeId: 5, version: 5 },
    });
    await proposals.approve(stale.value.id);
    await proposals.reject(stale.value.id);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "proposal", proposalId: stale.value.id, status: "rejected" },
    });

    stream.close();
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
    expect(exposed.proposals.size).toBe(0);
    expect(exposed.idempotency.get("demo")?.size).toBe(1);

    fake.reset();
    expect(fake.state).toBe(exposed);
    expect(exposed.stashes.size).toBe(0);
    expect(exposed.tokens.size).toBe(0);
    expect(exposed.blobs.size).toBe(0);
    expect(exposed.r2Objects.size).toBe(0);
    expect(exposed.files.size).toBe(0);
    expect(exposed.versions).toHaveLength(0);
    expect(exposed.proposals.size).toBe(0);
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

describe("proposal lifecycle", () => {
  it("creates idempotently, computes expiry, and keyset-paginates equal timestamps", async () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const createBody = {
      path: "docs/proposal.md",
      body: "candidate one\n",
      baseVersion: null,
      author: "bot",
      message: "first",
      meta: { nested: { b: 2, a: 1 } },
    };
    const create = () =>
      request(fake, "/v1/stashes/demo/proposals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "proposal-create",
        },
        body: JSON.stringify(createBody),
      });
    const concurrent = await Promise.all([create(), create()]);
    expect(concurrent.map(({ status }) => status)).toEqual([201, 201]);
    const created = await Promise.all(
      concurrent.map((response) => response.json() as Promise<ProposalRecord>),
    );
    expect(created[0]).toEqual(created[1]);
    expect(created[0]?.id).toMatch(/^prp_\d{13}[0-9a-f]{8}$/);
    expect(created[0]?.expiresAt).toBe("2026-09-09T00:00:00.000Z");
    expect(created[0]?.meta).toEqual({
      ...createBody.meta,
      proposalId: created[0]?.id,
    });
    expect(
      concurrent.map((response) => response.headers.get("Idempotent-Replayed")).sort(),
    ).toEqual([null, "true"]);
    expect(fake.state.proposals.get("demo")?.size).toBe(1);
    expect(fake.state.blobs.get("demo")?.size).toBe(1);

    const reused = await request(fake, "/v1/stashes/demo/proposals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "proposal-create",
      },
      body: JSON.stringify({ ...createBody, body: "different\n" }),
    });
    expect(reused.status).toBe(422);
    expect(await errorCode(reused)).toBe("idempotency-key-reused");

    for (const body of ["candidate two\n", "candidate three\n"]) {
      const response = await request(fake, "/v1/stashes/demo/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...createBody, body }),
      });
      expect(response.status).toBe(201);
    }

    const firstPage = await request(
      fake,
      "/v1/stashes/demo/proposals?status=open&path=docs%2Fproposal.md&limit=1",
    );
    expect(firstPage.status).toBe(200);
    const firstPageBody = (await firstPage.json()) as {
      proposals: Array<{ id: string; meta: Record<string, unknown>; body?: string }>;
      nextAfter: string | null;
      total: number;
    };
    expect(firstPageBody).toMatchObject({ total: 3 });
    expect(firstPageBody.proposals).toHaveLength(1);
    expect(firstPageBody.proposals[0]?.id).toBe(
      [...(fake.state.proposals.get("demo")?.keys() ?? [])].at(-1),
    );
    expect(firstPageBody.proposals[0]?.meta).toMatchObject({
      proposalId: firstPageBody.proposals[0]?.id,
    });
    expect(firstPageBody.proposals[0]).not.toHaveProperty("body");
    expect(firstPageBody.nextAfter).toEqual(expect.any(String));

    const secondPage = await request(
      fake,
      `/v1/stashes/demo/proposals?status=open&path=docs%2Fproposal.md&limit=1&after=${encodeURIComponent(firstPageBody.nextAfter ?? "")}`,
    );
    expect(secondPage.status).toBe(200);
    const secondPageBody = (await secondPage.json()) as typeof firstPageBody;
    expect(secondPageBody.total).toBe(3);
    expect(secondPageBody.proposals[0]?.id).not.toBe(firstPageBody.proposals[0]?.id);

    const invalidCursor = await request(fake, "/v1/stashes/demo/proposals?after=not-base64");
    expect(invalidCursor.status).toBe(400);
    expect(await errorCode(invalidCursor)).toBe("validation");

    const forgedCursor = btoa(`${now}:prp_${String(now + 1).padStart(13, "0")}deadbeef`);
    const forged = await request(
      fake,
      `/v1/stashes/demo/proposals?after=${encodeURIComponent(forgedCursor)}`,
    );
    expect(forged.status).toBe(400);
    expect(await errorCode(forged)).toBe("validation");

    const detail = await request(fake, `/v1/stashes/demo/proposals/${created[0]?.id ?? "missing"}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      ...createBody,
      id: created[0]?.id,
      meta: { ...createBody.meta, proposalId: created[0]?.id },
      status: "open",
      body: createBody.body,
      decidedAt: null,
      decidedBy: null,
    });
  });

  it("replays an explicitly expired create without allocating another candidate", async () => {
    let now = Date.parse("2026-08-26T00:30:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const input = {
      path: "docs/expiring-replay.md",
      body: "x".repeat(R2_SPILL_BYTES + 1),
      baseVersion: null,
      expiresAt: new Date(now + 1).toISOString(),
    };
    const create = () =>
      request(fake, "/v1/stashes/demo/proposals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "expiring-replay",
        },
        body: JSON.stringify(input),
      });

    const initial = await create();
    expect(initial.status).toBe(201);
    const initialBody = (await initial.json()) as ProposalRecord;
    expect(initialBody).toMatchObject({
      status: "open",
      meta: { proposalId: initialBody.id },
    });
    expect(fake.state.proposals.get("demo")?.size).toBe(1);
    expect(fake.state.blobs.get("demo")?.size).toBe(1);
    expect(fake.state.r2Objects.size).toBe(1);

    now += 1;
    const equalityReplay = await create();
    expect(equalityReplay.status).toBe(201);
    expect(equalityReplay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(equalityReplay.json()).resolves.toEqual({ ...initialBody, status: "expired" });

    now += 1_000;
    const laterReplay = await create();
    expect(laterReplay.status).toBe(201);
    expect(laterReplay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(laterReplay.json()).resolves.toEqual({ ...initialBody, status: "expired" });
    expect(fake.state.proposals.get("demo")?.size).toBe(1);
    expect(fake.state.blobs.get("demo")?.size).toBe(1);
    expect(fake.state.r2Objects.size).toBe(1);

    const next = await request(fake, "/v1/stashes/demo/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "docs/next.md", body: "next", baseVersion: null }),
    });
    expect(next.status).toBe(201);
    const nextBody = (await next.json()) as ProposalRecord;
    expect(nextBody.id).toMatch(/^prp_\d{13}00000002$/);
  });

  it("keeps diffs immutable and allows exactly one fenced approval to append", async () => {
    let now = Date.parse("2026-08-26T01:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const writerSecret = await fake.mintToken("demo", "write");
    const writer = [...fake.state.tokens.values()][0];
    if (writer === undefined) throw new Error("missing proposal writer fixture");

    const base = await request(fake, "/v1/stashes/demo/files/docs/proposal.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "base\n", expectedVersion: null }),
    });
    expect(base.status).toBe(201);

    const createProposal = async (body: string, baseVersion: number) => {
      const response = await fake.fetch("https://fake.invalid/v1/stashes/demo/proposals", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${writerSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "docs/proposal.md",
          body,
          baseVersion,
          author: "proposal-author",
          message: "proposal-message",
          meta: { source: "fake" },
        }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<ProposalRecord>;
    };

    const candidate = await createProposal("candidate\n", 1);
    expect(candidate.meta).toEqual({ source: "fake", proposalId: candidate.id });
    const staleCandidate = await createProposal("stale candidate\n", 1);
    const beforeDiff = await request(
      fake,
      `/v1/stashes/demo/proposals/${candidate.id}/diff?context=1`,
    );
    expect(beforeDiff.status).toBe(200);
    const beforeDiffBody = (await beforeDiff.json()) as {
      unified: string;
      current: { version: number };
      stale: boolean;
    };
    expect(beforeDiffBody).toMatchObject({
      state: "ready",
      base: { version: 1, deleted: false },
      candidate: { hash: candidate.hash, size: 10 },
      current: { version: 1 },
      stale: false,
    });

    const approve = () =>
      fake.fetch(`https://fake.invalid/v1/stashes/demo/proposals/${candidate.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${writerSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ author: "approver", message: "approved" }),
      });
    const approvals = await Promise.all([approve(), approve()]);
    expect(approvals.map(({ status }) => status)).toEqual([200, 200]);
    const approvalBodies = await Promise.all(approvals.map((response) => response.json()));
    expect(approvalBodies[0]).toEqual(approvalBodies[1]);
    expect(approvalBodies[0]).toMatchObject({
      status: "applied",
      appliedVersion: 2,
      appliedChangeId: 2,
      hash: candidate.hash,
    });
    expect(fake.state.versions).toHaveLength(2);
    expect(fake.state.versions[1]).toMatchObject({
      kind: "put",
      author: "approver",
      message: "approved",
      meta: { source: "fake", proposalId: candidate.id },
    });
    expect(fake.state.proposals.get("demo")?.get(candidate.id)).toMatchObject({
      status: "applied",
      meta: { source: "fake", proposalId: candidate.id },
      decidedBy: writer.id,
      appliedVersion: 2,
      appliedChangeId: 2,
    });
    expect(fake.state.versions[1]?.meta).toEqual(
      fake.state.proposals.get("demo")?.get(candidate.id)?.meta,
    );

    const afterDiff = await request(
      fake,
      `/v1/stashes/demo/proposals/${candidate.id}/diff?context=1`,
    );
    const afterDiffBody = (await afterDiff.json()) as typeof beforeDiffBody;
    expect(afterDiffBody.unified).toBe(beforeDiffBody.unified);
    expect(afterDiffBody).toMatchObject({ current: { version: 2 }, stale: true });

    const sameBody = await createProposal("candidate\n", 2);
    const sameBodyApproval = await request(
      fake,
      `/v1/stashes/demo/proposals/${sameBody.id}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(sameBodyApproval.status).toBe(200);
    await expect(sameBodyApproval.json()).resolves.toMatchObject({
      status: "applied",
      appliedVersion: 3,
      appliedChangeId: 3,
      hash: candidate.hash,
    });
    expect(fake.state.versions).toHaveLength(3);
    expect(fake.state.versions[2]?.meta).toMatchObject({ proposalId: sameBody.id });

    now += 15 * 86_400_000;
    const reapplied = await approve();
    expect(reapplied.status).toBe(200);
    await expect(reapplied.json()).resolves.toEqual(approvalBodies[0]);
    expect(fake.state.versions).toHaveLength(3);

    const stale = await fake.fetch(
      `https://fake.invalid/v1/stashes/demo/proposals/${staleCandidate.id}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${writerSecret}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "proposal-expired" },
    });
    expect(fake.state.versions).toHaveLength(3);
  });

  it("reports stale, expired, and closed decisions while expired rejection remains allowed", async () => {
    let now = Date.parse("2026-08-26T02:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const put = async (body: string, expectedVersion: number | null) =>
      request(fake, "/v1/stashes/demo/files/docs/decision.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, expectedVersion }),
      });
    expect((await put("base\n", null)).status).toBe(201);

    const create = async (expiresAt?: string) => {
      const response = await request(fake, "/v1/stashes/demo/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "docs/decision.md",
          body: "candidate\n",
          baseVersion: 1,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string }>;
    };
    const staleProposal = await create();
    expect((await put("moved\n", 1)).status).toBe(201);

    const stale = await request(fake, `/v1/stashes/demo/proposals/${staleProposal.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "stale" },
      current: { version: 2 },
    });
    expect(fake.state.versions).toHaveLength(2);

    const expiring = await create(new Date(now + 1_000).toISOString());
    now += 1_000;
    const expiredList = await request(fake, "/v1/stashes/demo/proposals?status=expired");
    await expect(expiredList.json()).resolves.toMatchObject({
      proposals: [{ id: expiring.id, status: "expired" }],
      total: 1,
    });
    const expiredApprove = await request(
      fake,
      `/v1/stashes/demo/proposals/${expiring.id}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(expiredApprove.status).toBe(409);
    expect(await errorCode(expiredApprove)).toBe("proposal-expired");

    const reject = () =>
      request(fake, `/v1/stashes/demo/proposals/${expiring.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "superseded" }),
      });
    const rejected = await reject();
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json();
    expect(rejectedBody).toMatchObject({
      id: expiring.id,
      status: "rejected",
      decidedBy: "admin",
      decisionReason: "superseded",
    });
    const rerejected = await reject();
    await expect(rerejected.json()).resolves.toEqual(rejectedBody);

    const closed = await request(fake, `/v1/stashes/demo/proposals/${expiring.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(closed.status).toBe(409);
    expect(await errorCode(closed)).toBe("proposal-closed");
  });

  it("keeps a spilled proposal candidate referenced through orphan collection", async () => {
    let now = Date.parse("2026-08-26T03:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now });
    fake.createStash("demo");
    const candidate = "x".repeat(R2_SPILL_BYTES + 1);
    const created = await request(fake, "/v1/stashes/demo/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "docs/spilled-proposal.md",
        body: candidate,
        baseVersion: null,
      }),
    });
    expect(created.status).toBe(201);
    const proposal = (await created.json()) as { hash: string };
    const blob = fake.state.blobs.get("demo")?.get(proposal.hash);
    expect(blob?.r2Key).toEqual(expect.any(String));
    expect(fake.state.r2Objects.has(blob?.r2Key ?? "missing")).toBe(true);

    now += 900_001;
    const gc = await request(fake, "/v1/admin/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "r2-orphans", maxObjects: 24 }),
    });
    expect(gc.status).toBe(200);
    await expect(gc.json()).resolves.toMatchObject({ scanned: 1, eligible: 0, deleted: 0 });
    expect(fake.state.r2Objects.has(blob?.r2Key ?? "missing")).toBe(true);
  });

  it("uses one clock snapshot for the approval decision and applied version", async () => {
    let now = Date.parse("2026-08-26T04:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => now++ });
    fake.createStash("demo");
    const created = await request(fake, "/v1/stashes/demo/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "docs/clock.md", body: "candidate", baseVersion: null }),
    });
    const proposal = (await created.json()) as { id: string };

    const approved = await request(fake, `/v1/stashes/demo/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    const row = fake.state.proposals.get("demo")?.get(proposal.id);
    const version = fake.state.versions[0];
    expect(row?.decidedAt).toBe(version?.createdAt);
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

    for (const path of [
      "/v1/stashes/demo/files/a.txt",
      "/v1/stashes/demo/tokens",
      "/v1/stashes/demo/proposals",
    ]) {
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

    const proposal = async (body: unknown) =>
      request(fake, "/v1/stashes/demo/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const platformMeta = await proposal({
      path: "docs/proposal.md",
      body: "candidate",
      baseVersion: null,
      meta: { proposalId: "caller-owned" },
    });
    expect(platformMeta.status).toBe(400);
    expect(await errorCode(platformMeta)).toBe("validation");

    const metaShellBytes = JSON.stringify({ padding: "" }).length;
    const stampedTooLarge = await proposal({
      path: "docs/proposal.md",
      body: "candidate",
      baseVersion: null,
      meta: { padding: "x".repeat(MAX_META_BYTES - metaShellBytes) },
    });
    expect(stampedTooLarge.status).toBe(400);
    expect(await errorCode(stampedTooLarge)).toBe("validation");

    const invalidExpiry = await proposal({
      path: "docs/proposal.md",
      body: "candidate",
      baseVersion: null,
      expiresAt: "2027-02-30T00:00:00.000Z",
    });
    expect(invalidExpiry.status).toBe(400);
    expect(await errorCode(invalidExpiry)).toBe("validation");
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
