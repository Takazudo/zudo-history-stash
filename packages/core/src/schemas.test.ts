import { describe, expect, expectTypeOf, it } from "vitest";
import { MAX_BODY_BYTES } from "./limits.js";
import type { LiveStatus, StashEvent } from "./types.js";
import {
  ChangesQuery,
  ApproveProposalBody,
  CreateProposalBody,
  CreateStashBody,
  CreateTokenBody,
  DiffCandidateBody,
  DiffQuery,
  EventsQuery,
  FileGetQuery,
  ImportBody,
  ListFilesQuery,
  ListGcRunsQuery,
  ListProposalsQuery,
  ListQuery,
  ListStashesQuery,
  PutFileBody,
  ProposalDiffQuery,
  RejectProposalBody,
  RunGcBody,
  RotateTokenBody,
  STASH_CLIENT_ID_HEADER,
  StashChangeEventSchema,
  StashClientIdSchema,
  StashEventSchema,
  StashProposalEventSchema,
  StashReadyEventSchema,
  StashReconnectEventSchema,
} from "./schemas.js";

const importPut = (createdAt: number) => ({ kind: "put" as const, body: "x", createdAt });
const utf8Body = (bytes: number): string => {
  const multibyteBytes = bytes >= 3 ? 3 : 0;
  return `${"x".repeat(bytes - multibyteBytes)}${multibyteBytes === 3 ? "日" : ""}`;
};

