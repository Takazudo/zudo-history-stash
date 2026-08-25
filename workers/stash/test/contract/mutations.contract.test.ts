import { createStashClient } from "@takazudo/zudo-history-stash";
import { describe, expect, it } from "vitest";
import { API_BASE_URL, MUTATION_ALLOWED } from "./env.js";
import { createAdminClient, uniqueStash, unwrap } from "./helpers.js";

describe("local-only HTTP mutation contract", () => {
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
});
