import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createStashStore } from "../../src/d1/store.js";
import type { Env } from "../../src/env.js";
import { resetDatabase, seedStash } from "../helpers/app.js";

const STASH = "change-set-store";
const NOW = 1_800_000_000_000;

function dependencies(now = () => NOW) {
  let sequence = 0;
  return { now, createId: () => `change-set-${(sequence += 1)}` };
}

beforeEach(resetDatabase);

describe("change-set store", () => {
  it("stages put, delete, and rollback entries and recomputes stale diffs", async () => {
    await seedStash(STASH);
    const store = createStashStore(env as Env, dependencies());
    await store.writes.put(STASH, "delete.txt", { body: "remove\n", expectedVersion: null });
    await store.writes.put(STASH, "rollback.txt", { body: "first\n", expectedVersion: null });
    await store.writes.put(STASH, "rollback.txt", { body: "second\n", expectedVersion: 1 });

    const created = await store.changeSets.createChangeSet(STASH, {
      entries: [
        { op: "put", path: "new.txt", baseVersion: null, body: "candidate\n" },
        { op: "delete", path: "delete.txt", baseVersion: 1 },
        { op: "rollback", path: "rollback.txt", baseVersion: 2, toVersion: 1 },
      ],
      author: "reviewer",
      message: "three entries",
      meta: {},
    });
    expect(created.value.entries).toHaveLength(3);
    const before = await store.changeSets.getChangeSetDiff(STASH, created.value.id);
    expect(before).toMatchObject({ stale: false, truncated: false });
    expect(before?.entries.map(({ path, stale }) => ({ path, stale }))).toEqual([
      { path: "delete.txt", stale: false },
      { path: "new.txt", stale: false },
      { path: "rollback.txt", stale: false },
    ]);
    expect(before?.entries.every(({ diff }) => diff.state === "ready")).toBe(true);

    await store.writes.put(STASH, "new.txt", { body: "competitor\n", expectedVersion: null });
    const after = await store.changeSets.getChangeSetDiff(STASH, created.value.id);
    expect(after).toMatchObject({ stale: true });
    expect(after?.entries.find(({ path }) => path === "new.txt")).toMatchObject({
      stale: true,
      current: { version: 1 },
    });
  });

  it("rejects deleting a never-existing path with a path-naming validation error", async () => {
    await seedStash(STASH);
    const store = createStashStore(env as Env, dependencies());
    await expect(
      store.changeSets.createChangeSet(STASH, {
        entries: [{ op: "delete", path: "missing.txt", baseVersion: 1 }],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("missing.txt"),
    });
  });

  it("replays the same canonical request and rejects different same-key reuse", async () => {
    await seedStash(STASH);
    const store = createStashStore(env as Env, dependencies());
    const input = {
      entries: [{ op: "put" as const, path: "new.txt", baseVersion: null, body: "candidate" }],
    };
    const first = await store.changeSets.createChangeSet(STASH, input, {
      idempotencyKey: "retry",
    });
    await expect(
      store.changeSets.createChangeSet(STASH, input, { idempotencyKey: "retry" }),
    ).resolves.toEqual({ value: first.value, replayed: true });
    await expect(
      store.changeSets.createChangeSet(
        STASH,
        {
          entries: [{ op: "put", path: "new.txt", baseVersion: null, body: "different" }],
        },
        { idempotencyKey: "retry" },
      ),
    ).rejects.toMatchObject({ code: "idempotency-key-reused", status: 422 });
  });

  it("computes expiry at the exact expiresAt boundary", async () => {
    await seedStash(STASH);
    let clock = NOW;
    const store = createStashStore(
      env as Env,
      dependencies(() => clock),
    );
    const created = await store.changeSets.createChangeSet(STASH, {
      entries: [{ op: "put", path: "expires.txt", baseVersion: null, body: "candidate" }],
      expiresAt: new Date(NOW + 1).toISOString(),
    });
    expect(created.value.status).toBe("open");
    clock = NOW + 1;
    await expect(store.changeSets.getChangeSet(STASH, created.value.id)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(
      store.changeSets.listChangeSets(STASH, { status: "expired" }),
    ).resolves.toMatchObject({ total: 1, changeSets: [{ id: created.value.id }] });
    await expect(store.changeSets.listChangeSets(STASH)).resolves.toMatchObject({
      total: 0,
      changeSets: [],
    });
  });

  it("paginates equal timestamps by id and preserves the filtered total", async () => {
    await seedStash(STASH);
    const store = createStashStore(env as Env, dependencies());
    for (const path of ["one.txt", "two.txt", "three.txt"]) {
      await store.changeSets.createChangeSet(STASH, {
        entries: [{ op: "put", path, baseVersion: null, body: path }],
      });
    }
    const first = await store.changeSets.listChangeSets(STASH, { status: "all", limit: 2 });
    expect(first).toMatchObject({ total: 3, nextAfter: expect.any(String) });
    const second = await store.changeSets.listChangeSets(STASH, {
      status: "all",
      limit: 2,
      after: first.nextAfter ?? undefined,
    });
    expect(second).toMatchObject({ total: 3, nextAfter: null });
    expect([...first.changeSets, ...second.changeSets].map(({ id }) => id)).toHaveLength(3);
    await expect(
      store.changeSets.listChangeSets(STASH, { status: "all", path: "one.txt" }),
    ).resolves.toMatchObject({ total: 1, changeSets: [{ entries: [{ path: "one.txt" }] }] });
  });
});
