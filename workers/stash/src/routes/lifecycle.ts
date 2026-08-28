import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { createAdminStore } from "../d1/admin-store.js";

const lifecycle = new Hono<AppEnv>();

lifecycle.delete("/v1/stashes/:stash", async (c) => {
  const store = createAdminStore(c.env, { now: c.get("deps").now });
  return c.json(await store.deleteStash(c.req.param("stash")));
});

lifecycle.post("/v1/stashes/:stash/restore", async (c) => {
  const store = createAdminStore(c.env, { now: c.get("deps").now });
  return c.json(await store.restoreStash(c.req.param("stash")));
});

export default lifecycle;
