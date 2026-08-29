import {
  STASH_CLIENT_ID_HEADER,
  isStashClientId,
  type CommitResult,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { STASH_EVENTS_PUBLISH_PATH } from "./stash-events.js";

const INTERNAL_EVENTS_ORIGIN = "https://stash-events.internal";

export interface EventExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Returns the caller-provided advisory origin only when it is a canonical client identity. */
export function eventOrigin(request: Request): string | null {
  const value = request.headers.get(STASH_CLIENT_ID_HEADER);
  return isStashClientId(value) ? value : null;
}

/** Builds the ordered live-only frames for a newly persisted multi-entry commit. */
export function commitEvents(result: CommitResult, origin: string | null): StashEvent[] {
  return [
    ...result.entries.map((entry): StashEvent => ({
      type: "change",
      changeId: entry.changeId,
      commitId: result.id,
      stash: result.stash,
      path: entry.path,
      version: entry.version,
      kind: entry.kind,
      origin,
      createdAt: result.createdAt,
    })),
    {
      type: "commit",
      commitId: result.id,
      stash: result.stash,
      entryCount: result.entryCount,
      firstChangeId: result.firstChangeId,
      lastChangeId: result.lastChangeId,
      origin,
    },
  ];
}

export async function deliverEvents(
  env: Env,
  stash: string,
  events: readonly StashEvent[],
): Promise<void> {
  const stub = env.STASH_EVENTS.getByName(stash);
  if (events.length === 0) return;
  const response = await stub.fetch(
    new Request(`${INTERNAL_EVENTS_ORIGIN}${STASH_EVENTS_PUBLISH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`StashEvents publish returned ${response.status}`);
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
    deliverEvents(env, stash, events).catch((error: unknown) => {
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
