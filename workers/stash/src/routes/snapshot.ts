import {
  SnapshotQuery,
  StashError,
  parseSnapshotSelector,
} from "@takazudo/zudo-history-stash-core";
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
    const selector = parseSnapshotSelector(query.at);
    if (selector === null) throw new StashError("validation", "Invalid snapshot query.");
    const stash = c.get("routeStash").name;
    const reads = createStashStore(c.env).reads;
    const commitId =
      selector.kind === "commit"
        ? selector.commitId
        : await reads.resolveCommitAtChange(stash, selector.changeId);
    if (commitId === null)
      throw new StashError("not-found", "The requested resource was not found.");
    const result = await reads.getSnapshot(stash, commitId, query);
    if (result === null) throw new StashError("not-found", "The requested resource was not found.");
    return c.json(result);
  },
);

export default snapshot;
