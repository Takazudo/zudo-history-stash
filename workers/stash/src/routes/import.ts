import { ImportBody, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { createImport } from "../d1/import.js";
import { eventOrigin, publishEvents } from "../events/publish.js";

const importRoutes = new Hono<AppEnv>();

importRoutes.post(
  "/v1/stashes/:stash/import",
  zValidator("json", ImportBody, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid import input.");
  }),
  async (c) => {
    const importer = createImport(c.env, {
      now: Date.now,
      createId: () => crypto.randomUUID(),
    });
    const stash = c.get("routeStash").name;
    const input = c.req.valid("json");
    const result = await importer.importFile(stash, input);
    if (!result.ok) throw new StashError(result.error.code, result.error.message, result.current);
    const origin = eventOrigin(c.req.raw);
    publishEvents(
      c.env,
      c.executionCtx,
      stash,
      result.createdVersions.map((entry) => ({
        type: "change" as const,
        changeId: entry.changeId,
        commitId: result.value.commitId,
        stash,
        path: input.path,
        version: entry.version,
        kind: entry.kind,
        origin,
        createdAt: entry.createdAt,
      })),
    );
    return c.json(result.value, 201);
  },
);

export default importRoutes;
