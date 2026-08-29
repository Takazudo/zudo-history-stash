import { describe, expect, it } from "vitest";
import {
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  CreateChangeSetBody,
  CreateCommitBody,
  ListChangeSetsQuery,
  ListCommitsQuery,
  ListFilesQuery,
  RejectChangeSetBody,
  SnapshotQuery,
  StashEventSchema,
} from "./schemas.js";

const put = { op: "put", path: "docs/a.md", expectedVersion: null, body: "a" } as const;

describe("commit and change-set request schemas", () => {
  it("accepts every commit entry shape with strict integer versions", () => {
    const entries = [
      put,
      { op: "put", path: "bin/a", expectedVersion: 1, representation: "binary", contentType: "application/octet-stream", bytesBase64: "AA==" },
      { op: "copy", path: "copy/a", expectedVersion: null, from: { path: "source/a", version: 1 } },
      { op: "delete", path: "delete/a", expectedVersion: 1 },
      { op: "rollback", path: "rollback/a", expectedVersion: 2, toVersion: 1 },
    ];
    expect(CreateCommitBody.safeParse({ entries }).success).toBe(true);
    expect(CreateCommitBody.safeParse({ entries: [{ ...put, expectedVersion: 1.5 }] }).success).toBe(false);
  });
  it("enforces entry count, unique paths, copy isolation, and platform metadata", () => {
    expect(CreateCommitBody.safeParse({ entries: [] }).success).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: Array.from({ length: 21 }, (_, index) => ({ ...put, path: `p/${index}` })) }).success).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: [put, put] }).success).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: [put, { op: "copy", path: "copy", expectedVersion: null, from: { path: put.path, version: 1 } }] }).success).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: [put], meta: { commitId: "caller" } }).success).toBe(false);
    expect(CreateCommitBody.safeParse({ entries: [put], meta: { changeSetId: "caller" } }).success).toBe(false);
  });
  it("uses baseVersion for change-set entries", () => {
    const entry = { op: "put", path: "docs/a.md", baseVersion: null, body: "a" };
    expect(CreateChangeSetBody.safeParse({ entries: [entry] }).success).toBe(true);
    expect(CreateChangeSetBody.safeParse({ entries: [{ ...entry, expectedVersion: null }] }).success).toBe(false);
    expect(ApproveChangeSetBody.parse({})).toEqual({});
    expect(RejectChangeSetBody.safeParse({ reason: "x".repeat(2_001) }).success).toBe(false);
  });
  it("parses list, diff, snapshot, and hierarchical file filters", () => {
    expect(ListCommitsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListChangeSetsQuery.parse({})).toEqual({ status: "open", limit: 50 });
    expect(CommitDiffQuery.parse({ context: "0" })).toEqual({ context: 0 });
    expect(ChangeSetDiffQuery.safeParse({ path: "../bad" }).success).toBe(false);
    expect(SnapshotQuery.parse({ at: "commit:cmt_1" })).toMatchObject({ at: "commit:cmt_1", includeDeleted: false, limit: 50 });
    expect(ListFilesQuery.parse({ prefix: "docs/", delimiter: "/" })).toMatchObject({ prefix: "docs/", delimiter: "/" });
  });
});

describe("stash event schemas", () => {
  it("requires commit grouping and accepts advisory frames", () => {
    const change = { type: "change", changeId: 1, commitId: "cmt_1", stash: "demo", path: "a", version: 1, kind: "put", origin: null, createdAt: "2026-08-29T00:00:00.000Z" };
    expect(StashEventSchema.safeParse(change).success).toBe(true);
    expect(StashEventSchema.safeParse({ ...change, commitId: undefined }).success).toBe(false);
    expect(StashEventSchema.safeParse({ type: "commit", commitId: "cmt_1", stash: "demo", entryCount: 1, firstChangeId: 1, lastChangeId: 1, origin: null }).success).toBe(true);
    expect(StashEventSchema.safeParse({ type: "change-set", changeSetId: "chs_1", stash: "demo", status: "open", paths: ["a"], origin: null }).success).toBe(true);
  });
});
