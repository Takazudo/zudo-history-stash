import { ImportBody, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import { createImport } from "../d1/import.js";

const importRoutes = new Hono<AppEnv>();

importRoutes.post(
  "/v1/stashes/:stash/import",
  requireRoute("importHistory"),
  zValidator("json", ImportBody, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid import input.");
  }),
  async (c) => {
    const importer = createImport(c.env, {
      now: Date.now,
      createId: () => crypto.randomUUID(),
    });
    const result = await importer.importFile(c.req.param("stash"), c.req.valid("json"));
    if (!result.ok) throw new StashError(result.error.code, result.error.message, result.current);
    return c.json(result.value, 201);
  },
);

export default importRoutes;
