import { describe, expect, it } from "vitest";
import {
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  DiffCandidateBody,
  DiffQuery,
  FileGetQuery,
  ImportBody,
  ListFilesQuery,
  ListQuery,
  PutFileBody,
  RotateTokenBody,
} from "./schemas.js";

const importPut = (createdAt: number) => ({ kind: "put" as const, body: "x", createdAt });

describe("strict request and query schemas", () => {
  it("applies list defaults and parses URL query values", () => {
    expect(ListQuery.parse({})).toEqual({ limit: 50 });
    expect(ListQuery.parse({ limit: "200", after: "a" })).toEqual({ limit: 200, after: "a" });
    expect(ListQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(ListQuery.safeParse({ limit: "", surprise: true }).success).toBe(false);
    expect(ListFilesQuery.parse({ includeDeleted: "true" }).includeDeleted).toBe(true);
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
      PutFileBody.safeParse({ body: "日".repeat(300_000), expectedVersion: null }).success,
    ).toBe(true);
    expect(
      PutFileBody.safeParse({ body: "日".repeat(400_000), expectedVersion: null }).success,
    ).toBe(false);
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
    expect(RotateTokenBody.parse({})).toEqual({ graceSeconds: 300 });
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
