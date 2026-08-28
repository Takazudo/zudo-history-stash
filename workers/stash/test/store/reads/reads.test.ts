import { beforeEach, describe, expect, it } from "vitest";
import { createStashStore } from "../../../src/d1/store.js";
import { resetDatabase } from "../../helpers/app.js";
import { createTestEnv } from "../../helpers/env.js";
import { READ_FIXTURE_STASH, seedReadRows } from "../../helpers/seed-rows.js";

const env = () => createTestEnv();

async function createFixtureReads() {
  const testEnv = env();
  await seedReadRows();
  return createStashStore(testEnv.env, testEnv.deps).reads;
}

describe("StashStore reads", () => {
  beforeEach(resetDatabase);

  describe("getFile", () => {
    it("reads a live head, an older version, a rollback head, and a tombstone", async () => {
      const reads = await createFixtureReads();

      await expect(reads.getFile(READ_FIXTURE_STASH, "gamma.txt")).resolves.toMatchObject({
        path: "gamma.txt",
        version: 1,
        hash: "sha256-gamma-one",
        size: 9,
        kind: "put",
        rollbackOf: null,
        author: "dave",
        message: "gamma first",
        meta: { step: 1 },
        createdAt: "2023-11-14T22:13:20.071Z",
        deleted: false,
        body: "gamma v1\n",
        contentType: "text/plain; charset=utf-8",
        representation: "text",
        contentAccess: "inline",
        byteSize: 9,
        etag: "sha256-gamma-one",
      });

      await expect(reads.getFile(READ_FIXTURE_STASH, "alpha.txt", { version: 2 })).resolves.toEqual(
        expect.objectContaining({
          path: "alpha.txt",
          version: 2,
          kind: "put",
          body: "alpha v2\n",
          contentType: "text/markdown",
          deleted: false,
        }),
      );

      await expect(reads.getFile(READ_FIXTURE_STASH, "beta.txt")).resolves.toEqual(
        expect.objectContaining({
          version: 3,
          kind: "rollback",
          rollbackOf: 1,
          hash: "sha256-beta-one",
          body: "beta v1\n",
          deleted: false,
        }),
      );

      await expect(reads.getFile(READ_FIXTURE_STASH, "alpha.txt")).resolves.toEqual(
        expect.objectContaining({
          path: "alpha.txt",
          version: 3,
          kind: "delete",
          hash: null,
          size: 0,
          body: null,
          deleted: true,
        }),
      );
    });

    it("returns null for an unknown file and an unknown version", async () => {
      const reads = await createFixtureReads();
      await expect(reads.getFile(READ_FIXTURE_STASH, "missing.txt")).resolves.toBeNull();
      await expect(
        reads.getFile(READ_FIXTURE_STASH, "alpha.txt", { version: 99 }),
      ).resolves.toBeNull();
    });
  });

  describe("listFiles", () => {
    it("excludes tombstones by default and includes them when requested", async () => {
      const reads = await createFixtureReads();
      await expect(reads.listFiles(READ_FIXTURE_STASH)).resolves.toMatchObject({
        files: [
          { path: "beta.txt", deleted: false },
          { path: "gamma.txt", deleted: false },
        ],
        nextAfter: null,
      });
      await expect(
        reads.listFiles(READ_FIXTURE_STASH, { includeDeleted: true }),
      ).resolves.toMatchObject({
        files: [
          { path: "alpha.txt", deleted: true },
          { path: "beta.txt", deleted: false },
          { path: "gamma.txt", deleted: false },
        ],
        nextAfter: null,
      });
    });

    it("paginates by path without gaps or duplicates", async () => {
      const reads = await createFixtureReads();
      const paths: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await reads.listFiles(READ_FIXTURE_STASH, {
          includeDeleted: true,
          limit: 1,
          after,
        });
        paths.push(...page.files.map((file) => file.path));
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      }
      expect(paths).toEqual(["alpha.txt", "beta.txt", "gamma.txt"]);
      expect(new Set(paths).size).toBe(paths.length);
    });
  });

  describe("listHistory", () => {
    it("returns totals, newest-first versions, and a continuous before cursor", async () => {
      const reads = await createFixtureReads();
      const first = await reads.listHistory(READ_FIXTURE_STASH, "beta.txt", { limit: 2 });
      expect(first).toMatchObject({
        path: "beta.txt",
        headVersion: 3,
        deleted: false,
        total: 3,
        versions: [
          { version: 3, kind: "rollback" },
          { version: 2, kind: "put" },
        ],
        nextBefore: 2,
      });

      const second = await reads.listHistory(READ_FIXTURE_STASH, "beta.txt", {
        limit: 2,
        before: first?.nextBefore ?? undefined,
      });
      expect(second).toMatchObject({
        total: 3,
        versions: [{ version: 1, kind: "put" }],
        nextBefore: null,
      });
      expect(second?.versions.map((version) => version.version)).not.toEqual(
        expect.arrayContaining(first?.versions.map((version) => version.version) ?? []),
      );
    });

    it("returns a tombstoned head and null for an unknown path", async () => {
      const reads = await createFixtureReads();
      await expect(
        reads.listHistory(READ_FIXTURE_STASH, "alpha.txt", { limit: 1 }),
      ).resolves.toMatchObject({
        headVersion: 3,
        deleted: true,
        total: 3,
        versions: [{ version: 3, kind: "delete", hash: null }],
        nextBefore: 3,
      });
      await expect(reads.listHistory(READ_FIXTURE_STASH, "missing.txt")).resolves.toBeNull();
    });
  });

  describe("listChanges", () => {
    it("paginates since ascending without gaps or duplicates", async () => {
      const reads = await createFixtureReads();
      const ids: number[] = [];
      let since = 0;
      for (;;) {
        const page = await reads.listChanges(READ_FIXTURE_STASH, { since, limit: 2 });
        ids.push(...page.changes.map((change) => change.changeId));
        if (!("nextSince" in page) || page.nextSince === null) {
          expect(page.hasMore).toBe(false);
          break;
        }
        expect(page.hasMore).toBe(true);
        since = page.nextSince;
      }
      expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("paginates before descending and defaults to newest-first", async () => {
      const reads = await createFixtureReads();
      const first = await reads.listChanges(READ_FIXTURE_STASH, { before: 8, limit: 2 });
      if (!("nextBefore" in first)) throw new Error("expected a descending changes page");
      expect(first).toMatchObject({
        changes: [{ changeId: 7 }, { changeId: 6 }],
        nextBefore: 6,
        hasMore: true,
      });
      const second = await reads.listChanges(READ_FIXTURE_STASH, {
        before: first.nextBefore ?? undefined,
        limit: 2,
      });
      expect(second.changes.map((change) => change.changeId)).toEqual([5, 4]);

      const newest = await reads.listChanges(READ_FIXTURE_STASH, { limit: 2 });
      expect(newest).toMatchObject({
        changes: [{ changeId: 7 }, { changeId: 6 }],
        nextBefore: 6,
        hasMore: true,
      });
    });
  });

  describe("validation", () => {
    it.each([
      () =>
        createFixtureReads().then((reads) => reads.listFiles(READ_FIXTURE_STASH, { limit: 201 })),
      () =>
        createFixtureReads().then((reads) =>
          reads.listHistory(READ_FIXTURE_STASH, "alpha.txt", { limit: 201 }),
        ),
      () =>
        createFixtureReads().then((reads) => reads.listChanges(READ_FIXTURE_STASH, { limit: 201 })),
    ])("rejects a limit above the maximum instead of clamping", async (operation) => {
      await expect(operation()).rejects.toMatchObject({ code: "validation", status: 400 });
    });

    it("applies the default limit and rejects both change cursors", async () => {
      const reads = await createFixtureReads();
      const defaultFiles = await reads.listFiles(READ_FIXTURE_STASH);
      expect(defaultFiles.files.map((file) => file.path)).toEqual(["beta.txt", "gamma.txt"]);
      expect(defaultFiles.nextAfter).toBeNull();
      await expect(reads.listHistory(READ_FIXTURE_STASH, "beta.txt")).resolves.toMatchObject({
        total: 3,
      });
      await expect(reads.listChanges(READ_FIXTURE_STASH)).resolves.toMatchObject({
        changes: expect.any(Array),
        hasMore: false,
      });
      await expect(
        reads.listChanges(READ_FIXTURE_STASH, { since: 1, before: 2 }),
      ).rejects.toMatchObject({ code: "validation", status: 400 });
    });
  });
});
