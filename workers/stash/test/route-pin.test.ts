import { ROUTES, transportForRoute } from "@takazudo/zudo-history-stash-core";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CLIENT_ROUTES, parseClientResponse, StashHttpError } from "@takazudo/zudo-history-stash";
import apiReference from "../../../docs/api.md?raw";
import app from "../src/app.js";
import { StashRpc } from "../src/rpc.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

type RouteTuple = readonly [string, string];

const skeletonRouteProbes = [
  { id: "createCommit", method: "POST", path: "/v1/stashes/route-pin/commits" },
  { id: "getCommit", method: "GET", path: "/v1/stashes/route-pin/commits/cmt_1" },
  { id: "listCommits", method: "GET", path: "/v1/stashes/route-pin/commits" },
  { id: "getCommitDiff", method: "GET", path: "/v1/stashes/route-pin/commits/cmt_1/diff" },
  { id: "revertCommit", method: "POST", path: "/v1/stashes/route-pin/commits/cmt_1/revert" },
  { id: "getSnapshot", method: "GET", path: "/v1/stashes/route-pin/snapshot?at=commit%3Acmt_1" },
  { id: "createChangeSet", method: "POST", path: "/v1/stashes/route-pin/change-sets" },
  { id: "listChangeSets", method: "GET", path: "/v1/stashes/route-pin/change-sets" },
  { id: "getChangeSet", method: "GET", path: "/v1/stashes/route-pin/change-sets/chs_1" },
  { id: "getChangeSetDiff", method: "GET", path: "/v1/stashes/route-pin/change-sets/chs_1/diff" },
  {
    id: "approveChangeSet",
    method: "POST",
    path: "/v1/stashes/route-pin/change-sets/chs_1/approve",
  },
  { id: "rejectChangeSet", method: "POST", path: "/v1/stashes/route-pin/change-sets/chs_1/reject" },
] as const;

beforeEach(resetDatabase);

function sorted(routes: readonly RouteTuple[]): RouteTuple[] {
  return [...routes].sort(([methodA, pathA], [methodB, pathB]) => {
    const left = `${methodA} ${pathA}`;
    const right = `${methodB} ${pathB}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function coreRouteSet(routes: typeof ROUTES): RouteTuple[] {
  return sorted(routes.map(({ method, template }) => [method, template] as const));
}

function registeredRouteSet(): RouteTuple[] {
  const routes = app.routes
    .filter(({ method }) => method !== "ALL")
    .map(
      ({ method, path }) =>
        [method, path.replace(/:path\{\.\+\}/g, "*path").replace(/\/\*$/, "/*path")] as const,
    );
  return sorted([...new Map(routes.map((route) => [route.join(" "), route])).values()]);
}

function documentedRouteSet(): RouteTuple[] {
  const routes: RouteTuple[] = [];
  for (const match of apiReference.matchAll(/^### `(GET|HEAD|POST|PUT|DELETE) (\/v1\/[^`]+)`$/gm)) {
    const method = match[1];
    const template = match[2];
    if (method === undefined || template === undefined)
      throw new Error("Invalid API route heading");
    routes.push([method, template]);
  }
  return sorted(routes);
}

describe("route contract pin", () => {
  it("keeps Worker, core, client, and API docs route sets identical", () => {
    const expected = coreRouteSet(ROUTES);
    expect(registeredRouteSet()).toEqual(expected);
    expect(coreRouteSet(CLIENT_ROUTES)).toEqual(expected);
    expect(documentedRouteSet()).toEqual(expected);
  });

  it("exposes exactly every transport-eligible route as a named StashRpc method", () => {
    const prototypeNames = new Set(Object.getOwnPropertyNames(StashRpc.prototype));
    const rpcRoutes = ROUTES.filter(({ id }) => transportForRoute(id) === "any");
    for (const { id } of rpcRoutes) {
      expect(prototypeNames.has(id), `missing StashRpc.prototype.${id}`).toBe(true);
      expect(typeof Object.getOwnPropertyDescriptor(StashRpc.prototype, id)?.value).toBe(
        "function",
      );
    }
    expect(ROUTES.filter(({ id }) => transportForRoute(id) === "fetch-only")).toHaveLength(13);
    expect(prototypeNames.has("stashEvents")).toBe(false);
  });

  it("mounts the dedicated real events handler rather than relying on the catch-all", async () => {
    await seedStash("route-pin");
    const response = await request(app, "http://stash.test/v1/stashes/route-pin/events", {
      headers: bearer("test-admin"),
    });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it("authenticates, resolves, and conceals before opening the events stream", async () => {
    await seedStash("route-pin");
    await seedStash("other-stash");
    const read = await mintToken("route-pin", "read");
    const write = await mintToken("route-pin", "write");
    const foreign = await mintToken("other-stash", "read");
    const path = "http://stash.test/v1/stashes/route-pin/events?since=0";

    const unauthenticated = await request(app, path);
    expect(unauthenticated.status).toBe(401);

    for (const token of ["test-admin", read.token, write.token]) {
      const response = await request(app, path, { headers: bearer(token) });
      try {
        expect(response.status).toBe(200);
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }

    const concealed = await request(app, path, { headers: bearer(foreign.token) });
    expect(concealed.status).toBe(404);
  });

  it.each(skeletonRouteProbes)("mounts the 501 skeleton for $id", async (route) => {
    await seedStash("route-pin");
    const response = await request(app, `http://stash.test${route.path}`, {
      method: route.method,
      headers: {
        ...bearer("test-admin"),
        ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(route.method === "POST" ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(501);
  });

  it("keeps all twelve raw skeleton RPC methods on generic request transport", async () => {
    await seedStash("route-pin");
    const rpc = new StashRpc(createExecutionContext(), createTestEnv().env);
    const entry = { op: "put" as const, path: "docs/a.md", expectedVersion: null, body: "a" };
    const changeSetEntry = { op: "put" as const, path: "docs/a.md", baseVersion: null, body: "a" };
    const responses = await Promise.all([
      rpc.createCommit("test-admin", "route-pin", { entries: [entry] }, "route-pin-create"),
      rpc.getCommit("test-admin", "route-pin", "cmt_1"),
      rpc.listCommits("test-admin", "route-pin"),
      rpc.getCommitDiff("test-admin", "route-pin", "cmt_1"),
      rpc.revertCommit("test-admin", "route-pin", "cmt_1", {}, "route-pin-revert"),
      rpc.getSnapshot("test-admin", "route-pin", {
        at: "commit:cmt_1",
        includeDeleted: false,
        limit: 50,
      }),
      rpc.createChangeSet(
        "test-admin",
        "route-pin",
        { entries: [changeSetEntry] },
        "route-pin-change-set",
      ),
      rpc.listChangeSets("test-admin", "route-pin"),
      rpc.getChangeSet("test-admin", "route-pin", "chs_1"),
      rpc.getChangeSetDiff("test-admin", "route-pin", "chs_1"),
      rpc.approveChangeSet("test-admin", "route-pin", "chs_1", {}),
      rpc.rejectChangeSet("test-admin", "route-pin", "chs_1", {}),
    ]);
    expect(responses.map(({ status }) => status)).toEqual(Array(12).fill(501));
  });

  it("exports one parser and transport-error identity from the client package root", async () => {
    const parsing = parseClientResponse(
      new Response('{"error":{"code":"internal","message":"down"}}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      "health",
    );

    await expect(parsing).rejects.toBeInstanceOf(StashHttpError);
    await expect(parsing).rejects.toMatchObject({ status: 503, code: "internal" });
  });
});
