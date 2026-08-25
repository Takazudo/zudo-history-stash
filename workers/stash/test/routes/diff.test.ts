import {
  DIFF_MAX_BYTES,
  MAX_BODY_BYTES,
  computeDiff,
  type DiffResult,
} from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import type { AppEnv } from "../../src/context.js";
import type { ReadVersionRecord, StashReads } from "../../src/d1/reads.js";
import { createDiffRoutes } from "../../src/routes/diff.js";
import { bearer, mintToken, request, resetDatabase } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";
import { READ_FIXTURE_STASH, seedReadRows } from "../helpers/seed-rows.js";

const encoder = new TextEncoder();
const baseUrl = `http://example.test/v1/stashes/${READ_FIXTURE_STASH}/diff`;

async function getDiff(path: string, query: string, token = "test-admin"): Promise<Response> {
  return request(app, `${baseUrl}/${path}?${query}`, { headers: bearer(token) });
}

async function postCandidate(
  path: string,
  payload: unknown,
  token = "test-admin",
): Promise<Response> {
  return request(app, `${baseUrl}/${path}`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function seedLiveFile(path: string, bodies: readonly string[]): Promise<string[]> {
  const db = createTestEnv().env.DB;
  const hashes: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const version = index + 1;
    const hash = `route-hash-${path}-${version}`;
    const createdAt = 1_700_100_000_000 + version;
    hashes.push(hash);
    await db
      .prepare(
        "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
      )
      .bind(READ_FIXTURE_STASH, hash, body, encoder.encode(body).byteLength, createdAt)
      .run();
    await db
      .prepare(
        `INSERT INTO versions (
          stash_name, path, version, kind, blob_hash, size_bytes, content_type,
          rollback_of, author, message, meta_json, created_at
        ) VALUES (?, ?, ?, 'put', ?, ?, 'text/plain; charset=utf-8', NULL, '', '', '{}', ?)`,
      )
      .bind(READ_FIXTURE_STASH, path, version, hash, encoder.encode(body).byteLength, createdAt)
      .run();
  }
  const headVersion = bodies.length;
  await db
    .prepare(
      `INSERT INTO files (
        stash_name, path, head_version, head_hash, deleted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      READ_FIXTURE_STASH,
      path,
      headVersion,
      hashes.at(-1),
      1_700_100_000_001,
      1_700_100_000_000 + headVersion,
    )
    .run();
  return hashes;
}

function version(versionNumber: number, hash: string): ReadVersionRecord {
  return {
    version: versionNumber,
    kind: "put",
    hash,
    size: 5,
    rollbackOf: null,
    author: "fixture",
    message: "",
    meta: {},
    createdAt: new Date(versionNumber).toISOString(),
  };
}

beforeEach(async () => {
  await resetDatabase();
  await seedReadRows();
});

describe("GET stash diff", () => {
  it("returns core unified text and hunks byte-for-byte with correct stats", async () => {
    const response = await getDiff("alpha.txt", "from=1&to=2&context=1");
    expect(response.status).toBe(200);

    const expected = computeDiff({
      fromText: "alpha v1\n",
      toText: "alpha v2\n",
      fromLabel: "a/alpha.txt@v1",
      toLabel: "b/alpha.txt@v2",
      context: 1,
    });
    const json = await response.json<
      DiffResult & {
        from: { version: number; hash: string | null; deleted: boolean };
        to: { version: number; hash: string | null; deleted: boolean };
      }
    >();
    expect(json).toEqual({
      ...expected,
      from: { version: 1, hash: "sha256-alpha-one", deleted: false },
      to: { version: 2, hash: "sha256-alpha-two", deleted: false },
    });
    expect(json.state).toBe("ready");
    if (json.state !== "ready" || expected.state !== "ready") {
      throw new Error("expected a ready diff");
    }
    expect(json.unified).toBe(expected.unified);
    expect(json.hunks).toEqual(expected.hunks);
    expect(json.stats).toEqual({ added: 1, removed: 1 });
  });

  it("resolves the head label to its numeric version", async () => {
    const response = await getDiff("beta.txt", "from=2&to=head");
    expect(response.status).toBe(200);
    const json = await response.json<{
      state: string;
      unified: string;
      to: { version: number };
    }>();
    expect(json.state).toBe("ready");
    expect(json.to.version).toBe(3);
    expect(json.unified).toContain("--- a/beta.txt@v2");
    expect(json.unified).toContain("+++ b/beta.txt@v3");
    expect(json.unified).not.toContain("@head");
  });

  it("preserves nested wildcard paths in diff labels", async () => {
    await seedLiveFile("docs/nested.txt", ["before\n", "after\n"]);
    const response = await getDiff("docs/nested.txt", "from=1&to=head");
    expect(response.status).toBe(200);
    const json = await response.json<{ state: string; unified: string }>();
    expect(json.state).toBe("ready");
    expect(json.unified).toContain("--- a/docs/nested.txt@v1");
    expect(json.unified).toContain("+++ b/docs/nested.txt@v2");
  });

  it("treats a tombstone as empty text on either side", async () => {
    const toTombstone = await getDiff("alpha.txt", "from=2&to=head");
    expect(toTombstone.status).toBe(200);
    await expect(toTombstone.json()).resolves.toMatchObject({
      state: "ready",
      from: { version: 2, deleted: false },
      to: { version: 3, hash: null, deleted: true },
      stats: { added: 0, removed: 1 },
    });

    const fromTombstone = await getDiff("alpha.txt", "from=3&to=2");
    expect(fromTombstone.status).toBe(200);
    await expect(fromTombstone.json()).resolves.toMatchObject({
      state: "ready",
      from: { version: 3, hash: null, deleted: true },
      to: { version: 2, deleted: false },
      stats: { added: 1, removed: 0 },
    });
  });

  it("returns same for equal hashes without loading either body", async () => {
    const versions = [version(2, "same-hash"), version(1, "same-hash")];
    const getFile: StashReads["getFile"] = vi.fn(async () => null);
    const listHistory: StashReads["listHistory"] = vi.fn(async (_stash, path, options = {}) => {
      const before = options.before ?? Number.POSITIVE_INFINITY;
      return {
        path,
        headVersion: 2,
        deleted: false,
        total: 2,
        versions: versions
          .filter((candidate) => candidate.version < before)
          .slice(0, options.limit ?? 50),
        nextBefore: null,
      };
    });
    const routeApp = new Hono<AppEnv>();
    routeApp.use("*", async (c, next) => {
      c.set("principal", { kind: "admin" });
      await next();
    });
    routeApp.route("/", createDiffRoutes({ createReads: () => ({ getFile, listHistory }) }));

    const response = await request(
      routeApp,
      "http://example.test/v1/stashes/fake/diff/equal.txt?from=1&to=head",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "same",
      from: { version: 1, hash: "same-hash", deleted: false },
      to: { version: 2, hash: "same-hash", deleted: false },
    });
    expect(getFile).not.toHaveBeenCalled();
  });

  it("retries a head observation interrupted by a concurrent commit", async () => {
    const versions = [version(2, "same-hash"), version(1, "same-hash")];
    let observations = 0;
    const getFile: StashReads["getFile"] = vi.fn(async () => null);
    const listHistory: StashReads["listHistory"] = vi.fn(async (_stash, path, options = {}) => {
      observations += 1;
      if (observations === 1) {
        return {
          path,
          headVersion: 1,
          deleted: false,
          total: 1,
          versions: [versions[0]!],
          nextBefore: null,
        };
      }
      const before = options.before ?? Number.POSITIVE_INFINITY;
      return {
        path,
        headVersion: 2,
        deleted: false,
        total: 2,
        versions: versions
          .filter((candidate) => candidate.version < before)
          .slice(0, options.limit ?? 50),
        nextBefore: null,
      };
    });
    const routeApp = new Hono<AppEnv>();
    routeApp.use("*", async (c, next) => {
      c.set("principal", { kind: "admin" });
      await next();
    });
    routeApp.route("/", createDiffRoutes({ createReads: () => ({ getFile, listHistory }) }));

    const response = await request(
      routeApp,
      "http://example.test/v1/stashes/fake/diff/racy.txt?from=1&to=head",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: "same" });
    expect(listHistory).toHaveBeenCalledTimes(3);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("returns both byte and complexity oversized states", async () => {
    await seedLiveFile("oversized.txt", ["a".repeat(DIFF_MAX_BYTES + 1), "small\n"]);
    const bytes = await getDiff("oversized.txt", "from=1&to=2");
    expect(bytes.status).toBe(200);
    await expect(bytes.json()).resolves.toMatchObject({
      state: "oversized",
      reason: "bytes",
    });

    await seedLiveFile("complexity.txt", ["", "new\n".repeat(50_001)]);
    const complexity = await getDiff("complexity.txt", "from=1&to=2");
    expect(complexity.status).toBe(200);
    await expect(complexity.json()).resolves.toMatchObject({
      state: "oversized",
      reason: "complexity",
    });
  });

  it("passes maxUnifiedBytes through for line-safe truncation", async () => {
    const response = await getDiff("alpha.txt", "from=1&to=2&maxUnifiedBytes=0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "ready",
      unified: "",
      truncated: true,
      hunks: expect.any(Array),
    });
  });

  it("returns version-not-found for either unknown side", async () => {
    for (const query of ["from=99&to=head", "from=1&to=99"]) {
      const response = await getDiff("alpha.txt", query);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "version-not-found" },
      });
    }
  });

  it("rejects context above ten", async () => {
    const response = await getDiff("alpha.txt", "from=1&to=2&context=11");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "validation", message: "Invalid diff query." },
    });
  });
});

describe("POST candidate diff", () => {
  it.each([
    { from: "head" as const, expectedVersion: 3 },
    { from: 1 as const, expectedVersion: 1 },
  ])("diffs a candidate against $from with numeric source labels", async (fixture) => {
    const response = await postCandidate("beta.txt", {
      from: fixture.from,
      body: "candidate\n",
      context: 2,
    });
    expect(response.status).toBe(200);
    const json = await response.json<{ state: string; unified: string; stats: unknown }>();
    expect(json.state).toBe("ready");
    expect(json.unified).toContain(`--- a/beta.txt@v${fixture.expectedVersion}`);
    expect(json.unified).toContain("+++ b/beta.txt@candidate");
    expect(json.unified).not.toContain("@head");
    expect(json.stats).toEqual({ added: 1, removed: 1 });
  });

  it("allows a read-scope token and never writes candidate content", async () => {
    const token = await mintToken(READ_FIXTURE_STASH, "read");
    const db = createTestEnv().env.DB;
    const before = await db
      .prepare("SELECT COUNT(*) AS count FROM versions WHERE stash_name = ?")
      .bind(READ_FIXTURE_STASH)
      .first<{ count: number }>();

    const response = await postCandidate(
      "beta.txt",
      { from: "head", body: "read-token candidate\n" },
      token.token,
    );
    expect(response.status).toBe(200);
    const after = await db
      .prepare("SELECT COUNT(*) AS count FROM versions WHERE stash_name = ?")
      .bind(READ_FIXTURE_STASH)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("treats a tombstoned source as empty text", async () => {
    const response = await postCandidate("alpha.txt", { from: "head", body: "restored\n" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "ready",
      stats: { added: 1, removed: 0 },
    });
  });

  it("rejects invalid context and unknown source versions", async () => {
    const invalidContext = await postCandidate("beta.txt", {
      from: "head",
      body: "candidate\n",
      context: 11,
    });
    expect(invalidContext.status).toBe(400);
    await expect(invalidContext.json()).resolves.toMatchObject({
      error: { code: "validation" },
    });

    const missingVersion = await postCandidate("beta.txt", {
      from: 99,
      body: "candidate\n",
    });
    expect(missingVersion.status).toBe(404);
    await expect(missingVersion.json()).resolves.toMatchObject({
      error: { code: "version-not-found" },
    });
  });

  it("maps candidate body well-formedness and byte limits like PUT", async () => {
    const malformed = await postCandidate("beta.txt", { from: 1, body: "\ud800" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "body-not-well-formed" },
    });

    const oversized = await postCandidate("beta.txt", {
      from: 1,
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "payload-too-large" },
    });
  });

  it("uses a generic validation error without echoing rejected bodies", async () => {
    const marker = "ZHS_CANDIDATE_BODY_MUST_NOT_BE_ECHOED";
    const response = await postCandidate("beta.txt", {
      from: 1,
      body: marker,
      unexpected: true,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toEqual({
      error: { code: "validation", message: "Invalid candidate diff input." },
    });
  });
});
