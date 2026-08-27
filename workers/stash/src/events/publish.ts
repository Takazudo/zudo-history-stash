import type { StashEvent } from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { STASH_EVENTS_PUBLISH_PATH } from "./stash-events.js";

const INTERNAL_EVENTS_ORIGIN = "https://stash-events.internal";

export interface EventExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Returns the caller-provided advisory origin only when it is a safe bounded header value. */
export function eventOrigin(request: Request): string | null {
  const value = request.headers.get("X-Stash-Client-Id");
  if (value === null || [...value].length < 1 || [...value].length > 64 || /[\r\n]/.test(value)) {
    return null;
  }
  return value;
}

async function deliver(env: Env, stash: string, events: readonly StashEvent[]): Promise<void> {
  const stub = env.STASH_EVENTS.getByName(stash);
  for (const event of events) {
    const response = await stub.fetch(
      new Request(`${INTERNAL_EVENTS_ORIGIN}${STASH_EVENTS_PUBLISH_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`StashEvents publish returned ${response.status}`);
    }
  }
}

/** Schedules ordered, advisory publication without allowing it to affect the committed response. */
export function publishEvents(
  env: Env,
  ctx: EventExecutionContext,
  stash: string,
  events: readonly StashEvent[],
): void {
  if (events.length === 0) return;
  ctx.waitUntil(
    deliver(env, stash, events).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          message: "stash event publication failed",
          stash,
          eventCount: events.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
}
