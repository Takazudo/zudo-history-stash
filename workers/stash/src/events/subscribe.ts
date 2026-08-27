import {
  StashError,
  type StashChangeEvent,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import { createStashStore } from "../d1/store.js";
import type { Env } from "../env.js";
import { STASH_EVENTS_MAX_STREAM_MS_HEADER, STASH_EVENTS_SUBSCRIBE_PATH } from "./stash-events.js";

const INTERNAL_ORIGIN = "https://events.internal";
const REPLAY_PAGE_SIZE = 200;
const MAX_REPLAY_PAGES = 5;
const encoder = new TextEncoder();

function encodeEvent(event: StashEvent): Uint8Array {
  const id = event.type === "change" ? `id: ${event.changeId}\n` : "";
  return encoder.encode(`event: ${event.type}\n${id}data: ${JSON.stringify(event)}\n\n`);
}

function replayEvent(change: {
  changeId: number;
  stash: string;
  path: string;
  version: number;
  kind: StashChangeEvent["kind"];
  createdAt: string;
}): StashChangeEvent {
  return {
    type: "change",
    changeId: change.changeId,
    stash: change.stash,
    path: change.path,
    version: change.version,
    kind: change.kind,
    origin: null,
    createdAt: change.createdAt,
  };
}

interface LiveSubscription {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  close: (reason?: unknown) => Promise<void>;
}

/** @internal Exported only so the replay/live composition can be regression-tested directly. */
export function prefixedLiveStream(
  prefix: Uint8Array[],
  live: LiveSubscription,
  firstLiveRead: Promise<ReadableStreamReadResult<Uint8Array>>,
): ReadableStream<Uint8Array> {
  const releasedFrame = new Uint8Array();
  let prefixIndex = 0;
  let nextLiveRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = firstLiveRead;
  let canceled = false;

  const clearBufferedState = () => {
    for (let index = prefixIndex; index < prefix.length; index += 1) {
      prefix[index] = releasedFrame;
    }
    prefix.length = 0;
    prefixIndex = 0;
    nextLiveRead = undefined;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const prefixed = prefix[prefixIndex];
      if (prefixed !== undefined) {
        prefix[prefixIndex] = releasedFrame;
        prefixIndex += 1;
        if (prefixIndex === prefix.length) {
          prefix.length = 0;
          prefixIndex = 0;
        }
        controller.enqueue(prefixed);
        return;
      }

      try {
        const pendingRead = nextLiveRead ?? live.reader.read();
        nextLiveRead = undefined;
        const result = await pendingRead;
        if (canceled) return;
        if (result.done) {
          clearBufferedState();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        clearBufferedState();
        if (!canceled) {
          await live.close(error);
          if (!canceled) controller.error(error);
        }
      }
    },
    async cancel(reason) {
      canceled = true;
      clearBufferedState();
      await live.close(reason);
    },
  });
}

function finiteStream(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index];
      if (frame === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(frame);
    },
  });
}

export async function subscribeToStashEvents(
  env: Env,
  stash: string,
  since?: number,
): Promise<ReadableStream<Uint8Array>> {
  const stub = env.STASH_EVENTS.getByName(stash);
  const subscriptionAbort = new AbortController();
  let response: Response;
  try {
    response = await stub.fetch(
      new Request(`${INTERNAL_ORIGIN}${STASH_EVENTS_SUBSCRIBE_PATH}`, {
        headers: {
          [STASH_EVENTS_MAX_STREAM_MS_HEADER]: env.STASH_EVENTS_MAX_STREAM_MS,
        },
        signal: subscriptionAbort.signal,
      }),
    );
  } catch (error) {
    subscriptionAbort.abort();
    throw error;
  }
  if (!response.ok || response.body === null) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the stable route error when the internal response is already closed.
    } finally {
      subscriptionAbort.abort();
    }
    throw new StashError("internal", "Unable to open the stash event stream.");
  }

  const liveReader = response.body.getReader();
  let liveClosed = false;
  const live: LiveSubscription = {
    reader: liveReader,
    async close(reason) {
      if (liveClosed) return;
      liveClosed = true;
      try {
        await liveReader.cancel(reason);
      } catch {
        // The Durable Object may have closed the stream concurrently.
      } finally {
        subscriptionAbort.abort();
      }
    },
  };
  // Start one read before touching D1. The resolved chunk is the route's bounded handoff buffer;
  // subsequent live frames remain inside the Durable Object's byte-bounded subscriber queue.
  const firstLiveRead = liveReader.read();
  void firstLiveRead.catch(() => undefined);
  const frames: Uint8Array[] = [];
  const reads = createStashStore(env).reads;
  let checkpoint = since ?? null;
  let cursor = since;

  try {
    if (cursor !== undefined) {
      for (let pageIndex = 0; pageIndex < MAX_REPLAY_PAGES; pageIndex += 1) {
        const page = await reads.listChanges(stash, { since: cursor, limit: REPLAY_PAGE_SIZE });
        if (!("nextSince" in page)) {
          throw new StashError("internal", "The stash change feed returned an invalid page.");
        }
        for (const change of page.changes) {
          frames.push(encodeEvent(replayEvent(change)));
          checkpoint = change.changeId;
        }
        if (!page.hasMore) break;
        if (pageIndex === MAX_REPLAY_PAGES - 1) {
          frames.push(encodeEvent({ type: "reconnect", reason: "replay-limit" }));
          await live.close();
          await firstLiveRead.catch(() => undefined);
          return finiteStream(frames);
        }
        if (page.nextSince === null || page.nextSince <= cursor) {
          throw new StashError("internal", "The stash change feed cursor did not advance.");
        }
        cursor = page.nextSince;
      }
    }

    const newest = await reads.listChanges(stash, { limit: 1 });
    const head = newest.changes[0]?.changeId ?? null;
    frames.push(
      encodeEvent({
        type: "ready",
        head,
        checkpoint: since === undefined ? head : checkpoint,
      }),
    );
    return prefixedLiveStream(frames, live, firstLiveRead);
  } catch (error) {
    await live.close();
    await firstLiveRead.catch(() => undefined);
    throw error;
  }
}
