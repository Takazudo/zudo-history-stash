import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import { createAdminStore } from "../d1/admin-store.js";

const lifecycle = new Hono<AppEnv>();

lifecycle.delete("/v1/stashes/:stash", requireRoute("deleteStash"), async (c) => {
  const store = createAdminStore(c.env, { now: c.get("deps").now });
  return c.json(await store.deleteStash(c.req.param("stash")));
});

lifecycle.post("/v1/stashes/:stash/restore", requireRoute("restoreStash"), async (c) => {
  const store = createAdminStore(c.env, { now: c.get("deps").now });
  return c.json(await store.restoreStash(c.req.param("stash")));
});

export default lifecycle;
