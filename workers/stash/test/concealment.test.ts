import { env } from "cloudflare:test";
import { ROUTES, type Route } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "./helpers/app.js";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const DAY_MS = 86_400_000;
const TARGET = "deleted-stash";
const OTHER = "other-stash";
const app = createApp({ now: () => NOW });

type StashRoute = Extract<Route, { template: `${string}:stash${string}` }>;

const stashRoutes = ROUTES.filter((route): route is StashRoute =>
  route.template.includes(":stash"),
);

function routePath(route: StashRoute): string {
  return route.template
    .replace(":stash", TARGET)
    .replace(":id", "missing-token")
    .replace("*path", "folder/file.txt");
}

function routeInit(route: StashRoute, token: string): RequestInit {
  const hasBody = route.method === "POST" || route.method === "PUT";
  return {
    method: route.method,
    headers: { ...bearer(token), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: "{}" } : {}),
  };
}

async function markDeleted(stash: string, deletedAt: number): Promise<void> {
  await env.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?")
    .bind(deletedAt, stash)
    .run();
  await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE stash_name = ?")
    .bind(deletedAt, stash)
    .run();
}

async function seedVersion(stash: string, path: string, createdAt: number): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO versions
       (stash_name, path, version, kind, blob_hash, size_bytes, author, message, created_at)
     VALUES (?, ?, 1, 'put', ?, 1, 'tester', '', ?)`,
  )
    .bind(stash, path, `hash-${stash}-${path}`, createdAt)
    .run();
  return result.meta.last_row_id;
}

function instrumentStashReads(db: D1Database, stashReads: string[]): D1Database {
  function instrumentSession(session: D1DatabaseSession): D1DatabaseSession {
    return new Proxy(session, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/\bFROM\s+stashes\b/i.test(sql)) stashReads.push(sql);
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (/\bFROM\s+stashes\b/i.test(sql)) stashReads.push(sql);
          return target.prepare(sql);
        };
      }
      if (property === "withSession") {
        return (constraint?: string) => instrumentSession(target.withSession(constraint));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(resetDatabase);

describe("deleted stash concealment matrix", () => {
  it("is generated from every current stash route", () => {
    expect(stashRoutes.map(({ id }) => id)).toEqual(
      ROUTES.filter(({ template }) => template.includes(":stash")).map(({ id }) => id),
    );
  });

  it.each(stashRoutes)("conceals $id ($method $template) by principal", async (route) => {
    await seedStash(TARGET);
    await seedStash(OTHER);
    const former = await mintToken(TARGET, "write");
    const other = await mintToken(OTHER, "write");
    await markDeleted(TARGET, NOW - DAY_MS);

    const url = `http://stash.test${routePath(route)}`;
    const formerResponse = await request(app, url, routeInit(route, former.token));
    expect(formerResponse.status).toBe(401);
    await expect(formerResponse.json()).resolves.toMatchObject({
      error: { code: "unauthorized" },
    });

    const otherResponse = await request(app, url, routeInit(route, other.token));
    expect(otherResponse.status).toBe(404);
    await expect(otherResponse.json()).resolves.toMatchObject({
      error: { code: "not-found" },
    });

    const adminResponse = await request(app, url, routeInit(route, "test-admin"));
    const expected =
      route.id === "getStash"
        ? 200
        : route.id === "deleteStash"
          ? 409
          : route.id === "restoreStash"
            ? 200
            : 404;
    expect(adminResponse.status).toBe(expected);
    if (expected === 404) {
      await expect(adminResponse.json()).resolves.toMatchObject({
        error: { code: "not-found" },
      });
    }
  });

  it("returns 404 for a deleted events stash before the mounted 501 skeleton", async () => {
    await seedStash(TARGET);
    await markDeleted(TARGET, NOW - DAY_MS);

    const response = await request(app, `http://stash.test/v1/stashes/${TARGET}/events`, {
      headers: bearer("test-admin"),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });
});

