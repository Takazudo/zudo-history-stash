import { createStashClient } from "@takazudo/zudo-history-stash";
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

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
    "replays, reviews, applies, and stale-fences proposals over loopback HTTP",
    async () => {
      const admin = createAdminClient();
      const stash = uniqueStash("proposals");
      const path = `contract/proposal-${crypto.randomUUID()}.md`;
      let createdStash = false;
      let tokenId: string | null = null;
      let primaryFailure: unknown = null;
      const cleanupFailures: Error[] = [];

      try {
        unwrap(
          await admin.stashes.create({ name: stash, description: "Proposal HTTP contract" }),
          "create proposal fixture stash",
        );
        createdStash = true;
        const writeToken = unwrap(
          await admin.stashes.tokens(stash).create({
            label: `contract-proposals-${crypto.randomUUID()}`,
            scope: "write",
          }),
          "mint proposal fixture token",
        );
        tokenId = writeToken.id;
        const writer = createStashClient({ baseUrl: API_BASE_URL, token: writeToken.token });
        const files = writer.files(stash);
        const proposals = writer.proposals(stash);

        const base = unwrap(
          await files.put(path, {
            body: "base line\n",
            expectedVersion: null,
            author: "contract-seed",
            message: "Seed proposal base",
          }),
          "seed proposal base",
        );
        if ("unchanged" in base) throw new Error("proposal base unexpectedly skipped its write");
        expect(base).toMatchObject({ version: 1, size: 10 });

        const createInput = Object.freeze({
          path,
          body: "candidate line\n",
          baseVersion: 1,
          author: "contract-bot",
          message: "Review candidate",
          meta: { lane: "http-contract" },
        });
        const createOptions = Object.freeze({
          idempotencyKey: `contract-proposal-${crypto.randomUUID()}`,
        });
        const created = await proposals.create(createInput, createOptions);
        const proposalA = unwrap(created, "create proposal A");
        expect(created.ok && created.replayed).toBeFalsy();
        expect(proposalA).toMatchObject({
          stash,
          path,
          baseVersion: 1,
          author: "contract-bot",
          message: "Review candidate",
          meta: { lane: "http-contract", proposalId: proposalA.id },
          status: "open",
          decidedAt: null,
          decidedBy: null,
          appliedVersion: null,
          appliedChangeId: null,
        });

        const replay = await proposals.create(createInput, createOptions);
        expect(replay.ok && replay.replayed).toBe(true);
        expect(unwrap(replay, "replay proposal A")).toEqual(proposalA);

        const immutableDiff = unwrap(await proposals.diff(proposalA.id), "diff proposal A");
        expect(immutableDiff).toMatchObject({
          state: "ready",
          base: { version: 1, hash: base.hash, deleted: false },
          candidate: { hash: proposalA.hash, size: proposalA.size },
          current: { version: 1, hash: base.hash, deleted: false },
          stale: false,
        });

        const approved = unwrap(
          await proposals.approve(proposalA.id, {
            author: "contract-approver",
            message: "Approve candidate",
          }),
          "approve proposal A",
        );
        expect(approved).toMatchObject({
          status: "applied",
          appliedVersion: 2,
          appliedChangeId: expect.any(Number),
          hash: proposalA.hash,
          createdAt: expect.any(String),
        });

        const appliedHistory = unwrap(
          await files.history(path, { limit: 200 }),
          "history after proposal approval",
        );
        expect(appliedHistory).toMatchObject({ headVersion: 2, total: 2 });
        expect(appliedHistory.versions).toHaveLength(2);
        expect(appliedHistory.versions[0]).toMatchObject({
          version: 2,
          kind: "put",
          rollbackOf: null,
          hash: proposalA.hash,
          author: "contract-approver",
          message: "Approve candidate",
          meta: { lane: "http-contract", proposalId: proposalA.id },
        });

        const proposalB = unwrap(
          await proposals.create(
            {
              path,
              body: "candidate from v2\n",
              baseVersion: 2,
              author: "contract-bot",
              message: "Candidate that will go stale",
            },
            { idempotencyKey: `contract-proposal-stale-${crypto.randomUUID()}` },
          ),
          "create proposal B",
        );
        const moved = unwrap(
          await files.put(path, {
            body: "direct v3\n",
            expectedVersion: 2,
            author: "contract-direct",
            message: "Move head before approval",
          }),
          "move head before stale approval",
        );
        if ("unchanged" in moved)
          throw new Error("direct head move unexpectedly skipped its write");
        expect(moved.version).toBe(3);

        const stale = await proposals.approve(proposalB.id);
        expect(stale).toMatchObject({
          ok: false,
          error: { status: 409, code: "stale" },
          current: { version: 3, hash: moved.hash, deleted: false },
        });

        const refusedHistory = unwrap(
          await files.history(path, { limit: 200 }),
          "history after stale approval",
        );
        expect(refusedHistory).toMatchObject({ headVersion: 3, total: 3 });
        expect(refusedHistory.versions.map(({ version }) => version)).toEqual([3, 2, 1]);
        expect(
          unwrap(await proposals.get(proposalB.id), "proposal B after stale approval"),
        ).toMatchObject({
          id: proposalB.id,
          status: "open",
          decidedAt: null,
          appliedVersion: null,
          appliedChangeId: null,
        });
      } catch (error: unknown) {
        primaryFailure = error;
      } finally {
        if (tokenId !== null) {
          try {
            const revoked = await admin.stashes.tokens(stash).revoke(tokenId);
            if (!revoked.ok && revoked.error.code !== "not-found") {
              cleanupFailures.push(
                new Error(
                  `revoke proposal fixture token failed (${revoked.error.status} ${revoked.error.code})`,
                ),
              );
            }
          } catch (error: unknown) {
            cleanupFailures.push(errorFrom(error));
          }
        }
        if (createdStash) {
          try {
            const deleted = await admin.stashes.delete(stash);
            if (!deleted.ok && deleted.error.code !== "not-found") {
              cleanupFailures.push(
                new Error(
                  `delete proposal fixture stash failed (${deleted.error.status} ${deleted.error.code})`,
                ),
              );
            }
          } catch (error: unknown) {
            cleanupFailures.push(errorFrom(error));
          }
        }
      }

      if (primaryFailure !== null || cleanupFailures.length > 0) {
        throw new AggregateError(
          [
            ...(primaryFailure === null
              ? []
              : [primaryFailure instanceof Error ? primaryFailure : errorFrom(primaryFailure)]),
            ...cleanupFailures,
          ],
          "proposal HTTP lifecycle or its logical cleanup failed",
        );
      }
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
});
