import {
  ChangesQuery,
  CreateStashBody,
  CreateTokenBody,
  ListQuery,
  StashError,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import { createAdminStore } from "../d1/admin-store.js";

const admin = new Hono<AppEnv>();

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
  requireRoute("listStashes"),
  zValidator("query", ListQuery, (result) => {
    if (!result.success) validationError("Invalid stash list query.");
  }),
  async (c) => c.json(await createAdminStore(c.env).listStashes(c.req.valid("query"))),
);

admin.post(
  "/v1/stashes",
  requireRoute("createStash"),
  validateJsonSyntax,
  zValidator("json", CreateStashBody, (result) => {
    if (!result.success) validationError("Invalid stash input.");
  }),
  async (c) => c.json(await createAdminStore(c.env).createStash(c.req.valid("json")), 201),
);

admin.get("/v1/stashes/:stash", requireRoute("getStash"), async (c) => {
  const stash = await createAdminStore(c.env).getStash(c.req.param("stash"));
  if (stash === null) notFound();
  return c.json(stash);
});

admin.post(
  "/v1/stashes/:stash/tokens",
  requireRoute("createToken"),
  validateJsonSyntax,
  zValidator("json", CreateTokenBody, (result) => {
    if (!result.success) validationError("Invalid token input.");
  }),
  async (c) =>
    c.json(
      await createAdminStore(c.env).createToken(c.req.param("stash"), c.req.valid("json")),
      201,
    ),
);

admin.get("/v1/stashes/:stash/tokens", requireRoute("listTokens"), async (c) =>
  c.json(await createAdminStore(c.env).listTokens(c.req.param("stash"))),
);

admin.delete("/v1/stashes/:stash/tokens/:id", requireRoute("revokeToken"), async (c) => {
  await createAdminStore(c.env).revokeToken(c.req.param("stash"), c.req.param("id"));
  return c.body(null, 204);
});

admin.get(
  "/v1/changes",
  requireRoute("listChanges"),
  zValidator("query", ChangesQuery, (result) => {
    if (!result.success) validationError("Invalid changes query.");
  }),
  async (c) => c.json(await createAdminStore(c.env).listChanges(c.req.valid("query"))),
);

export default admin;
