import { EventsQuery, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { subscribeToStashEvents } from "../events/subscribe.js";

const events = new Hono<AppEnv>();

events.get(
  "/v1/stashes/:stash/events",
  zValidator("query", EventsQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid events query.");
  }),
  async (c) => {
    const stream = await subscribeToStashEvents(
      c.env,
      c.get("routeStash").name,
      c.req.valid("query").since,
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  },
);

export default events;
