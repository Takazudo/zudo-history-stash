import { describe, expect, expectTypeOf, it } from "vitest";
import { MAX_BODY_BYTES } from "./limits.js";
import {
  ChangesQuery,
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  CreateChangeSetBody,
  CreateCommitBody,
  CreateStashBody,
  CreateTokenBody,
  DiffCandidateBody,
  DiffQuery,
  EventsQuery,
  FileGetQuery,
  ImportBody,
  ListFilesQuery,
  ListGcRunsQuery,
  ListChangeSetsQuery,
  ListCommitsQuery,
  ListQuery,
  ListStashesQuery,
  PutFileBody,
  RejectChangeSetBody,
  SnapshotQuery,
  RunGcBody,
  RotateTokenBody,
  STASH_CLIENT_ID_HEADER,
  StashClientIdSchema,
  StashEventSchema,
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

const put = { op: "put", path: "docs/a.md", expectedVersion: null, body: "a" } as const;

describe("commit and change-set request schemas", () => {
  it("accepts every commit entry shape with strict integer versions", () => {
    const entries = [
      put,
      {
        op: "put",
        path: "bin/a",
        expectedVersion: 1,
        representation: "binary",
        contentType: "application/octet-stream",
        bytesBase64: "AA==",
      },
      { op: "copy", path: "copy/a", expectedVersion: null, from: { path: "source/a", version: 1 } },
      { op: "delete", path: "delete/a", expectedVersion: 1 },
      { op: "rollback", path: "rollback/a", expectedVersion: 2, toVersion: 1 },
    ];
    expect(CreateCommitBody.safeParse({ entries }).success).toBe(true);
    expect(
      CreateCommitBody.safeParse({ entries: [{ ...put, expectedVersion: 1.5 }] }).success,
    ).toBe(false);
  });
  it("enforces entry count, unique paths, copy isolation, and platform metadata", () => {
    expect(CreateCommitBody.safeParse({ entries: [] }).success).toBe(false);
    expect(
      CreateCommitBody.safeParse({
        entries: Array.from({ length: 21 }, (_, index) => ({ ...put, path: `p/${index}` })),
      }).success,
    ).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: [put, put] }).success).toBe(false);
    expect(
      CreateCommitBody.safeParse({
        entries: [
          put,
          { op: "copy", path: "copy", expectedVersion: null, from: { path: put.path, version: 1 } },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateCommitBody.safeParse({ entries: [put], meta: { commitId: "caller" } }).success,
    ).toBe(false);
    expect(
      CreateCommitBody.safeParse({ entries: [put], meta: { changeSetId: "caller" } }).success,
    ).toBe(false);
  });
  it("uses baseVersion for change-set entries", () => {
    const entry = { op: "put", path: "docs/a.md", baseVersion: null, body: "a" };
    expect(CreateChangeSetBody.safeParse({ entries: [entry] }).success).toBe(true);
    expect(
      CreateChangeSetBody.safeParse({ entries: [{ ...entry, expectedVersion: null }] }).success,
    ).toBe(false);
    expect(ApproveChangeSetBody.parse({})).toEqual({});
    expect(RejectChangeSetBody.safeParse({ reason: "x".repeat(2_001) }).success).toBe(false);
  });
  it("parses list, diff, snapshot, and hierarchical file filters", () => {
    expect(ListCommitsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListChangeSetsQuery.parse({})).toEqual({ status: "open", limit: 50 });
    expect(CommitDiffQuery.parse({ context: "0" })).toEqual({ context: 0 });
    expect(ChangeSetDiffQuery.safeParse({ path: "../bad" }).success).toBe(false);
    expect(SnapshotQuery.parse({ at: "commit:cmt_1" })).toMatchObject({
      at: "commit:cmt_1",
      includeDeleted: false,
      limit: 50,
    });
    expect(ListFilesQuery.parse({ prefix: "docs/", delimiter: "/" })).toMatchObject({
      prefix: "docs/",
      delimiter: "/",
    });
  });
});

describe("stash event schemas", () => {
  it("requires commit grouping and accepts advisory frames", () => {
    const change = {
      type: "change",
      changeId: 1,
      commitId: "cmt_1",
      stash: "demo",
      path: "a",
      version: 1,
      kind: "put",
      origin: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    expect(StashEventSchema.safeParse(change).success).toBe(true);
    expect(StashEventSchema.safeParse({ ...change, commitId: undefined }).success).toBe(false);
    expect(
      StashEventSchema.safeParse({
        type: "commit",
        commitId: "cmt_1",
        stash: "demo",
        entryCount: 1,
        firstChangeId: 1,
        lastChangeId: 1,
        origin: null,
      }).success,
    ).toBe(true);
    expect(
      StashEventSchema.safeParse({
        type: "change-set",
        changeSetId: "chs_1",
        stash: "demo",
        status: "open",
        paths: ["a"],
        origin: null,
      }).success,
    ).toBe(true);
  });
});
