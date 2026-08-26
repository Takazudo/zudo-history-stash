import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { CLIENT_ROUTES, parseClientResponse, StashHttpError } from "@takazudo/zudo-history-stash";
import apiReference from "../../../docs/api.md?raw";
import app from "../src/app.js";
import { StashRpc } from "../src/rpc.js";

type RouteTuple = readonly [string, string];

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

  it("exposes every route as an explicit StashRpc prototype method", () => {
    const prototypeNames = new Set(Object.getOwnPropertyNames(StashRpc.prototype));
    for (const { id } of ROUTES) {
      expect(prototypeNames.has(id), `missing StashRpc.prototype.${id}`).toBe(true);
      expect(typeof Object.getOwnPropertyDescriptor(StashRpc.prototype, id)?.value).toBe(
        "function",
      );
    }
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
