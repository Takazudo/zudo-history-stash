import { Hono } from "hono";
import type { AppEnv } from "../context.js";

const events = new Hono<AppEnv>();

events.get("/v1/stashes/:stash/events", (c) =>
  c.json(
    { error: { code: "not-implemented", message: "This route is not implemented yet." } },
    501,
  ),
);

export default events;