describe("deleted-aware administration", () => {
  it("omits deleted stashes by default and computes strict restore boundaries", async () => {
    await seedStash("live");
    await seedStash("inside");
    await seedStash("boundary");
    await seedStash("expired");
    await markDeleted("inside", NOW - 30 * DAY_MS + 1);
    await markDeleted("boundary", NOW - 30 * DAY_MS);
    await markDeleted("expired", NOW - 30 * DAY_MS - 1);

    const defaultResponse = await request(app, "http://stash.test/v1/stashes", {
      headers: bearer("test-admin"),
    });
    expect(defaultResponse.status).toBe(200);
    await expect(defaultResponse.json()).resolves.toMatchObject({
      stashes: [{ name: "live", deletedAt: null, restoreUntil: null, restorable: false }],
    });

    const includedResponse = await request(
      app,
      "http://stash.test/v1/stashes?includeDeleted=true",
      { headers: bearer("test-admin") },
    );
    expect(includedResponse.status).toBe(200);
    const included = await includedResponse.json<{
      stashes: Array<{
        name: string;
        deletedAt: string | null;
        restoreUntil: string | null;
        restorable: boolean;
      }>;
    }>();
    expect(included.stashes.map(({ name }) => name)).toEqual([
      "boundary",
      "expired",
      "inside",
      "live",
    ]);
    expect(included.stashes.find(({ name }) => name === "inside")).toMatchObject({
      deletedAt: new Date(NOW - 30 * DAY_MS + 1).toISOString(),
      restoreUntil: new Date(NOW + 1).toISOString(),
      restorable: true,
    });
    expect(included.stashes.find(({ name }) => name === "boundary")).toMatchObject({
      restoreUntil: new Date(NOW).toISOString(),
      restorable: false,
    });
    expect(included.stashes.find(({ name }) => name === "expired")).toMatchObject({
      restoreUntil: new Date(NOW - 1).toISOString(),
      restorable: false,
    });

    const explicit = await request(app, "http://stash.test/v1/stashes/boundary", {
      headers: bearer("test-admin"),
    });
    expect(explicit.status).toBe(200);
    await expect(explicit.json()).resolves.toMatchObject({
      name: "boundary",
      deletedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      restoreUntil: new Date(NOW).toISOString(),
      restorable: false,
    });
  });
});

describe("global feed concealment", () => {
  it("filters deleted-stash history in newest, before, and since pages without deleting it", async () => {
    await seedStash("live");
    await seedStash("deleted");
    const liveFirst = await seedVersion("live", "one.txt", NOW - 4);
    const deletedFirst = await seedVersion("deleted", "hidden.txt", NOW - 3);
    const liveSecond = await seedVersion("live", "two.txt", NOW - 2);
    await markDeleted("deleted", NOW - 1);

    const get = (query = "") =>
      request(app, `http://stash.test/v1/changes${query}`, {
        headers: bearer("test-admin"),
      });
    const newest = await (
      await get("?limit=1")
    ).json<{
      changes: Array<{ changeId: number }>;
      hasMore: boolean;
    }>();
    expect(newest).toMatchObject({ changes: [{ changeId: liveSecond }], hasMore: true });

    const before = await (
      await get(`?before=${liveSecond}&limit=10`)
    ).json<{
      changes: Array<{ changeId: number }>;
    }>();
    expect(before.changes.map(({ changeId }) => changeId)).toEqual([liveFirst]);

    const since = await (
      await get(`?since=${liveFirst}&limit=10`)
    ).json<{
      changes: Array<{ changeId: number }>;
    }>();
    expect(since.changes.map(({ changeId }) => changeId)).toEqual([liveSecond]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM versions WHERE id = ?")
        .bind(deletedFirst)
        .first<{ count: number }>("count"),
    ).toBe(1);
  });
});

describe("live stash context cache", () => {
  it("resolves a stash-token admin GET exactly once", async () => {
    await seedStash("cached");
    const token = await mintToken("cached", "read");
    await env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
      .bind(NOW, token.id)
      .run();
    const stashReads: string[] = [];
    const bindings: Env = { ...env, DB: instrumentStashReads(env.DB, stashReads) };

    const response = await request(
      app,
      "http://stash.test/v1/stashes/cached",
      { headers: bearer(token.token) },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(stashReads).toHaveLength(1);
    expect(stashReads[0]).toContain("deleted_at IS NULL");
  });

  it("does not re-query stash existence while listing tokens", async () => {
    await seedStash("cached");
    const stashReads: string[] = [];
    const bindings: Env = { ...env, DB: instrumentStashReads(env.DB, stashReads) };

    const response = await request(
      app,
      "http://stash.test/v1/stashes/cached/tokens",
      { headers: bearer("test-admin") },
      bindings,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tokens: [] });
    expect(stashReads).toHaveLength(1);
    expect(stashReads[0]).toContain("deleted_at IS NULL");
  });
});
