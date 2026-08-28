export type RoutePrincipal = "open" | "any" | "admin" | "admin-or-stash" | "read" | "write";
export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE";
export type RouteTransport = "any" | "fetch-only";

export const ROUTES = [
  { id: "health", method: "GET", template: "/v1/health", principal: "open" },
  { id: "me", method: "GET", template: "/v1/me", principal: "any" },
  { id: "listStashes", method: "GET", template: "/v1/stashes", principal: "admin" },
  { id: "createStash", method: "POST", template: "/v1/stashes", principal: "admin" },
  { id: "getStash", method: "GET", template: "/v1/stashes/:stash", principal: "admin-or-stash" },
  { id: "deleteStash", method: "DELETE", template: "/v1/stashes/:stash", principal: "admin" },
  {
    id: "restoreStash",
    method: "POST",
    template: "/v1/stashes/:stash/restore",
    principal: "admin",
  },
  { id: "createToken", method: "POST", template: "/v1/stashes/:stash/tokens", principal: "admin" },
  { id: "listTokens", method: "GET", template: "/v1/stashes/:stash/tokens", principal: "admin" },
  {
    id: "rotateToken",
    method: "POST",
    template: "/v1/stashes/:stash/tokens/:id/rotate",
    principal: "admin",
  },
  {
    id: "revokeToken",
    method: "DELETE",
    template: "/v1/stashes/:stash/tokens/:id",
    principal: "admin",
  },
  {
    id: "importHistory",
    method: "POST",
    template: "/v1/stashes/:stash/import",
    principal: "admin",
  },
  { id: "listChanges", method: "GET", template: "/v1/changes", principal: "admin" },
  { id: "runGc", method: "POST", template: "/v1/admin/gc", principal: "admin" },
  { id: "listGcRuns", method: "GET", template: "/v1/admin/gc/runs", principal: "admin" },
  {
    id: "createProposal",
    method: "POST",
    template: "/v1/stashes/:stash/proposals",
    principal: "write",
  },
  {
    id: "listProposals",
    method: "GET",
    template: "/v1/stashes/:stash/proposals",
    principal: "read",
  },
  {
    id: "getProposal",
    method: "GET",
    template: "/v1/stashes/:stash/proposals/:id",
    principal: "read",
  },
  {
    id: "getProposalDiff",
    method: "GET",
    template: "/v1/stashes/:stash/proposals/:id/diff",
    principal: "read",
  },
  {
    id: "approveProposal",
    method: "POST",
    template: "/v1/stashes/:stash/proposals/:id/approve",
    principal: "write",
  },
  {
    id: "rejectProposal",
    method: "POST",
    template: "/v1/stashes/:stash/proposals/:id/reject",
    principal: "write",
  },
  {
    id: "stashEvents",
    method: "GET",
    template: "/v1/stashes/:stash/events",
    principal: "read",
    transport: "fetch-only",
  },
  { id: "listFiles", method: "GET", template: "/v1/stashes/:stash/files", principal: "read" },
  { id: "getFile", method: "GET", template: "/v1/stashes/:stash/files/*path", principal: "read" },
  { id: "putFile", method: "PUT", template: "/v1/stashes/:stash/files/*path", principal: "write" },
  {
    id: "deleteFile",
    method: "POST",
    template: "/v1/stashes/:stash/delete/*path",
    principal: "write",
  },
  {
    id: "rollbackFile",
    method: "POST",
    template: "/v1/stashes/:stash/rollback/*path",
    principal: "write",
  },
  {
    id: "getHistory",
    method: "GET",
    template: "/v1/stashes/:stash/history/*path",
    principal: "read",
  },
  { id: "getDiff", method: "GET", template: "/v1/stashes/:stash/diff/*path", principal: "read" },
  {
    id: "diffCandidate",
    method: "POST",
    template: "/v1/stashes/:stash/diff/*path",
    principal: "read",
  },
  {
    id: "getStashChanges",
    method: "GET",
    template: "/v1/stashes/:stash/changes",
    principal: "read",
  },
] as const satisfies readonly {
  id: string;
  method: RouteMethod;
  template: string;
  principal: RoutePrincipal;
  transport?: RouteTransport;
}[];

export type Route = (typeof ROUTES)[number];
export type RouteId = Route["id"];
export type FetchOnlyRouteId = Extract<Route, { transport: "fetch-only" }>["id"];
export type RpcRouteId = Exclude<RouteId, FetchOnlyRouteId>;

/** Whether the SDK stamps a stable client identity on this route. */
export function routeAcceptsClientId(route: Pick<Route, "method" | "principal">): boolean {
  return route.method !== "GET" && route.principal !== "read";
}

/** Resolves the optional transport marker to its semantic default. */
export function transportForRoute(routeId: RouteId): RouteTransport {
  const route = ROUTES.find((candidate) => candidate.id === routeId);
  return route && "transport" in route ? route.transport : "any";
}
