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

const proposalRouteProbes = [
  { id: "createProposal", method: "POST", path: "/v1/stashes/route-pin/proposals" },
  { id: "listProposals", method: "GET", path: "/v1/stashes/route-pin/proposals" },
  {
    id: "getProposal",
    method: "GET",
    path: "/v1/stashes/route-pin/proposals/prp_0000000000000deadbeef",
  },
  {
    id: "getProposalDiff",
    method: "GET",
    path: "/v1/stashes/route-pin/proposals/prp_0000000000000deadbeef/diff",
  },
  {
    id: "approveProposal",
    method: "POST",
    path: "/v1/stashes/route-pin/proposals/prp_0000000000000deadbeef/approve",
  },
  {
    id: "rejectProposal",
    method: "POST",
    path: "/v1/stashes/route-pin/proposals/prp_0000000000000deadbeef/reject",
  },
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
  for (const match of apiReference.matchAll(/^### `(GET|POST|PUT|DELETE) (\/v1\/[^`]+)`$/gm)) {
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
    expect(ROUTES.filter(({ id }) => transportForRoute(id) === "fetch-only")).toEqual([
      expect.objectContaining({ id: "stashEvents" }),
    ]);
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

  it.each(proposalRouteProbes)("mounts the dedicated real handler for $id", async (route) => {
    await seedStash("route-pin");
    const hasBody = route.method === "POST";
    const response = await request(app, `http://stash.test${route.path}`, {
      method: route.method,
      headers: {
        ...bearer("test-admin"),
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: "{}" } : {}),
    });

    expect(response.status).not.toBe(501);
    expect(response.status).toBe(
      route.id === "listProposals" ? 200 : route.id === "createProposal" ? 400 : 404,
    );
  });

  it("keeps all six raw proposal RPC methods on generic request transport", async () => {
    await seedStash("route-pin");
    const rpc = new StashRpc(createExecutionContext(), createTestEnv().env);
    const createdResponse = await rpc.createProposal(
      "test-admin",
      "route-pin",
      { path: "docs/proposal.md", body: "candidate", baseVersion: null },
      "route-pin-create",
    );
    expect(createdResponse.status).toBe(201);
    const proposalId = (await createdResponse.json<{ id: string }>()).id;

    expect(
      (await rpc.listProposals("test-admin", "route-pin", { status: "all", limit: 1 })).status,
    ).toBe(200);
    expect((await rpc.getProposal("test-admin", "route-pin", proposalId)).status).toBe(200);
    expect(
      (await rpc.getProposalDiff("test-admin", "route-pin", proposalId, { context: 1 })).status,
    ).toBe(200);
    expect((await rpc.approveProposal("test-admin", "route-pin", proposalId, {})).status).toBe(200);
    expect((await rpc.rejectProposal("test-admin", "route-pin", proposalId, {})).status).toBe(409);
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
