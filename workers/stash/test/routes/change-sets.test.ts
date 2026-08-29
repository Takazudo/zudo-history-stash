import { env } from "cloudflare:workers";
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
    const input = {
      entries: [{ op: "put", path: "route.txt", baseVersion: null, body: "candidate\n" }],
      author: "route-test",
    };
    const first = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets`,
      json(input, { "Idempotency-Key": "route-replay" }),
      env,
    );
    expect(first.status).toBe(201);
    const created = await first.json<{ id: string }>();

    const replay = await request(
      worker,
      `http://localhost/v1/stashes/${STASH}/change-sets`,
      json(input, { "Idempotency-Key": "route-replay" }),
      env,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({ id: created.id });

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
  });

  it("returns validation and idempotency reuse errors and leaves decisions unimplemented", async () => {
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

    for (const decision of ["approve", "reject"]) {
      const response = await request(
        worker,
        `${collection}/${created.id}/${decision}`,
        json({}),
        env,
      );
      expect(response.status).toBe(501);
    }
  });
});
