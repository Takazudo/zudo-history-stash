import { SnapshotQuery, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";

const snapshot = new Hono<AppEnv>();

snapshot.get(
  "/v1/stashes/:stash/snapshot",
  zValidator("query", SnapshotQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid snapshot query.");
  }),
  async (c) => {
    const query = c.req.valid("query");
    const commitId = query.at.slice("commit:".length);
    const result = await createStashStore(c.env).reads.getSnapshot(
      c.get("routeStash").name,
      commitId,
      query,
    );
    if (result === null) throw new StashError("not-found", "The requested resource was not found.");
    return c.json(result);
  },
);

export default snapshot;
