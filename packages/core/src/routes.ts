export type RoutePrincipal = "open" | "any" | "admin" | "admin-or-stash" | "read" | "write";
export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export const ROUTES = [
  { id: "health", method: "GET", template: "/v1/health", principal: "open" },
  { id: "me", method: "GET", template: "/v1/me", principal: "any" },
  { id: "listStashes", method: "GET", template: "/v1/stashes", principal: "admin" },
  { id: "createStash", method: "POST", template: "/v1/stashes", principal: "admin" },
  { id: "getStash", method: "GET", template: "/v1/stashes/:stash", principal: "admin-or-stash" },
  { id: "createToken", method: "POST", template: "/v1/stashes/:stash/tokens", principal: "admin" },
  { id: "listTokens", method: "GET", template: "/v1/stashes/:stash/tokens", principal: "admin" },
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
}[];

export type Route = (typeof ROUTES)[number];
export type RouteId = Route["id"];
