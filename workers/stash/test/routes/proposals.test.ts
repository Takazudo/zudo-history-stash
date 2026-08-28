import {
  MAX_AUTHOR_BYTES,
  MAX_BODY_BYTES,
  MAX_MESSAGE_BYTES,
  type ApproveProposalResult,
  type ProposalDiffResult,
  type ProposalListResponse,
  type ProposalRecord,
  type ProposalWithBody,
} from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createStashStore } from "../../src/d1/store.js";
import type { Env } from "../../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const STASH = "proposal-routes";
let clock = NOW;
const app = createApp({ now: () => clock });

function url(suffix = ""): string {
  return `http://stash.test/v1/stashes/${STASH}/proposals${suffix}`;
}

function jsonInit(
  method: "POST" | "PUT",
  body: unknown,
  token = "test-admin",
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { ...bearer(token), "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function postCreate(
  body: unknown,
  options: { token?: string; key?: string; bindings?: Env } = {},
): Promise<Response> {
  return request(
    app,
    url(),
    jsonInit(
      "POST",
      body,
      options.token,
      options.key === undefined ? {} : { "Idempotency-Key": options.key },
    ),
    options.bindings,
  );
}

async function createProposal(
  overrides: Record<string, unknown> = {},
  options: { token?: string; key?: string; bindings?: Env } = {},
): Promise<ProposalRecord> {
  const response = await postCreate(
    { path: "docs/review.md", body: "candidate\n", baseVersion: null, ...overrides },
    options,
  );
  expect(response.status).toBe(201);
  return response.json<ProposalRecord>();
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

beforeEach(async () => {
  clock = NOW;
  await resetDatabase();
  await seedStash(STASH);
});

describe("proposal create route", () => {
  it("creates a candidate with platform meta, explicit expiry syntax, and no replay header", async () => {
    const expiresAt = "2026-08-28T00:00:00.0000Z";
    const response = await postCreate({
      path: "docs/review.md",
      body: "candidate\n",
      baseVersion: null,
      author: "bot",
      message: "please review",
      meta: { source: "route" },
      expiresAt,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotent-Replayed")).toBeNull();
    const record = await response.json<ProposalRecord>();
    expect(record).toMatchObject({
      id: expect.stringMatching(/^prp_\d{13}[0-9a-f]{8}$/),
      stash: STASH,
      path: "docs/review.md",
      baseVersion: null,
      author: "bot",
      message: "please review",
      meta: { source: "route", proposalId: expect.any(String) },
      expiresAt: "2026-08-28T00:00:00.000Z",
      status: "open",
    });
    expect(record).not.toHaveProperty("body");
    expect(record.meta.proposalId).toBe(record.id);
  });

  it("replays the same idempotency key after explicit expiry and rejects a mismatch", async () => {
    const bindings = createTestEnv().env;
    const input = {
      path: "docs/replay.md",
      body: "stable\n".repeat(90_000),
      baseVersion: null,
      expiresAt: new Date(NOW + 1).toISOString(),
    };
    const first = await postCreate(input, { key: "proposal-replay", bindings });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
    const created = await first.json<ProposalRecord>();

    clock = NOW + 1;
    const replay = await postCreate(input, { key: "proposal-replay", bindings });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({ id: created.id, status: "expired" });

    clock = NOW + 2;
    const invalidTtlBindings = { ...bindings, PROPOSAL_TTL_DAYS: "invalid" } satisfies Env;
    const replayAfter = await postCreate(input, {
      key: "proposal-replay",
      bindings: invalidTtlBindings,
    });
    expect(replayAfter.status).toBe(201);
    expect(replayAfter.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replayAfter.json()).resolves.toMatchObject({ id: created.id, status: "expired" });

    const mismatch = await postCreate(
      { ...input, body: "different\n" },
      {
        key: "proposal-replay",
        bindings: invalidTtlBindings,
      },
    );
    await expectError(mismatch, 422, "idempotency-key-reused");
    expect(mismatch.headers.get("Idempotent-Replayed")).toBeNull();
    await expect(
      bindings.DB.prepare("SELECT COUNT(*) AS count FROM proposals").first("count"),
    ).resolves.toBe(1);
    await expect(
      bindings.DB.prepare("SELECT COUNT(*) AS count FROM blobs").first("count"),
    ).resolves.toBe(1);
    expect((await bindings.BLOBS.list({ prefix: `v2/${STASH}/` })).objects).toHaveLength(1);
  });

  it.each([
    {
      name: "platform proposalId meta",
      body: { path: "a.txt", body: "x", baseVersion: null, meta: { proposalId: "caller" } },
      status: 400,
      code: "validation",
    },
    {
      name: "past expiry on a new key",
      body: {
        path: "a.txt",
        body: "x",
        baseVersion: null,
        expiresAt: new Date(NOW).toISOString(),
      },
      status: 400,
      code: "validation",
    },
    {
      name: "impossible calendar timestamp",
      body: {
        path: "a.txt",
        body: "x",
        baseVersion: null,
        expiresAt: "2026-02-29T00:00:00.000Z",
      },
      status: 400,
      code: "validation",
    },
    {
      name: "invalid path",
      body: { path: "../bad", body: "x", baseVersion: null },
      status: 400,
      code: "validation",
    },
    {
      name: "unknown property",
      body: { path: "a.txt", body: "x", baseVersion: null, extra: true },
      status: 400,
      code: "validation",
    },
  ])("maps $name", async ({ body, status, code }) => {
    await expectError(await postCreate(body), status, code);
  });

  it("maps malformed JSON, content type, malformed Unicode, and exact body overflow", async () => {
    const missingType = await request(app, url(), {
      method: "POST",
      headers: bearer("test-admin"),
      body: "{}",
    });
    await expectError(missingType, 400, "validation");

    const malformed = await request(app, url(), {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: "{",
    });
    await expectError(malformed, 400, "validation");

    const malformedType = await request(app, url(), {
      method: "POST",
      headers: {
        ...bearer("test-admin"),
        "Content-Type": "application/json;",
        "Idempotency-Key": "malformed-content-type",
      },
      body: JSON.stringify({ path: "a.txt", body: "x", baseVersion: null }),
    });
    await expectError(malformedType, 400, "validation");
    expect(malformedType.headers.get("Idempotent-Replayed")).toBeNull();
    await expect(
      createTestEnv()
        .env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM proposals) AS proposals, (SELECT COUNT(*) FROM blobs) AS blobs",
        )
        .first(),
    ).resolves.toMatchObject({ proposals: 0, blobs: 0 });
    expect((await createTestEnv().env.BLOBS.list({ prefix: `v2/${STASH}/` })).objects).toHaveLength(
      0,
    );

    await expectError(
      await postCreate({ path: "a.txt", body: "\ud800", baseVersion: null }),
      400,
      "body-not-well-formed",
    );
    await expectError(
      await postCreate({ path: "a.txt", body: "x".repeat(MAX_BODY_BYTES + 1), baseVersion: null }),
      413,
      "payload-too-large",
    );
  }, 30_000);

  it("rejects invalid idempotency keys before any proposal write", async () => {
    const response = await postCreate(
      { path: "a.txt", body: "x", baseVersion: null },
      { key: "x".repeat(201) },
    );
    await expectError(response, 400, "validation");
    await expect(
      createTestEnv().env.DB.prepare("SELECT COUNT(*) AS count FROM proposals").first("count"),
    ).resolves.toBe(0);
  });
});

describe("proposal read routes", () => {
  it("lists with parsed filters, exact total, and keyset continuation", async () => {
    await createProposal({ path: "docs/a.md" });
    clock += 1;
    await createProposal({ path: "docs/b.md" });
    clock += 1;
    await createProposal({ path: "docs/b.md", body: "second b" });

    const defaults = await request(app, url(), { headers: bearer("test-admin") });
    expect(defaults.status).toBe(200);
    await expect(defaults.json()).resolves.toMatchObject({
      total: 3,
      proposals: expect.any(Array),
    });

    const first = await request(app, `${url()}?status=all&path=docs%2Fb.md&limit=1`, {
      headers: bearer("test-admin"),
    });
    expect(first.status).toBe(200);
    const page = await first.json<ProposalListResponse>();
    expect(page).toMatchObject({ total: 2, proposals: [{ path: "docs/b.md" }] });
    expect(page.nextAfter).toEqual(expect.any(String));

    const second = await request(
      app,
      `${url()}?status=all&path=docs%2Fb.md&limit=1&after=${encodeURIComponent(page.nextAfter!)}`,
      { headers: bearer("test-admin") },
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      total: 2,
      proposals: [{ path: "docs/b.md" }],
      nextAfter: null,
    });
  });

  it.each([
    "?status=unknown",
    "?limit=0",
    "?limit=201",
    "?path=..%2Fbad",
    "?status=all&after=not-a-cursor",
    "?extra=true",
  ])("rejects invalid list query %s", async (query) => {
    await expectError(
      await request(app, `${url()}${query}`, { headers: bearer("test-admin") }),
      400,
      "validation",
    );
  });

  it("gets the immutable candidate body and conceals unknown proposals", async () => {
    const created = await createProposal({ body: "body from route\n" });
    const response = await request(app, url(`/${created.id}`), {
      headers: bearer("test-admin"),
    });
    expect(response.status).toBe(200);
    await expect(response.json<ProposalWithBody>()).resolves.toMatchObject({
      id: created.id,
      body: "body from route\n",
    });

    await expectError(
      await request(app, url("/prp_0000000000000deadbeef"), {
        headers: bearer("test-admin"),
      }),
      404,
      "not-found",
    );
    await expectError(
      await request(app, url("/invalid"), { headers: bearer("test-admin") }),
      400,
      "validation",
    );
  });

  it("returns immutable diff plus moving current/stale and validates the query", async () => {
    const bindings = createTestEnv().env;
    const store = createStashStore(bindings, { now: () => clock });
    const base = await store.writes.put(STASH, "docs/diff.md", {
      body: "before\n",
      expectedVersion: null,
    });
    if (!base.ok || "unchanged" in base.value) throw new Error("base fixture failed");
    const created = await createProposal(
      { path: "docs/diff.md", body: "candidate\n", baseVersion: 1 },
      { bindings },
    );
    await store.writes.put(STASH, "docs/diff.md", {
      body: "current\n",
      expectedVersion: 1,
    });

    const response = await request(
      app,
      url(`/${created.id}/diff?context=1`),
      {
        headers: bearer("test-admin"),
      },
      bindings,
    );
    expect(response.status).toBe(200);
    const diff = await response.json<ProposalDiffResult>();
    expect(diff).toMatchObject({
      state: "ready",
      base: { version: 1, hash: base.value.hash, deleted: false },
      candidate: { hash: created.hash, size: "candidate\n".length },
      current: { version: 2, deleted: false },
      stale: true,
    });
    if (diff.state !== "ready") throw new Error("expected ready diff");
    expect(diff.unified).toContain("-before");
    expect(diff.unified).toContain("+candidate");

    await expectError(
      await request(app, url(`/${created.id}/diff?context=-1`), {
        headers: bearer("test-admin"),
      }),
      400,
      "validation",
    );
    await expectError(
      await request(app, url("/prp_0000000000000deadbeef/diff"), {
        headers: bearer("test-admin"),
      }),
      404,
      "not-found",
    );
  });
});

describe("proposal decision routes", () => {
  it("approves as admin with overrides and exposes the proposal audit link", async () => {
    const proposal = await createProposal({ author: "bot", message: "original" });
    const response = await request(
      app,
      url(`/${proposal.id}/approve`),
      jsonInit("POST", { author: "reviewer", message: "approved" }),
    );
    expect(response.status).toBe(200);
    const applied = await response.json<ApproveProposalResult>();
    expect(applied).toMatchObject({ status: "applied", appliedVersion: 1 });

    const record = await createStashStore(createTestEnv().env, {
      now: () => clock,
    }).proposals.getProposal(STASH, proposal.id);
    expect(record).toMatchObject({ status: "applied", decidedBy: "admin" });
    const version = await createTestEnv()
      .env.DB.prepare("SELECT author, message, meta_json FROM versions WHERE id = ?")
      .bind(applied.appliedChangeId)
      .first<{ author: string; message: string; meta_json: string }>();
    expect(version).toMatchObject({ author: "reviewer", message: "approved" });
    expect(JSON.parse(version!.meta_json)).toMatchObject({ proposalId: proposal.id });

    clock = Date.parse(proposal.expiresAt);
    const replay = await request(
      app,
      url(`/${proposal.id}/approve`),
      jsonInit("POST", { author: "ignored on replay" }),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(applied);
  });

  it("records the authenticated write-token id for approve and reject", async () => {
    const token = await mintToken(STASH, "write");
    const approved = await createProposal({ path: "approved.md" }, { token: token.token });
    const approve = await request(
      app,
      url(`/${approved.id}/approve`),
      jsonInit("POST", {}, token.token),
    );
    expect(approve.status).toBe(200);

    const rejected = await createProposal({ path: "rejected.md" }, { token: token.token });
    const reject = await request(
      app,
      url(`/${rejected.id}/reject`),
      jsonInit("POST", { reason: "not now" }, token.token),
    );
    expect(reject.status).toBe(200);
    await expect(reject.json()).resolves.toMatchObject({
      id: rejected.id,
      status: "rejected",
      decidedBy: token.id,
      decisionReason: "not now",
    });
    const rereject = await request(
      app,
      url(`/${rejected.id}/reject`),
      jsonInit("POST", { reason: "ignored" }, token.token),
    );
    expect(rereject.status).toBe(200);
    await expect(rereject.json()).resolves.toMatchObject({
      id: rejected.id,
      decisionReason: "not now",
    });

    const approvedRecord = await createStashStore(createTestEnv().env).proposals.getProposal(
      STASH,
      approved.id,
    );
    expect(approvedRecord?.decidedBy).toBe(token.id);
  });

  it("returns stale current and handles expired/rejected/applied precedence", async () => {
    const bindings = createTestEnv().env;
    const store = createStashStore(bindings, { now: () => clock });
    await store.writes.put(STASH, "stale.md", { body: "v1", expectedVersion: null });
    const stale = await createProposal({ path: "stale.md", baseVersion: 1 }, { bindings });
    await store.writes.put(STASH, "stale.md", { body: "v2", expectedVersion: 1 });
    const staleResponse = await request(
      app,
      url(`/${stale.id}/approve`),
      jsonInit("POST", {}),
      bindings,
    );
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      error: { code: "stale" },
      current: { version: 2 },
    });
    await expect(store.proposals.getProposal(STASH, stale.id)).resolves.toMatchObject({
      status: "open",
    });

    const expired = await createProposal(
      {
        path: "expired.md",
        expiresAt: new Date(NOW + 1).toISOString(),
      },
      { bindings },
    );
    clock = NOW + 1;
    await expectError(
      await request(app, url(`/${expired.id}/approve`), jsonInit("POST", {}), bindings),
      409,
      "proposal-expired",
    );
    const rejectExpired = await request(
      app,
      url(`/${expired.id}/reject`),
      jsonInit("POST", { reason: "expired review" }),
      bindings,
    );
    expect(rejectExpired.status).toBe(200);
    await expect(rejectExpired.json()).resolves.toMatchObject({ status: "rejected" });
    await expectError(
      await request(app, url(`/${expired.id}/approve`), jsonInit("POST", {}), bindings),
      409,
      "proposal-closed",
    );

    clock = NOW;
    const applied = await createProposal({ path: "applied.md" }, { bindings });
    expect(
      (await request(app, url(`/${applied.id}/approve`), jsonInit("POST", {}), bindings)).status,
    ).toBe(200);
    await expectError(
      await request(app, url(`/${applied.id}/reject`), jsonInit("POST", {}), bindings),
      409,
      "proposal-closed",
    );
  });

  it("validates decision bodies, size limits, and missing proposals", async () => {
    const proposal = await createProposal();
    await expectError(
      await request(app, url(`/${proposal.id}/approve`), jsonInit("POST", { decidedBy: "caller" })),
      400,
      "validation",
    );
    await expectError(
      await request(
        app,
        url(`/${proposal.id}/approve`),
        jsonInit("POST", { author: "x".repeat(MAX_AUTHOR_BYTES + 1) }),
      ),
      413,
      "payload-too-large",
    );
    await expectError(
      await request(
        app,
        url(`/${proposal.id}/reject`),
        jsonInit("POST", { reason: "x".repeat(MAX_MESSAGE_BYTES + 1) }),
      ),
      413,
      "payload-too-large",
    );
    await expectError(
      await request(app, url("/prp_0000000000000deadbeef/approve"), jsonInit("POST", {})),
      404,
      "not-found",
    );
    await expectError(
      await request(app, url("/prp_0000000000000deadbeef/reject"), jsonInit("POST", {})),
      404,
      "not-found",
    );
  });

  it("rejects malformed decision media types without a transition or replay header", async () => {
    const proposal = await createProposal();

    for (const decision of ["approve", "reject"] as const) {
      const response = await request(
        app,
        url(`/${proposal.id}/${decision}`),
        jsonInit("POST", {}, "test-admin", { "Content-Type": "application/json;" }),
      );
      await expectError(response, 400, "validation");
      expect(response.headers.get("Idempotent-Replayed")).toBeNull();
    }

    await expect(
      createStashStore(createTestEnv().env, { now: () => clock }).proposals.getProposal(
        STASH,
        proposal.id,
      ),
    ).resolves.toMatchObject({ status: "open", decidedAt: null, decidedBy: null });
    await expect(
      createTestEnv()
        .env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM files) AS files",
        )
        .first(),
    ).resolves.toMatchObject({ versions: 0, files: 0 });
  });

  it("rejects read tokens on every write route but permits all read routes", async () => {
    const token = await mintToken(STASH, "read");
    for (const [suffix, body] of [
      ["", { path: "blocked.md", body: "x", baseVersion: null }],
      ["/prp_0000000000000deadbeef/approve", {}],
      ["/prp_0000000000000deadbeef/reject", {}],
    ] as const) {
      await expectError(
        await request(app, url(suffix), jsonInit("POST", body, token.token)),
        403,
        "scope",
      );
    }

    for (const suffix of ["", "/prp_0000000000000deadbeef", "/prp_0000000000000deadbeef/diff"]) {
      const response = await request(app, url(suffix), { headers: bearer(token.token) });
      expect(response.status).not.toBe(403);
    }
  });

  it("returns 401 for unknown credentials and 404 before validation for foreign/deleted stashes", async () => {
    await expectError(
      await request(app, url(), { headers: bearer(`zhs_${"x".repeat(43)}`) }),
      401,
      "unauthorized",
    );

    await seedStash("other-proposal-stash");
    const foreign = await mintToken("other-proposal-stash", "write");
    await expectError(
      await request(app, url(), jsonInit("POST", {}, foreign.token)),
      404,
      "not-found",
    );

    await createTestEnv()
      .env.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?")
      .bind(NOW, STASH)
      .run();
    await expectError(
      await request(app, `${url()}?status=not-valid`, { headers: bearer("test-admin") }),
      404,
      "not-found",
    );
  });
});
