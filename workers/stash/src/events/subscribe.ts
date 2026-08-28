import {
  StashError,
  type StashChangeEvent,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import type { ReadChangesPage } from "../d1/reads.js";
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

export interface PublicStreamDeadline {
  readonly lifetimeMs: number;
  readonly signal: AbortSignal;
  readonly expired: Promise<void>;
  readonly hasExpired: () => boolean;
  readonly clear: () => void;
}

const EXPIRED = Symbol("stash events public response expired");
const LIFETIME_FRAME = encodeEvent({ type: "reconnect", reason: "lifetime" });

export function createPublicStreamDeadline(lifetimeMs: number): PublicStreamDeadline {
  const abort = new AbortController();
  const expiresAt = performance.now() + lifetimeMs;
  let hasExpired = false;
  let resolveExpired: () => void = () => undefined;
  const expired = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expire = () => {
    if (hasExpired) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    hasExpired = true;
    abort.abort("stash event stream lifetime elapsed");
    resolveExpired();
  };
  const onTimer = () => {
    const remainingMs = expiresAt - performance.now();
    if (remainingMs > 0) {
      timer = setTimeout(onTimer, Math.ceil(remainingMs));
      return;
    }
    expire();
  };
  timer = setTimeout(onTimer, lifetimeMs);

  return {
    lifetimeMs,
    signal: abort.signal,
    expired,
    hasExpired: () => {
      // A completed operation's microtask can run before an overdue timer callback after an
      // event-loop stall. The absolute monotonic fence, rather than timer ordering, is authoritative.
      if (!hasExpired && performance.now() >= expiresAt) expire();
      return hasExpired;
    },
    clear() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}

type Settled<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown };

async function beforePublicDeadline<T>(
  operation: Promise<T>,
  deadline: PublicStreamDeadline,
  releaseLateValue?: (value: T) => Promise<void>,
): Promise<T | typeof EXPIRED> {
  const settled: Promise<Settled<T>> = operation.then(
    (value): Settled<T> => ({ kind: "fulfilled", value }),
    (error: unknown): Settled<T> => ({ kind: "rejected", error }),
  );
  const outcome = await Promise.race([
    settled,
    deadline.expired.then<Settled<T> | typeof EXPIRED>(() => EXPIRED),
  ]);

  if (outcome === EXPIRED || deadline.hasExpired()) {
    if (releaseLateValue !== undefined) {
      // D1 has no AbortSignal surface and a test double may ignore a dispatch signal. Observe the
      // late settlement solely to release resources; its value is never returned to the compositor.
      void settled.then(async (late) => {
        if (late.kind === "fulfilled") await releaseLateValue(late.value);
      });
    }
    return EXPIRED;
  }
  if (outcome.kind === "rejected") throw outcome.error;
  return outcome.value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already have been closed by the deadline signal.
  }
}

