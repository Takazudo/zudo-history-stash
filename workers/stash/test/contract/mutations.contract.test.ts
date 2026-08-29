import { createStashClient, isCommitConflict } from "@takazudo/zudo-history-stash";
import { describe, expect, it } from "vitest";
import { API_BASE_URL, MUTATION_ALLOWED } from "./env.js";
import { createAdminClient, uniqueStash, unwrap } from "./helpers.js";

const EXPIRY_MARGIN_MS = 100;
const MAX_BOUNDARY_WAIT_MS = 15_000;
const LARGE_FILE_BYTES = 1_500_000;
const LARGE_FILE_PREFIX = "History Stash R2 large-file fixture\n";
const LARGE_FILE_SUFFIX = "\nHistory Stash R2 large-file fixture end\n";
const LARGE_FILE_LINE = `${"x".repeat(4_095)}\n`;

function largeFileBody(): string {
  const fillBytes = LARGE_FILE_BYTES - LARGE_FILE_PREFIX.length - LARGE_FILE_SUFFIX.length;
  const body = `${LARGE_FILE_PREFIX}${LARGE_FILE_LINE.repeat(
    Math.floor(fillBytes / LARGE_FILE_LINE.length),
  )}${"x".repeat(fillBytes % LARGE_FILE_LINE.length)}${LARGE_FILE_SUFFIX}`;
  if (body.length !== LARGE_FILE_BYTES) throw new Error("Large-file fixture size drifted");
  return body;
}

async function waitUntilAfter(expiresAt: string): Promise<void> {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new Error(`Invalid expiry timestamp: ${expiresAt}`);

  const target = expiresAtMs + EXPIRY_MARGIN_MS;
  const waitMs = target - Date.now();
  if (waitMs > MAX_BOUNDARY_WAIT_MS) {
    throw new Error(`Expiry boundary is more than ${MAX_BOUNDARY_WAIT_MS}ms in the future`);
  }
  if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  if (Date.now() <= expiresAtMs) throw new Error("Expiry boundary wait completed too early");
}

