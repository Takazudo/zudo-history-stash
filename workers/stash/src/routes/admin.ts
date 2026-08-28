import {
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  ListStashesQuery,
  RotateTokenBody,
  StashError,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.js";
import { createAdminStore } from "../d1/admin-store.js";

const admin = new Hono<AppEnv>();

function adminStore(c: Context<AppEnv>) {
  return createAdminStore(c.env, { now: c.get("deps").now });
}

function validationError(message: string): never {
  throw new StashError("validation", message);
}

function notFound(): never {
  throw new StashError("not-found", "The requested resource was not found.");
}

const jsonContentType = /^application\/([a-z-.]+\+)?json(?:;.*)?$/i;

const validateJsonSyntax: MiddlewareHandler<AppEnv> = async (c, next) => {
  const contentType = c.req.header("Content-Type");
  if (contentType !== undefined && jsonContentType.test(contentType)) {
    try {
      await c.req.json();
    } catch {
      validationError("Invalid JSON body.");
    }
  }
  await next();
};

admin.get(
  "/v1/stashes",
  zValidator("query", ListStashesQuery, (result) => {
    if (!result.success) validationError("Invalid stash list query.");
  }),
  async (c) => c.json(await adminStore(c).listStashes(c.req.valid("query"))),
);

admin.post(
  "/v1/stashes",
  validateJsonSyntax,
  zValidator("json", CreateStashBody, (result) => {
    if (!result.success) validationError("Invalid stash input.");
  }),
  async (c) => c.json(await adminStore(c).createStash(c.req.valid("json")), 201),
);

admin.get("/v1/stashes/:stash", async (c) => {
  const principal = c.get("principal");
  const store = adminStore(c);
  const stash =
    principal.kind === "admin"
      ? await store.getStash(c.req.param("stash"))
      : await store.getResolvedStash(c.get("routeStash"));
  if (stash === null) notFound();
  return c.json(stash);
});

admin.post(
  "/v1/stashes/:stash/tokens",
  validateJsonSyntax,
  zValidator("json", CreateTokenBody, (result) => {
    if (!result.success) validationError("Invalid token input.");
  }),
  async (c) =>
    c.json(await adminStore(c).createToken(c.get("routeStash").name, c.req.valid("json")), 201),
);

admin.get("/v1/stashes/:stash/tokens", async (c) =>
  c.json(await adminStore(c).listTokens(c.get("routeStash").name)),
);

admin.post(
  "/v1/stashes/:stash/tokens/:id/rotate",
  validateJsonSyntax,
  zValidator("json", RotateTokenBody, (result) => {
    if (!result.success) validationError("Invalid token rotation input.");
  }),
  async (c) =>
    c.json(
      await adminStore(c).rotateToken(
        c.get("routeStash").name,
        c.req.param("id"),
        c.req.valid("json"),
      ),
      201,
    ),
);

admin.delete("/v1/stashes/:stash/tokens/:id", async (c) => {
  await adminStore(c).revokeToken(c.get("routeStash").name, c.req.param("id"));
  return c.body(null, 204);
});

admin.get(
  "/v1/changes",
  zValidator("query", ChangesQuery, (result) => {
    if (!result.success) validationError("Invalid changes query.");
  }),
  async (c) => c.json(await adminStore(c).listChanges(c.req.valid("query"))),
);

export default admin;