function containsFrame(bytes: Uint8Array, frame: Uint8Array): boolean {
  if (bytes.byteLength < frame.byteLength) return false;
  for (let offset = 0; offset <= bytes.byteLength - frame.byteLength; offset += 1) {
    let matches = true;
    for (let index = 0; index < frame.byteLength; index += 1) {
      if (bytes[offset + index] !== frame[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/** @internal Exported only so the replay/live composition can be regression-tested directly. */
export function prefixedLiveStream(
  prefix: Uint8Array[],
  live: LiveSubscription,
  firstLiveRead: Promise<ReadableStreamReadResult<Uint8Array>>,
  options: {
    deadline?: PublicStreamDeadline;
    terminalPrefixIndex?: number;
  } = {},
): ReadableStream<Uint8Array> {
  const releasedFrame = new Uint8Array();
  let prefixIndex = 0;
  let nextLiveRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = firstLiveRead;
  let canceled = false;
  let terminal = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closePromise: Promise<void> | undefined;

  const clearBufferedState = () => {
    for (let index = prefixIndex; index < prefix.length; index += 1) {
      prefix[index] = releasedFrame;
    }
    prefix.length = 0;
    prefixIndex = 0;
    nextLiveRead = undefined;
  };

  const closeLive = (reason?: unknown): Promise<void> => {
    closePromise ??= live.close(reason);
    return closePromise;
  };

  const removeDeadlineListener = () => {
    options.deadline?.signal.removeEventListener("abort", finishAtDeadline);
  };

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    frame?: Uint8Array,
    reason?: unknown,
  ) => {
    if (terminal) return;
    terminal = true;
    clearBufferedState();
    removeDeadlineListener();
    options.deadline?.clear();
    void closeLive(reason);
    try {
      if (frame !== undefined) controller.enqueue(frame);
      controller.close();
    } catch {
      // Downstream cancellation may close the controller in the same turn as the deadline.
    }
  };

  function finishAtDeadline(): void {
    if (controllerRef === undefined || canceled) return;
    finish(controllerRef, LIFETIME_FRAME, options.deadline?.signal.reason);
  }

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        options.deadline?.signal.addEventListener("abort", finishAtDeadline, { once: true });
        if (options.deadline?.signal.aborted === true) finishAtDeadline();
      },
      async pull(controller) {
        if (terminal || canceled) return;
        if (options.deadline?.hasExpired() === true) {
          finishAtDeadline();
          return;
        }
        const prefixed = prefix[prefixIndex];
        if (prefixed !== undefined) {
          const currentIndex = prefixIndex;
          prefix[prefixIndex] = releasedFrame;
          prefixIndex += 1;
          if (prefixIndex === prefix.length) {
            prefix.length = 0;
            prefixIndex = 0;
          }
          if (options.deadline?.hasExpired() === true) {
            finishAtDeadline();
            return;
          }
          controller.enqueue(prefixed);
          if (currentIndex === options.terminalPrefixIndex) finish(controller, undefined);
          return;
        }

        try {
          const pendingRead = nextLiveRead ?? live.reader.read();
          nextLiveRead = undefined;
          const result = await pendingRead;
          if (canceled || terminal) return;
          if (options.deadline?.hasExpired() === true) {
            finishAtDeadline();
            return;
          }
          if (result.done) {
            finish(controller);
            return;
          }
          const isLifetimeFrame = containsFrame(result.value, LIFETIME_FRAME);
          if (options.deadline?.hasExpired() === true) {
            finishAtDeadline();
          } else if (isLifetimeFrame) {
            finish(controller, result.value);
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          if (terminal || canceled) return;
          clearBufferedState();
          await closeLive(error);
          if (options.deadline?.hasExpired() === true) {
            finishAtDeadline();
          } else if (!canceled && !terminal) {
            removeDeadlineListener();
            options.deadline?.clear();
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        canceled = true;
        terminal = true;
        clearBufferedState();
        removeDeadlineListener();
        options.deadline?.clear();
        await closeLive(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export async function subscribeToStashEvents(
  env: Env,
  stash: string,
  options: { deadline: PublicStreamDeadline; since?: number },
): Promise<ReadableStream<Uint8Array>> {
  const { deadline } = options;
  const stub = env.STASH_EVENTS.getByName(stash);
  const subscriptionAbort = new AbortController();
  const subscriptionSignal = AbortSignal.any([subscriptionAbort.signal, deadline.signal]);
  let response: Response;
  try {
    const dispatched = await beforePublicDeadline(
      stub.fetch(
        new Request(`${INTERNAL_ORIGIN}${STASH_EVENTS_SUBSCRIBE_PATH}`, {
          headers: {
            [STASH_EVENTS_MAX_STREAM_MS_HEADER]: String(deadline.lifetimeMs),
          },
          signal: subscriptionSignal,
        }),
      ),
      deadline,
      cancelResponseBody,
    );
    if (dispatched === EXPIRED) {
      subscriptionAbort.abort(deadline.signal.reason);
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(LIFETIME_FRAME);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    }
    response = dispatched;
  } catch (error) {
    deadline.clear();
    subscriptionAbort.abort();
    throw error;
  }
  if (!response.ok || response.body === null) {
    subscriptionAbort.abort();
    const canceled = await beforePublicDeadline(cancelResponseBody(response), deadline);
    if (canceled === EXPIRED) {
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(LIFETIME_FRAME);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    }
    deadline.clear();
    throw new StashError("internal", "Unable to open the stash event stream.");
  }

  const liveReader = response.body.getReader();
  let liveClosed = false;
  const live: LiveSubscription = {
    reader: liveReader,
    async close(reason) {
      if (liveClosed) return;
      liveClosed = true;
      subscriptionAbort.abort(reason);
      try {
        await liveReader.cancel(reason);
      } catch {
        // The Durable Object may have closed the stream concurrently.
      }
    },
  };
  // Start one read before touching D1. The resolved chunk is the route's bounded handoff buffer;
  // subsequent live frames remain inside the Durable Object's byte-bounded subscriber queue.
  const firstLiveRead = liveReader.read();
  void firstLiveRead.catch(() => undefined);
  const frames: Uint8Array[] = [];
  const reads = createStashStore(env).reads;
  let checkpoint = options.since ?? null;

  try {
    if (options.since !== undefined) {
      let cursor = options.since;
      for (let pageIndex = 0; pageIndex < MAX_REPLAY_PAGES; pageIndex += 1) {
        const loadedPage: ReadChangesPage | typeof EXPIRED = await beforePublicDeadline(
          reads.listChanges(stash, { since: cursor, limit: REPLAY_PAGE_SIZE }),
          deadline,
        );
        if (loadedPage === EXPIRED) {
          void live.close(deadline.signal.reason);
          return prefixedLiveStream([], live, firstLiveRead, { deadline });
        }
        const page: ReadChangesPage = loadedPage;
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
          void live.close("replay limit reached");
          return prefixedLiveStream(frames, live, firstLiveRead, {
            deadline,
            terminalPrefixIndex: frames.length - 1,
          });
        }
        if (page.nextSince === null || page.nextSince <= cursor) {
          throw new StashError("internal", "The stash change feed cursor did not advance.");
        }
        cursor = page.nextSince;
      }
    }

    const loadedNewest = await beforePublicDeadline(
      reads.listChanges(stash, { limit: 1 }),
      deadline,
    );
    if (loadedNewest === EXPIRED) {
      void live.close(deadline.signal.reason);
      return prefixedLiveStream([], live, firstLiveRead, { deadline });
    }
    const newest = loadedNewest;
    const head = newest.changes[0]?.changeId ?? null;
    frames.push(
      encodeEvent({
        type: "ready",
        head,
        checkpoint: options.since === undefined ? head : checkpoint,
      }),
    );
    return prefixedLiveStream(frames, live, firstLiveRead, { deadline });
  } catch (error) {
    const closed = await beforePublicDeadline(live.close(error), deadline);
    if (closed === EXPIRED) {
      return prefixedLiveStream([], live, firstLiveRead, { deadline });
    }
    deadline.clear();
    throw error;
  }
}