describe("local-only HTTP mutation contract", () => {
  it.runIf(MUTATION_ALLOWED)("expires a ttlSeconds token as unauthorized", async () => {
    const admin = createAdminClient();
    const stash = uniqueStash("expiry");
    unwrap(await admin.stashes.create({ name: stash }), "create expiry fixture stash");

    const mintStartedAt = Date.now();
    const token = unwrap(
      await admin.stashes.tokens(stash).create({
        label: "contract-expiring",
        scope: "read",
        ttlSeconds: 1,
      }),
      "mint expiring token",
    );
    if (token.expiresAt === null) throw new Error("ttlSeconds token did not return expiresAt");
    expect(Object.keys(token).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "label",
      "rotatedFrom",
      "scope",
      "token",
    ]);
    expect(token.label).toBe("contract-expiring");
    expect(token.scope).toBe("read");
    expect(token.rotatedFrom).toBeNull();
    expect(/^tok_[0-9a-f]{32}$/u.test(token.id)).toBe(true);
    expect(/^zhs_[A-Za-z0-9_-]{43}$/u.test(token.token)).toBe(true);
    expect(Number.isFinite(Date.parse(token.createdAt))).toBe(true);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(mintStartedAt);
    expect(Date.parse(token.expiresAt) - Date.parse(token.createdAt)).toBe(1_000);

    await waitUntilAfter(token.expiresAt);
    const expired = await createStashClient({ baseUrl: API_BASE_URL, token: token.token }).me();
    expect(expired).toEqual({
      ok: false,
      error: {
        status: 401,
        code: "unauthorized",
        message: "A valid bearer token is required.",
      },
    });
  });

  it.runIf(MUTATION_ALLOWED)(
    "honors rotation grace and reports the one-shot successor",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("rotation");
      unwrap(await admin.stashes.create({ name: stash }), "create rotation fixture stash");

      const predecessor = unwrap(
        await admin.stashes.tokens(stash).create({
          label: "contract-rotation",
          scope: "read",
        }),
        "mint rotation predecessor",
      );
      expect(predecessor.expiresAt).toBeNull();

      const successor = unwrap(
        await admin.stashes.tokens(stash).rotate(predecessor.id, { graceSeconds: 5 }),
        "rotate predecessor",
      );
      expect(successor).toMatchObject({
        label: predecessor.label,
        scope: predecessor.scope,
        expiresAt: null,
        rotatedFrom: predecessor.id,
        predecessor: { id: predecessor.id },
      });
      expect(/^tok_[0-9a-f]{32}$/u.test(successor.id)).toBe(true);
      expect(/^zhs_[A-Za-z0-9_-]{43}$/u.test(successor.token)).toBe(true);
      expect(successor.token === predecessor.token).toBe(false);
      if (successor.predecessor.expiresAt === null) {
        throw new Error("rotated predecessor did not return a grace expiry");
      }

      const predecessorClient = createStashClient({
        baseUrl: API_BASE_URL,
        token: predecessor.token,
      });
      const successorClient = createStashClient({ baseUrl: API_BASE_URL, token: successor.token });
      expect(unwrap(await predecessorClient.me(), "predecessor during grace")).toMatchObject({
        principal: "stash",
        stash,
        tokenId: predecessor.id,
        scope: "read",
        expiresAt: successor.predecessor.expiresAt,
      });
      expect(unwrap(await successorClient.me(), "successor during grace")).toMatchObject({
        principal: "stash",
        stash,
        tokenId: successor.id,
        scope: "read",
        expiresAt: null,
      });

      const secondRotation = await admin.stashes
        .tokens(stash)
        .rotate(predecessor.id, { graceSeconds: 5 });
      expect(secondRotation).toEqual({
        ok: false,
        error: {
          status: 409,
          code: "already-rotated",
          message: "Token was already rotated.",
          successorId: successor.id,
        },
      });

      const listed = unwrap(await admin.stashes.tokens(stash).list(), "list rotated tokens");
      expect(listed.tokens).toHaveLength(2);
      expect(listed.tokens.filter(({ rotatedFrom }) => rotatedFrom === predecessor.id)).toEqual([
        expect.objectContaining({
          id: successor.id,
          expiresAt: null,
          rotatedFrom: predecessor.id,
          rotatedTo: null,
        }),
      ]);
      expect(listed.tokens.find(({ id }) => id === predecessor.id)).toMatchObject({
        expiresAt: successor.predecessor.expiresAt,
        rotatedFrom: null,
        rotatedTo: successor.id,
      });
      const listedJson = JSON.stringify(listed);
      expect(listedJson.includes(predecessor.token)).toBe(false);
      expect(listedJson.includes(successor.token)).toBe(false);

      await waitUntilAfter(successor.predecessor.expiresAt);
      const expiredPredecessor = await predecessorClient.me();
      expect(expiredPredecessor).toEqual({
        ok: false,
        error: {
          status: 401,
          code: "unauthorized",
          message: "A valid bearer token is required.",
        },
      });
      expect(unwrap(await successorClient.me(), "successor after grace")).toMatchObject({
        principal: "stash",
        stash,
        tokenId: successor.id,
        scope: "read",
        expiresAt: null,
      });

      unwrap(await admin.stashes.tokens(stash).revoke(successor.id), "revoke rotation successor");
    },
  );

  it.runIf(MUTATION_ALLOWED)(
    "round-trips, histories, diffs, rolls back, and conditionally reads a 1.5 MB file",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("large-r2");
      unwrap(await admin.stashes.create({ name: stash }), "create large-file fixture stash");

      const files = admin.files(stash);
      const path = "contract/large-r2.txt";
      const body = largeFileBody();
      expect(new TextEncoder().encode(body).byteLength).toBe(LARGE_FILE_BYTES);

      const first = unwrap(
        await files.put(path, {
          body,
          expectedVersion: null,
          author: "contract-suite",
          message: "Create spilled fixture",
        }),
        "create large spilled file",
      );
      if ("unchanged" in first) throw new Error("large-file create unexpectedly skipped a write");
      expect(first).toMatchObject({
        version: 1,
        hash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
        size: LARGE_FILE_BYTES,
      });

      const second = unwrap(
        await files.put(path, {
          body: "small successor\n",
          expectedVersion: 1,
          author: "contract-suite",
          message: "Create small successor",
        }),
        "create small successor",
      );
      if ("unchanged" in second) {
        throw new Error("large-file successor unexpectedly skipped a write");
      }
      expect(second).toMatchObject({ version: 2, size: 16 });

      const history = unwrap(await files.history(path), "read large-file history");
      expect(history).toMatchObject({ path, headVersion: 2, deleted: false, total: 2 });
      expect(
        history.versions.map(({ version, kind, hash, size }) => ({
          version,
          kind,
          hash,
          size,
        })),
      ).toEqual([
        { version: 2, kind: "put", hash: second.hash, size: 16 },
        { version: 1, kind: "put", hash: first.hash, size: LARGE_FILE_BYTES },
      ]);

      const diff = unwrap(
        await files.diff(path, { from: 1, to: 2 }),
        "diff large file against small successor",
      );
      expect(diff).toEqual({
        state: "oversized",
        reason: "bytes",
        from: {
          version: 1,
          hash: first.hash,
          deleted: false,
          representation: "text",
          contentAccess: "inline",
          contentType: "text/plain; charset=utf-8",
          byteSize: LARGE_FILE_BYTES,
          etag: first.hash,
        },
        to: {
          version: 2,
          hash: second.hash,
          deleted: false,
          representation: "text",
          contentAccess: "inline",
          contentType: "text/plain; charset=utf-8",
          byteSize: 16,
          etag: second.hash,
        },
      });

      const rollback = unwrap(
        await files.rollback(path, {
          toVersion: 1,
          expectedVersion: 2,
          author: "contract-suite",
          message: "Restore spilled fixture",
        }),
        "roll back to large spilled file",
      );
      expect(rollback).toMatchObject({
        version: 3,
        rollbackOf: 1,
        hash: first.hash,
      });

      const restored = await files.get(path);
      if (!restored.ok || "notModified" in restored) {
        throw new Error("rolled-back large-file head was not readable");
      }
      expect(restored.value).toMatchObject({
        path,
        version: 3,
        kind: "rollback",
        hash: first.hash,
        size: LARGE_FILE_BYTES,
        deleted: false,
        body,
      });
      expect(restored.value.etag).toBe(`"v3-${first.hash}"`);

      const cached = await files.get(path, { ifNoneMatch: restored.value.etag });
      expect(cached).toEqual({ ok: true, notModified: true });
    },
  );

  it.runIf(MUTATION_ALLOWED)(
    "deletes and restores a spilled stash without reviving its former token",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("lifecycle-r2");
      unwrap(await admin.stashes.create({ name: stash }), "create lifecycle fixture stash");

      const formerToken = unwrap(
        await admin.stashes.tokens(stash).create({
          label: "contract-lifecycle-former",
          scope: "write",
        }),
        "mint former lifecycle token",
      );
      const formerClient = createStashClient({
        baseUrl: API_BASE_URL,
        token: formerToken.token,
      });
      const body = largeFileBody();
      const spilled = unwrap(
        await formerClient.files(stash).put("contract/lifecycle-r2.txt", {
          body,
          expectedVersion: null,
          author: "contract-suite",
          message: "Create lifecycle spill fixture",
        }),
        "write lifecycle spill fixture",
      );
      if ("unchanged" in spilled) throw new Error("lifecycle spill unexpectedly skipped a write");
      expect(spilled).toMatchObject({ version: 1, size: LARGE_FILE_BYTES });

      const deleted = unwrap(await admin.stashes.delete(stash), "delete lifecycle fixture stash");
      expect(deleted).toMatchObject({
        name: stash,
        revokedTokens: 1,
        deletedAt: expect.any(String),
        restoreUntil: expect.any(String),
      });
      expect(Date.parse(deleted.restoreUntil)).toBeGreaterThan(Date.parse(deleted.deletedAt));
      expect(await formerClient.me()).toEqual({
        ok: false,
        error: {
          status: 401,
          code: "unauthorized",
          message: "A valid bearer token is required.",
        },
      });

      let after: string | undefined;
      let deletedSummary:
        | {
            name: string;
            deletedAt: string | null;
            restoreUntil: string | null;
            restorable: boolean;
          }
        | undefined;
      for (let pageNumber = 0; pageNumber < 100 && deletedSummary === undefined; pageNumber += 1) {
        const page = unwrap(
          await admin.stashes.list({
            includeDeleted: true,
            limit: 200,
            ...(after ? { after } : {}),
          }),
          "list deleted lifecycle fixture",
        );
        deletedSummary = page.stashes.find(({ name }) => name === stash);
        if (deletedSummary !== undefined || page.nextAfter === null) break;
        after = page.nextAfter;
      }
      expect(deletedSummary).toMatchObject({
        name: stash,
        deletedAt: deleted.deletedAt,
        restoreUntil: deleted.restoreUntil,
        restorable: true,
      });

      const restored = unwrap(
        await admin.stashes.restore(stash),
        "restore lifecycle fixture stash",
      );
      expect(restored).toMatchObject({
        name: stash,
        deletedAt: null,
        restoreUntil: null,
        restorable: false,
        fileCount: 1,
      });
      expect(unwrap(await admin.stashes.get(stash), "admin read after restore")).toMatchObject({
        name: stash,
        deletedAt: null,
        fileCount: 1,
      });
      const restoredFile = await admin.files(stash).get("contract/lifecycle-r2.txt");
      if (!restoredFile.ok || "notModified" in restoredFile) {
        throw new Error("restored lifecycle spill was not readable by the administrator");
      }
      expect(restoredFile.value).toMatchObject({
        path: "contract/lifecycle-r2.txt",
        version: 1,
        hash: spilled.hash,
        size: LARGE_FILE_BYTES,
        deleted: false,
        body,
      });
      expect(await formerClient.me()).toEqual({
        ok: false,
        error: {
          status: 401,
          code: "unauthorized",
          message: "A valid bearer token is required.",
        },
      });

      const replacementToken = unwrap(
        await admin.stashes.tokens(stash).create({
          label: "contract-lifecycle-replacement",
          scope: "read",
        }),
        "mint replacement lifecycle token",
      );
      expect(
        unwrap(
          await createStashClient({ baseUrl: API_BASE_URL, token: replacementToken.token }).me(),
          "authenticate replacement lifecycle token",
        ),
      ).toMatchObject({ principal: "stash", stash, tokenId: replacementToken.id, scope: "read" });
    },
  );

  it.runIf(MUTATION_ALLOWED)(
    "fences, replays, rolls back, and tombstones file writes",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("writes");
      unwrap(
        await admin.stashes.create({ name: stash, description: "HTTP contract fixture" }),
        "create fixture stash",
      );

      const writeToken = unwrap(
        await admin.stashes.tokens(stash).create({ label: "contract-write", scope: "write" }),
        "mint write token",
      );
      const readToken = unwrap(
        await admin.stashes.tokens(stash).create({ label: "contract-read", scope: "read" }),
        "mint read token",
      );
      const writer = createStashClient({ baseUrl: API_BASE_URL, token: writeToken.token });
      const reader = createStashClient({ baseUrl: API_BASE_URL, token: readToken.token });
      expect(unwrap(await writer.me(), "write-token me")).toMatchObject({
        principal: "stash",
        stash,
        scope: "write",
      });

      const path = "contract/history.txt";
      const firstInput = {
        body: "first\n",
        expectedVersion: null,
        author: "contract-suite",
        message: "create",
      } as const;
      const idempotencyKey = `contract-${crypto.randomUUID()}`;
      const first = await writer.files(stash).put(path, firstInput, { idempotencyKey });
      const firstValue = unwrap(first, "create file");
      expect(firstValue).toMatchObject({ version: 1, size: 6 });

      const replay = await writer.files(stash).put(path, firstInput, { idempotencyKey });
      expect(unwrap(replay, "replay create file")).toEqual(firstValue);
      expect(replay.ok && replay.replayed).toBe(true);

      const unchanged = unwrap(
        await writer.files(stash).put(path, {
          body: "first\n",
          expectedVersion: 1,
          skipIfUnchanged: true,
        }),
        "skip unchanged write",
      );
      expect(unchanged).toEqual({ unchanged: true, version: 1 });

      const denied = await reader.files(stash).put(path, {
        body: "forbidden\n",
        expectedVersion: 1,
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("read token unexpectedly wrote a file");
      expect(denied.error).toMatchObject({ status: 403, code: "scope" });

      const second = unwrap(
        await writer.files(stash).put(path, {
          body: "second\n",
          expectedVersion: 1,
          author: "contract-suite",
          message: "update",
        }),
        "update file",
      );
      expect(second).toMatchObject({ version: 2, size: 7 });

      const rollback = unwrap(
        await writer.files(stash).rollback(path, {
          toVersion: 1,
          expectedVersion: 2,
          author: "contract-suite",
        }),
        "rollback file",
      );
      expect(rollback).toMatchObject({ version: 3, rollbackOf: 1 });

      const history = unwrap(await reader.files(stash).history(path), "history after rollback");
      expect(history.versions.map(({ kind }) => kind)).toEqual(["rollback", "put", "put"]);

      const deleted = unwrap(
        await writer.files(stash).delete(path, {
          expectedVersion: 3,
          author: "contract-suite",
        }),
        "delete file",
      );
      expect(deleted.version).toBe(4);

      const tombstone = await reader.files(stash).get(path);
      expect(tombstone.ok).toBe(false);
      if (tombstone.ok) throw new Error("tombstoned head unexpectedly returned as live");
      expect(tombstone.error).toMatchObject({ status: 404, code: "file-deleted" });
      expect(tombstone.current).toMatchObject({ version: 4, deleted: true });

      unwrap(await admin.stashes.tokens(stash).revoke(writeToken.id), "revoke write token");
      const revoked = await writer.me();
      expect(revoked.ok).toBe(false);
      if (revoked.ok) throw new Error("revoked token unexpectedly remained active");
      expect(revoked.error).toMatchObject({ status: 401, code: "unauthorized" });
    },
  );

  it.runIf(MUTATION_ALLOWED)(
    "imports bounded history and chains with expectedVersion",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("import");
      unwrap(await admin.stashes.create({ name: stash }), "create import fixture stash");

      const createdAt = Date.now() - 10_000;
      const first = unwrap(
        await admin.stashes.import(stash, {
          path: "migrated/archive.txt",
          expectedVersion: null,
          versions: [
            { kind: "put", body: "alpha\n", author: "legacy", createdAt },
            { kind: "put", body: "beta\n", author: "legacy", createdAt: createdAt + 1 },
            { kind: "delete", body: null, author: "legacy", createdAt: createdAt + 2 },
            {
              kind: "rollback",
              body: null,
              rollbackOf: 2,
              author: "legacy",
              createdAt: createdAt + 3,
            },
          ],
        }),
        "initial history import",
      );
      expect(first).toMatchObject({ path: "migrated/archive.txt", headVersion: 4 });

      const continued = unwrap(
        await admin.stashes.import(stash, {
          path: "migrated/archive.txt",
          expectedVersion: 4,
          versions: [
            {
              kind: "put",
              body: "gamma\n",
              author: "legacy",
              createdAt: createdAt + 4,
            },
          ],
        }),
        "continued history import",
      );
      expect(continued.headVersion).toBe(5);

      const files = admin.files(stash);
      const head = await files.get("migrated/archive.txt");
      if (!head.ok || "notModified" in head) throw new Error("imported head was not readable");
      expect(head.value).toMatchObject({ version: 5, body: "gamma\n", deleted: false });

      const history = unwrap(await files.history("migrated/archive.txt"), "imported history");
      expect(history.versions).toHaveLength(5);
      expect(history.versions.map(({ version, kind }) => [version, kind])).toEqual([
        [5, "put"],
        [4, "rollback"],
        [3, "delete"],
        [2, "put"],
        [1, "put"],
      ]);
    },
  );

  it.runIf(MUTATION_ALLOWED)(
    "commits atomically, exposes conflicts, reverts, and approves binary change sets",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("commits");
      unwrap(await admin.stashes.create({ name: stash }), "create commit fixture stash");
      const commits = admin.commits(stash);
      const commitInput = {
        entries: [
          {
            op: "put" as const,
            path: "commit/summary.md",
            expectedVersion: null,
            body: "atomic commit\n",
          },
          {
            op: "put" as const,
            path: "commit/payload.bin",
            expectedVersion: null,
            representation: "binary" as const,
            contentType: "application/octet-stream",
            bytesBase64: "AP8B",
          },
        ],
        author: "contract-suite",
        message: "Create atomic fixture",
        meta: { fixture: "commit-contract" },
      };
      const idempotencyKey = `commit-${crypto.randomUUID()}`;
      const created = unwrap(
        await commits.create(commitInput, { idempotencyKey }),
        "create atomic commit",
      );
      expect(created.entryCount).toBe(2);
      expect(created.entries.map(({ path }) => path)).toEqual([
        "commit/summary.md",
        "commit/payload.bin",
      ]);
      expect(created.entries[1]).toMatchObject({
        representation: "binary",
        hash: expect.any(String),
      });

      const replay = await commits.create(commitInput, { idempotencyKey });
      expect(unwrap(replay, "replay atomic commit")).toEqual(created);
      expect(replay.ok && replay.replayed).toBe(true);

      const conflict = await commits.create(
        {
          entries: [
            { op: "put", path: "commit/summary.md", expectedVersion: null, body: "stale\n" },
            { op: "put", path: "commit/new.txt", expectedVersion: 1, body: "also stale\n" },
          ],
          message: "Must not partially apply",
        },
        { idempotencyKey: `conflict-${crypto.randomUUID()}` },
      );
      expect(isCommitConflict(conflict)).toBe(true);
      if (!isCommitConflict(conflict)) throw new Error("commit conflict was not typed");
      expect(conflict.conflicts).toHaveLength(2);
      expect(conflict.conflicts.map(({ path }) => path)).toEqual([
        "commit/summary.md",
        "commit/new.txt",
      ]);
      const conflictProbe = await admin.files(stash).get("commit/new.txt");
      expect(conflictProbe.ok).toBe(false);
      if (conflictProbe.ok) throw new Error("atomic conflict partially created a file");
      expect(conflictProbe.error.code).toBe("not-found");

      const fetched = unwrap(await commits.get(created.id), "get atomic commit");
      expect(fetched.entries).toHaveLength(2);
      expect(unwrap(await commits.list({ path: "commit/summary.md" }), "list commits").total).toBe(
        1,
      );
      const diff = unwrap(await commits.diff(created.id), "diff atomic commit");
      expect(diff.entries).toHaveLength(2);
      expect(diff.entries.find(({ path }) => path === "commit/payload.bin")?.diff).toEqual({
        state: "binary",
      });

      const reverted = unwrap(
        await commits.revert(
          created.id,
          { author: "contract-suite", message: "Revert fixture" },
          {
            idempotencyKey: `revert-${crypto.randomUUID()}`,
          },
        ),
        "revert atomic commit",
      );
      expect(reverted.revertsCommitId).toBe(created.id);
      expect(reverted.entries.every(({ kind }) => kind === "delete")).toBe(true);

      const changeSets = admin.changeSets(stash);
      const changeSet = unwrap(
        await changeSets.create(
          {
            entries: [
              {
                op: "put",
                path: "review/files/readme.md",
                baseVersion: null,
                body: "pending review\n",
              },
              {
                op: "put",
                path: "review/files/data.bin",
                baseVersion: null,
                representation: "binary",
                contentType: "application/octet-stream",
                bytesBase64: "AP8B",
              },
            ],
            author: "contract-suite",
            message: "Open binary review",
            meta: { fixture: "change-set-contract" },
          },
          { idempotencyKey: `change-set-${crypto.randomUUID()}` },
        ),
        "create binary change set",
      );
      expect(changeSet.status).toBe("open");
      expect(unwrap(await changeSets.list({ status: "open" }), "list open change sets").total).toBe(
        1,
      );
      const changeSetDiff = unwrap(await changeSets.diff(changeSet.id), "diff binary change set");
      expect(changeSetDiff.stale).toBe(false);
      expect(
        changeSetDiff.entries.find(({ path }) => path.endsWith("data.bin"))?.diff,
      ).toMatchObject({
        state: "binary",
      });

      const approved = unwrap(
        await changeSets.approve(changeSet.id, {
          author: "contract-suite",
          message: "Approve binary review",
        }),
        "approve binary change set",
      );
      expect(approved.status).toBe("applied");
      expect(approved.commit.source).toBe("change-set");
      expect(approved.commit.entries).toHaveLength(2);
      const approvedCommit = unwrap(
        await commits.get(approved.commit.id),
        "read applied change-set commit",
      );
      const history = unwrap(
        await admin.files(stash).history("review/files/readme.md"),
        "read applied history",
      );
      expect(history.versions[0]?.commitId).toBe(approvedCommit.id);
      const changes = unwrap(await admin.files(stash).changes(), "read applied changes");
      expect(changes.changes.filter(({ commitId }) => commitId === approvedCommit.id)).toHaveLength(
        2,
      );
      const snapshot = unwrap(
        await admin.files(stash).snapshot({ at: `commit:${approvedCommit.id}`, prefix: "review" }),
        "snapshot at applied commit",
      );
      expect(snapshot.at.commitId).toBe(approvedCommit.id);
      expect(snapshot.files.map(({ path }) => path)).toEqual([
        "review/files/data.bin",
        "review/files/readme.md",
      ]);
    },
  );
});
