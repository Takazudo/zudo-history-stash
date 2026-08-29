import { env } from "cloudflare:workers";
import { StashEventSchema, type StashEvent } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";

const STASH = "change-set-route";
const NOW = 1_800_000_000_000;

function app() {
  let sequence = 0;
  return createApp({ now: () => NOW, createId: () => `route-${(sequence += 1)}` });
}

function json(input: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method: "POST",
    headers: { ...bearer(env.STASH_ADMIN_TOKEN), "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  };
}

beforeEach(resetDatabase);

describe("change-set routes", () => {
  it("creates, gets, lists, diffs, and publishes the replay header", async () => {
    await seedStash(STASH);
    const worker = app();
    const events: StashEvent[] = [];
    const bindings = {
      ...env,
      STASH_EVENTS: new Proxy(env.STASH_EVENTS, {
        get(target, property, receiver) {
          if (property === "getByName") {
            return () => ({
              fetch: async (eventRequest: Request) => {
                events.push(...StashEventSchema.array().parse(await eventRequest.json()));
                return new Response(null, { status: 204 });
              },
            });
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const input = {
      entries: [{ op: "put", path: "route.txt", baseVersion: null, body: "candidate\n" }],
      author: "route-test",
    };
    const first = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets`,
      json(input, { "Idempotency-Key": "route-replay" }),
      bindings,
    );
    expect(first.status).toBe(201);
    const created = await first.json<{ id: string }>();
    expect(events).toEqual([
      {
        type: "change-set",
        changeSetId: created.id,
        stash: STASH,
        status: "open",
        paths: ["route.txt"],
        origin: null,
      },
    ]);

    const replay = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets`,
      json(input, { "Idempotency-Key": "route-replay" }),
      bindings,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({ id: created.id });
    expect(events).toHaveLength(1);

    const listed = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets?status=all&path=route.txt`,
      { headers: bearer(env.STASH_ADMIN_TOKEN) },
      env,
    );
    await expect(listed.json()).resolves.toMatchObject({
      total: 1,
      changeSets: [{ id: created.id }],
    });

    const got = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets/${created.id}`,
      { headers: bearer(env.STASH_ADMIN_TOKEN) },
      env,
    );
    await expect(got.json()).resolves.toMatchObject({
      id: created.id,
      entries: [{ path: "route.txt", stale: false }],
    });

    const diff = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets/${created.id}/diff?path=route.txt`,
      { headers: bearer(env.STASH_ADMIN_TOKEN) },
      env,
    );
    await expect(diff.json()).resolves.toMatchObject({
      stale: false,
      entries: [{ path: "route.txt", diff: { state: "ready" } }],
    });

    const approved = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets/${created.id}/approve`,
      json({ message: "approved" }, { "X-Stash-Client-Id": "route-tab" }),
      bindings,
    );
    expect(approved.status).toBe(200);
    const approval = await approved.json<{ commit: { id: string } }>();
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ type: "change", path: "route.txt", origin: "route-tab" }),
      expect.objectContaining({
        type: "commit",
        commitId: approval.commit.id,
        origin: "route-tab",
      }),
      {
        type: "change-set",
        changeSetId: created.id,
        stash: STASH,
        status: "applied",
        paths: ["route.txt"],
        origin: "route-tab",
      },
    ]);
    const eventCount = events.length;
    const replayedApproval = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets/${created.id}/approve`,
      json({}),
      bindings,
    );
    expect(replayedApproval.status).toBe(200);
    expect(events).toHaveLength(eventCount);
  });

  it("returns validation and idempotency reuse errors and rejects an open set", async () => {
    await seedStash(STASH);
    const worker = app();
    const collection = `http://localhost/v1/stashes/${STASH}/change-sets`;
    const missingDelete = await request(
      worker,
      collection,
      json({ entries: [{ op: "delete", path: "missing.txt", baseVersion: 1 }] }),
      env,
    );
    expect(missingDelete.status).toBe(400);
    await expect(missingDelete.json()).resolves.toMatchObject({
      error: { code: "validation", message: expect.stringContaining("missing.txt") },
    });

    const first = await request(
      worker,
      collection,
      json(
        { entries: [{ op: "put", path: "one.txt", baseVersion: null, body: "one" }] },
        { "Idempotency-Key": "reuse" },
      ),
      env,
    );
    const created = await first.json<{ id: string }>();
    const reused = await request(
      worker,
      collection,
      json(
        { entries: [{ op: "put", path: "one.txt", baseVersion: null, body: "two" }] },
        { "Idempotency-Key": "reuse" },
      ),
      env,
    );
    expect(reused.status).toBe(422);

    const rejected = await request(
      worker,
      `${collection}/${created.id}/reject`,
      json({ reason: "not wanted" }),
      env,
    );
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({
      id: created.id,
      status: "rejected",
      decisionReason: "not wanted",
      decidedBy: "admin",
    });
    const closed = await request(worker, `${collection}/${created.id}/approve`, json({}), env);
    expect(closed.status).toBe(409);
    await expect(closed.json()).resolves.toMatchObject({ error: { code: "change-set-closed" } });
  });
});
