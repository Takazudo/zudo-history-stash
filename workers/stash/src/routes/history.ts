import {
  ChangesQuery,
  HistoryQuery,
  StashError,
  validatePath,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";

const history = new Hono<AppEnv>();

function filePath(c: Context<AppEnv>): string {
  // Hono decodes this named parameter once before returning it.
  const path = c.req.param("path");
  if (path === undefined) throw new StashError("invalid-path", "Invalid file path.");
  const validation = validatePath(path);
  if (!validation.ok) throw new StashError(validation.error, validation.message);
  return path;
}

history.get(
  "/v1/stashes/:stash/history/:path{.+}",
  zValidator("query", HistoryQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid history query.");
  }),
  async (c) => {
    const path = filePath(c);
    const page = await createStashStore(c.env).reads.listHistory(
      c.get("routeStash").name,
      path,
      c.req.valid("query"),
    );
    if (page === null) throw new StashError("not-found", "File not found.");
    return c.json(page);
  },
);

history.get(
  "/v1/stashes/:stash/changes",
  zValidator("query", ChangesQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid changes query.");
  }),
  async (c) => {
    const page = await createStashStore(c.env).reads.listChanges(
      c.get("routeStash").name,
      c.req.valid("query"),
    );
    return c.json(page);
  },
);

export default history;
