import { expect, it } from "vitest";
import { ROUTES } from "./routes.js";

const expected = [
  ["GET", "/v1/health", "open"],
  ["GET", "/v1/me", "any"],
  ["GET", "/v1/stashes", "admin"],
  ["POST", "/v1/stashes", "admin"],
  ["GET", "/v1/stashes/:stash", "admin-or-stash"],
  ["POST", "/v1/stashes/:stash/tokens", "admin"],
  ["GET", "/v1/stashes/:stash/tokens", "admin"],
  ["DELETE", "/v1/stashes/:stash/tokens/:id", "admin"],
  ["POST", "/v1/stashes/:stash/import", "admin"],
  ["GET", "/v1/changes", "admin"],
  ["GET", "/v1/stashes/:stash/files", "read"],
  ["GET", "/v1/stashes/:stash/files/*path", "read"],
  ["PUT", "/v1/stashes/:stash/files/*path", "write"],
  ["POST", "/v1/stashes/:stash/delete/*path", "write"],
  ["POST", "/v1/stashes/:stash/rollback/*path", "write"],
  ["GET", "/v1/stashes/:stash/history/*path", "read"],
  ["GET", "/v1/stashes/:stash/diff/*path", "read"],
  ["POST", "/v1/stashes/:stash/diff/*path", "read"],
  ["GET", "/v1/stashes/:stash/changes", "read"],
];

it("pins every API endpoint, template, method, and capability", () => {
  expect(ROUTES).toHaveLength(19);
  expect(ROUTES.map(({ method, template, principal }) => [method, template, principal])).toEqual(
    expected,
  );
  expect(new Set(ROUTES.map(({ id }) => id)).size).toBe(ROUTES.length);
});
