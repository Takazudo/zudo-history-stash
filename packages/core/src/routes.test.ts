import { expect, it } from "vitest";
import { ROUTES, transportForRoute } from "./routes.js";

const expected = [
  ["GET", "/v1/health", "open"],
  ["GET", "/v1/capabilities", "open"],
  ["GET", "/v1/me", "any"],
  ["GET", "/v1/stashes", "admin"],
  ["POST", "/v1/stashes", "admin"],
  ["GET", "/v1/stashes/:stash", "admin-or-stash"],
  ["DELETE", "/v1/stashes/:stash", "admin"],
  ["POST", "/v1/stashes/:stash/restore", "admin"],
  ["POST", "/v1/stashes/:stash/tokens", "admin"],
  ["GET", "/v1/stashes/:stash/tokens", "admin"],
  ["POST", "/v1/stashes/:stash/tokens/:id/rotate", "admin"],
  ["DELETE", "/v1/stashes/:stash/tokens/:id", "admin"],
  ["POST", "/v1/stashes/:stash/import", "admin"],
  ["GET", "/v1/changes", "admin"],
  ["POST", "/v1/admin/gc", "admin"],
  ["GET", "/v1/admin/gc/runs", "admin"],
  ["POST", "/v1/stashes/:stash/commits", "write"],
  ["GET", "/v1/stashes/:stash/commits/:id", "read"],
  ["GET", "/v1/stashes/:stash/commits", "read"],
  ["GET", "/v1/stashes/:stash/commits/:id/diff", "read"],
  ["POST", "/v1/stashes/:stash/commits/:id/revert", "write"],
  ["GET", "/v1/stashes/:stash/snapshot", "read"],
  ["POST", "/v1/stashes/:stash/change-sets", "write"],
  ["GET", "/v1/stashes/:stash/change-sets", "read"],
  ["GET", "/v1/stashes/:stash/change-sets/:id", "read"],
  ["GET", "/v1/stashes/:stash/change-sets/:id/diff", "read"],
  ["POST", "/v1/stashes/:stash/change-sets/:id/approve", "write"],
  ["POST", "/v1/stashes/:stash/change-sets/:id/reject", "write"],
  ["GET", "/v1/stashes/:stash/events", "read"],
  ["GET", "/v1/stashes/:stash/files", "read"],
  ["GET", "/v1/stashes/:stash/files/*path", "read"],
  ["PUT", "/v1/stashes/:stash/files/*path", "write"],
  ["POST", "/v1/stashes/:stash/delete/*path", "write"],
  ["POST", "/v1/stashes/:stash/rollback/*path", "write"],
  ["GET", "/v1/stashes/:stash/history/*path", "read"],
  ["GET", "/v1/stashes/:stash/diff/*path", "read"],
  ["POST", "/v1/stashes/:stash/diff/*path", "read"],
  ["GET", "/v1/stashes/:stash/changes", "read"],
  ["GET", "/v1/stashes/:stash/raw/*path", "read"],
  ["HEAD", "/v1/stashes/:stash/raw/*path", "read"],
  ["GET", "/v1/stashes/:stash/versions/:version/raw/*path", "read"],
  ["HEAD", "/v1/stashes/:stash/versions/:version/raw/*path", "read"],
  ["POST", "/v1/stashes/:stash/uploads/*path", "write"],
  ["GET", "/v1/stashes/:stash/uploads/:sessionId", "write"],
  ["DELETE", "/v1/stashes/:stash/uploads/:sessionId", "write"],
  ["PUT", "/v1/stashes/:stash/uploads/:sessionId/content", "write"],
  ["PUT", "/v1/stashes/:stash/uploads/:sessionId/parts/:partNumber", "write"],
  ["POST", "/v1/stashes/:stash/uploads/:sessionId/complete", "write"],
  ["POST", "/v1/stashes/:stash/uploads/:sessionId/resume", "write"],
];

it("pins every API endpoint, template, method, and capability", () => {
  expect(ROUTES).toHaveLength(49);
  expect(ROUTES.map(({ method, template, principal }) => [method, template, principal])).toEqual(
    expected,
  );
  expect(new Set(ROUTES.map(({ id }) => id)).size).toBe(ROUTES.length);
  expect(ROUTES.filter(({ id }) => transportForRoute(id) === "fetch-only")).toHaveLength(13);
  expect(ROUTES.filter(({ id }) => transportForRoute(id) === "fetch-only")).toContainEqual(
    expect.objectContaining({ id: "stashEvents", transport: "fetch-only" }),
  );
  expect(ROUTES.filter(({ id }) => transportForRoute(id) === "any")).toHaveLength(36);
});