describe("strict request and query schemas", () => {
  it("applies list defaults and parses URL query values", () => {
    expect(ListQuery.parse({})).toEqual({ limit: 50 });
    expect(ListQuery.parse({ limit: "200", after: "a" })).toEqual({ limit: 200, after: "a" });
    expect(ListQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(ListQuery.safeParse({ limit: "", surprise: true }).success).toBe(false);
    expect(ListFilesQuery.parse({ includeDeleted: "true" }).includeDeleted).toBe(true);
    expect(ListStashesQuery.parse({})).toEqual({ limit: 50, includeDeleted: false });
    expect(ListStashesQuery.parse({ includeDeleted: "true", limit: "200" })).toEqual({
      limit: 200,
      includeDeleted: true,
    });
    expect(ListStashesQuery.safeParse({ includeDeleted: "no" }).success).toBe(false);
    expect(ListStashesQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(ListGcRunsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListGcRunsQuery.parse({ kind: "ledger", limit: "200" })).toEqual({
      kind: "ledger",
      limit: 200,
    });
    expect(ListGcRunsQuery.safeParse({ kind: "other" }).success).toBe(false);
    expect(ListGcRunsQuery.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("defaults and bounds GC run bodies while rejecting unknown keys", () => {
    const input: RunGcBody = { kind: "r2-orphans" };
    const parsed = RunGcBody.parse(input);
    expectTypeOf(input.dryRun).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(input.maxObjects).toEqualTypeOf<number | undefined>();
    expectTypeOf(parsed.dryRun).toEqualTypeOf<boolean>();
    expectTypeOf(parsed.maxObjects).toEqualTypeOf<number>();
    expect(parsed).toEqual({
      kind: "r2-orphans",
      dryRun: false,
      maxObjects: 100,
    });
    expect(
      RunGcBody.parse({ kind: "ledger", dryRun: true, maxObjects: 500, cursor: "opaque" }),
    ).toEqual({ kind: "ledger", dryRun: true, maxObjects: 500, cursor: "opaque" });
    expect(RunGcBody.parse({ kind: "ledger", maxObjects: 1 }).maxObjects).toBe(1);
    for (const value of [0, 501, 1.5, -1]) {
      expect(RunGcBody.safeParse({ kind: "ledger", maxObjects: value }).success).toBe(false);
    }
    for (const value of ["r2-orphans", "ledger"]) {
      expect(RunGcBody.safeParse({ kind: value }).success).toBe(true);
    }
    expect(RunGcBody.safeParse({ kind: "ledger", unknown: true }).success).toBe(false);
    expect(RunGcBody.safeParse({ kind: "unknown" }).success).toBe(false);
  });
  it("validates strict proposal creation inputs and platform-owned metadata", () => {
    const valid = {
      path: "docs/proposal.md",
      body: "candidate",
      baseVersion: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(CreateProposalBody.parse(valid)).toEqual(valid);
    expect(CreateProposalBody.safeParse({ ...valid, baseVersion: 1 }).success).toBe(true);
    expect(CreateProposalBody.safeParse({ ...valid, baseVersion: 0 }).success).toBe(false);
    expect(CreateProposalBody.safeParse({ ...valid, path: "../bad" }).success).toBe(false);
    expect(CreateProposalBody.safeParse({ ...valid, body: "\uD800" }).success).toBe(false);
    expect(
      CreateProposalBody.safeParse({ ...valid, expiresAt: "2000-01-01T00:00:00.000Z" }).success,
    ).toBe(false);
    expect(
      CreateProposalBody.safeParse({ ...valid, meta: { proposalId: "caller-owned" } }).success,
    ).toBe(false);
    expect(CreateProposalBody.safeParse({ ...valid, unknown: true }).success).toBe(false);
  });
  it("parses proposal list and diff queries with exact defaults and enums", () => {
    expect(ListProposalsQuery.parse({})).toEqual({ status: "open", limit: 50 });
    expect(
      ListProposalsQuery.parse({
        status: "all",
        path: "docs/proposal.md",
        limit: "200",
        after: "opaque",
      }),
    ).toEqual({
      status: "all",
      path: "docs/proposal.md",
      limit: 200,
      after: "opaque",
    });
    for (const input of [
      { status: "unknown" },
      { path: "../bad" },
      { limit: "201" },
      { unknown: true },
    ]) {
      expect(ListProposalsQuery.safeParse(input).success).toBe(false);
    }
    expect(ProposalDiffQuery.parse({ context: "0" })).toEqual({ context: 0 });
    expect(ProposalDiffQuery.safeParse({ context: "-1" }).success).toBe(false);
  });
  it("bounds strict proposal decision bodies", () => {
    expect(ApproveProposalBody.parse({})).toEqual({});
    expect(ApproveProposalBody.safeParse({ author: "bot", message: "ship" }).success).toBe(true);
    expect(ApproveProposalBody.safeParse({ decidedBy: "caller" }).success).toBe(false);
    expect(RejectProposalBody.parse({})).toEqual({});
    expect(RejectProposalBody.safeParse({ reason: "superseded" }).success).toBe(true);
    expect(RejectProposalBody.safeParse({ reason: "x".repeat(2_001) }).success).toBe(false);
    expect(RejectProposalBody.safeParse({ reason: "\uD800" }).success).toBe(false);
  });
  it("rejects unknown keys in bodies and queries", () => {
    expect(PutFileBody.safeParse({ body: "", expectedVersion: null, extra: true }).success).toBe(
      false,
    );
    expect(FileGetQuery.safeParse({ unknown: "1" }).success).toBe(false);
  });
  it("accepts create-only and rejects negative versions", () => {
    expect(PutFileBody.safeParse({ body: "", expectedVersion: null }).success).toBe(true);
    expect(PutFileBody.safeParse({ body: "x", expectedVersion: -1 }).success).toBe(false);
  });
  it("measures bodies by UTF-8 bytes and preserves empty strings", () => {
    expect(
      PutFileBody.safeParse({ body: utf8Body(MAX_BODY_BYTES), expectedVersion: null }).success,
    ).toBe(true);
    expect(
      PutFileBody.safeParse({ body: utf8Body(MAX_BODY_BYTES + 1), expectedVersion: null }).success,
    ).toBe(false);
    expect(
      PutFileBody.parse({ body: utf8Body(MAX_BODY_BYTES), expectedVersion: null }).body,
    ).toContain("日");
    expect(PutFileBody.safeParse({ body: "\uD800", expectedVersion: null }).success).toBe(false);
    expect(PutFileBody.parse({ body: "", expectedVersion: null }).body).toBe("");
  });
  it("validates stash names", () => {
    expect(CreateStashBody.safeParse({ name: "stash-1" }).success).toBe(true);
    expect(CreateStashBody.safeParse({ name: "Bad" }).success).toBe(false);
  });
  it("makes changes cursors exclusive", () => {
    expect(ChangesQuery.safeParse({ since: "0", limit: "1" }).success).toBe(true);
    expect(ChangesQuery.safeParse({ since: "1", before: "2" }).success).toBe(false);
  });
  it("parses only a strict optional non-negative events cursor", () => {
    expect(EventsQuery.parse({})).toEqual({});
    expect(EventsQuery.parse({ since: "0" })).toEqual({ since: 0 });
    expect(EventsQuery.parse({ since: "42" })).toEqual({ since: 42 });
    for (const input of [
      { since: "" },
      { since: "-1" },
      { since: "1.5" },
      { since: "1", unknown: true },
    ]) {
      expect(EventsQuery.safeParse(input).success).toBe(false);
    }
  });
  it("parses exact diff discriminants", () => {
    expect(DiffQuery.parse({ from: "1", to: "head" })).toMatchObject({ from: 1, to: "head" });
    expect(DiffCandidateBody.safeParse({ from: "head", body: "" }).success).toBe(true);
    expect(DiffCandidateBody.safeParse({ from: 1, body: "", extra: 1 }).success).toBe(false);
  });
  it("accepts one token expiry form and rejects invalid or competing forms", () => {
    expect(CreateTokenBody.parse({ scope: "read", expiresAt: "2026-09-25T00:00:00.000Z" })).toEqual(
      { scope: "read", expiresAt: "2026-09-25T00:00:00.000Z" },
    );
    expect(CreateTokenBody.safeParse({ scope: "write", ttlSeconds: 1 }).success).toBe(true);
    expect(CreateTokenBody.safeParse({ scope: "write", ttlSeconds: 315_360_000 }).success).toBe(
      true,
    );
    for (const input of [
      { scope: "read", expiresAt: "not-a-timestamp" },
      { scope: "read", ttlSeconds: 0 },
      { scope: "read", ttlSeconds: 1.5 },
      { scope: "read", ttlSeconds: 315_360_001 },
      { scope: "read", expiresAt: "2026-09-25T00:00:00.000Z", ttlSeconds: 60 },
      { scope: "read", ttlSeconds: 60, extra: true },
    ]) {
      expect(CreateTokenBody.safeParse(input).success).toBe(false);
    }
  });
  it("defaults and bounds rotation grace while keeping expiry forms exclusive", () => {
    const input: RotateTokenBody = {};
    const parsed = RotateTokenBody.parse(input);
    expectTypeOf(input.graceSeconds).toEqualTypeOf<number | undefined>();
    expectTypeOf(parsed.graceSeconds).toEqualTypeOf<number>();
    expect(parsed).toEqual({ graceSeconds: 300 });
    expect(RotateTokenBody.parse({ graceSeconds: 0 })).toEqual({ graceSeconds: 0 });
    expect(RotateTokenBody.safeParse({ graceSeconds: 86_400 }).success).toBe(true);
    for (const input of [
      { graceSeconds: -1 },
      { graceSeconds: 86_401 },
      { graceSeconds: 1.5 },
      { expiresAt: "2026-09-25T00:00:00.000Z", ttlSeconds: 60 },
      { unknown: true },
    ]) {
      expect(RotateTokenBody.safeParse(input).success).toBe(false);
    }
  });
});

describe("StashClientIdSchema", () => {
  it("accepts only canonical IDs that round-trip unchanged through Fetch headers", () => {
    for (const value of ["a", "tab A!~", "x".repeat(64)]) {
      expect(StashClientIdSchema.parse(value)).toBe(value);

      const headers = new Headers({ [STASH_CLIENT_ID_HEADER]: value });
      const request = new Request("https://stash.example/v1/stashes/demo", { headers });
      expect(request.headers.get(STASH_CLIENT_ID_HEADER)).toBe(value);
    }
  });

  it("rejects values that are non-canonical or unsafe at a Fetch boundary", () => {
    for (const value of [
      "",
      "x".repeat(65),
      " leading",
      "trailing ",
      "internal\ttab",
      "line\nbreak",
      "nul\0byte",
      "delete\u007f",
      "emoji🙂",
    ]) {
      expect(StashClientIdSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("StashEventSchema", () => {
  const ready = { type: "ready", head: 7, checkpoint: 6 } as const;
  const change = {
    type: "change",
    changeId: 7,
    stash: "demo",
    path: "docs/guide.md",
    version: 3,
    kind: "put",
    origin: "viewer-1",
    createdAt: "2026-08-28T00:00:00.000Z",
  } as const;
  const proposal = {
    type: "proposal",
    proposalId: "prp_1787875200000deadbeef",
    stash: "demo",
    path: "docs/guide.md",
    status: "open",
    origin: null,
  } as const;
  const reconnect = { type: "reconnect", reason: "lifetime" } as const;

  it("parses every strict discriminated member and the public union", () => {
    for (const [schema, value] of [
      [StashReadyEventSchema, ready],
      [StashChangeEventSchema, change],
      [StashProposalEventSchema, proposal],
      [StashReconnectEventSchema, reconnect],
    ] as const) {
      expect(schema.parse(value)).toEqual(value);
      expect(StashEventSchema.parse(value)).toEqual(value);
    }
    expectTypeOf(StashEventSchema.parse(change)).toEqualTypeOf<StashEvent>();

    const failed: LiveStatus<{ status: number }> = { failed: { status: 401 } };
    expectTypeOf(failed.failed).toEqualTypeOf<{ status: number }>();
    const lifecycle: LiveStatus = "reconnecting";
    expect(lifecycle).toBe("reconnecting");
  });

  it("rejects cross-member fields, extra fields, and unknown discriminants", () => {
    for (const value of [
      { ...ready, changeId: 7 },
      { ...change, checkpoint: 6 },
      { ...proposal, reason: "shutdown" },
      { ...reconnect, origin: null },
      { ...change, origin: "emoji🙂" },
      { type: "heartbeat" },
    ]) {
      expect(StashEventSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("ImportBody", () => {
  it("accepts null expectedVersion and valid discriminated entries", () => {
    expect(
      ImportBody.safeParse({
        path: "a",
        expectedVersion: null,
        versions: [importPut(1), { kind: "rollback", body: null, rollbackOf: 1, createdAt: 2 }],
      }).success,
    ).toBe(true);
  });
  it("validates its body-carried path", () => {
    expect(
      ImportBody.safeParse({ path: "../bad", expectedVersion: null, versions: [importPut(1)] })
        .success,
    ).toBe(false);
  });
  it("rejects more than 20 entries", () => {
    expect(
      ImportBody.safeParse({
        path: "a",
        expectedVersion: null,
        versions: Array.from({ length: 21 }, (_, index) => importPut(index)),
      }).success,
    ).toBe(false);
  });
  it.each([
    [{ kind: "rollback", body: "not-null", rollbackOf: 1, createdAt: 2 }],
    [{ kind: "put", body: null, createdAt: 1 }],
    [{ kind: "delete", body: "x", createdAt: 1 }],
  ])("rejects a body that contradicts kind", (versions) => {
    expect(ImportBody.safeParse({ path: "a", expectedVersion: 1, versions }).success).toBe(false);
  });
  it("rejects decreasing timestamps, future rollback targets, and imported tombstones", () => {
    const cases = [
      [importPut(2), importPut(1)],
      [importPut(1), { kind: "rollback", body: null, rollbackOf: 2, createdAt: 2 }],
      [
        { kind: "delete", body: null, createdAt: 1 },
        { kind: "rollback", body: null, rollbackOf: 1, createdAt: 2 },
      ],
    ];
    for (const versions of cases) {
      expect(ImportBody.safeParse({ path: "a", expectedVersion: null, versions }).success).toBe(
        false,
      );
    }
  });
});
