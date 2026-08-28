import { EventsQuery, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv, Principal } from "../context.js";
import { parseStashEventsLifetimeMs } from "../events/stash-events.js";
import { createPublicStreamDeadline, subscribeToStashEvents } from "../events/subscribe.js";

const events = new Hono<AppEnv>();

function invalidLifetime(): StashError {
  return new StashError("internal", "The stash event stream lifetime is invalid.");
}

/** Resolves the revocation window once, after authentication, before opening the DO stream. */
export function effectiveStashEventsLifetimeMs(
  configuredValue: string,
  principal: Principal,
  now: number,
): number {
  const configuredMs = parseStashEventsLifetimeMs(configuredValue);
  if (configuredMs === null || !Number.isFinite(now)) throw invalidLifetime();
  if (principal.kind === "admin" || principal.expiresAt === null) return configuredMs;

  const expiresAt = Date.parse(principal.expiresAt);
  if (!Number.isFinite(expiresAt)) throw invalidLifetime();
  const remainingMs = Math.floor(expiresAt - now);
  if (remainingMs < 1) {
    throw new StashError("unauthorized", "A valid bearer token is required.");
  }
  return Math.min(configuredMs, remainingMs);
}

events.get(
  "/v1/stashes/:stash/events",
  zValidator("query", EventsQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid events query.");
  }),
  async (c) => {
    const stash = c.get("routeStash").name;
    const { since } = c.req.valid("query");
    const lifetimeMs = effectiveStashEventsLifetimeMs(
      c.env.STASH_EVENTS_MAX_STREAM_MS,
      c.get("principal"),
      c.get("deps").now(),
    );
    // This is intentionally the first work after the authenticated effective lifetime is known.
    // The same absolute fence bounds dispatch, reconciliation, and downstream stream consumption.
    const deadline = createPublicStreamDeadline(lifetimeMs);
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await subscribeToStashEvents(c.env, stash, {
        deadline,
        ...(since === undefined ? {} : { since }),
      });
    } catch (error) {
      deadline.clear();
      throw error;
    }
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
