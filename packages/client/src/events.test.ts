import type { StashChangeEvent, StashEvent } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it, vi } from "vitest";
import {
  createStashEventStream,
  type StashEventConnector,
  type StashEventStreamDependencies,
} from "./events.js";
import { StashHttpError } from "./parse.js";

const encoder = new TextEncoder();

class Probe<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    return item === undefined
      ? new Promise((resolve) => this.#waiters.push(resolve))
      : Promise.resolve(item);
  }
}

type Connection = {
  since: number | undefined;
  signal: AbortSignal;
  respond(response: Response): void;
  reject(error: unknown): void;
};

function testConnector(): StashEventConnector & {
  readonly count: number;
  next(): Promise<Connection>;
} {
  const requests = new Probe<Connection>();
  let count = 0;
  return {
    get count() {
      return count;
    },
    next: () => requests.next(),
    connect(since, signal) {
      count += 1;
      return new Promise((resolve, reject) => {
        requests.push({ since, signal, respond: resolve, reject });
      });
    },
  };
}

type Delay = {
  milliseconds: number;
  release(): void;
};

function testTiming(random = 0): Partial<StashEventStreamDependencies> & {
  next(): Promise<Delay>;
} {
  const delays = new Probe<Delay>();
  return {
    random: () => random,
    next: () => delays.next(),
    sleep(milliseconds, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        delays.push({
          milliseconds,
          release() {
            signal.removeEventListener("abort", abort);
            resolve();
          },
        });
      });
    },
  };
}

function change(changeId: number): StashChangeEvent {
  return {
    type: "change",
    changeId,
    stash: "notes",
    path: `${changeId}.md`,
    version: changeId,
    kind: "put",
    origin: "tab-a",
    createdAt: "2026-08-28T01:02:03.000Z",
  };
}

function encodeFrame(event: StashEvent): Uint8Array {
  const id = event.type === "change" ? `id: ${event.changeId}\n` : "";
  return encoder.encode(`event: ${event.type}\n${id}data: ${JSON.stringify(event)}\n\n`);
}

function openEventResponse(): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
  cancelled: Promise<void>;
  emit(...events: StashEvent[]): void;
  emitRaw(frame: string): void;
  close(): void;
  error(error: unknown): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let markCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  const cancel = vi.fn(() => markCancelled());
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    }),
    cancel,
    cancelled,
    emit(...events) {
      for (const event of events) controller.enqueue(encodeFrame(event));
    },
    emitRaw(frame) {
      controller.enqueue(encoder.encode(frame));
    },
    close: () => controller.close(),
    error: (error) => controller.error(error),
  };
}

function closedEventResponse(...events: StashEvent[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encodeFrame(event));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("createStashEventStream", () => {
  it("dedupes exact ids while reconnecting from the replay-only checkpoint", async () => {
    const connector = testConnector();
    const timing = testTiming();
    const stream = createStashEventStream(connector, { since: 5 }, timing);
    const statuses: string[] = [];
    stream.onStatus((status) => statuses.push(typeof status === "string" ? status : "failed"));
    const iterator = stream[Symbol.asyncIterator]();
    const firstConnection = await connector.next();
    expect(firstConnection.since).toBe(5);
    const response = openEventResponse();
    firstConnection.respond(response.response);

    const received = Promise.all(Array.from({ length: 5 }, () => iterator.next()));
    response.emit(
      change(10),
      change(10),
      { type: "ready", head: 10, checkpoint: 10 },
      change(12),
      change(8),
      { type: "reconnect", reason: "lifetime" },
    );

    expect((await received).map((result) => result.value)).toEqual([
      change(10),
      { type: "ready", head: 10, checkpoint: 10 },
      change(12),
      change(8),
      { type: "reconnect", reason: "lifetime" },
    ]);
    const rotation = await timing.next();
    expect(rotation.milliseconds).toBe(0);
    expect(stream.failureCount).toBe(0);
    rotation.release();
    const secondConnection = await connector.next();
    expect(secondConnection.since).toBe(10);
    expect(statuses).toEqual(["connecting", "live", "reconnecting"]);
    stream.close();
    expect(secondConnection.signal.aborted).toBe(true);
  });

  it("evicts exact ids by observation order after the bounded 1,000-id window", async () => {
    const connector = testConnector();
    const stream = createStashEventStream(connector);
    const iterator = stream[Symbol.asyncIterator]();
    const connection = await connector.next();
    const response = openEventResponse();
    connection.respond(response.response);
    response.emit({ type: "ready", head: null, checkpoint: null });
    await iterator.next();

    const events = Array.from({ length: 1_001 }, (_, index) => change(index + 1));
    response.emit(...events, change(1));
    for (const event of [...events, change(1)]) {
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: event });
    }
    stream.close();
  });

  it("dedupes the exact validated SSE id rather than a numeric high-water or normalized id", async () => {
    const connector = testConnector();
    const stream = createStashEventStream(connector);
    const iterator = stream[Symbol.asyncIterator]();
    const connection = await connector.next();
    const response = openEventResponse();
    connection.respond(response.response);
    response.emit({ type: "ready", head: 1, checkpoint: 1 }, change(1));
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: change(1) });

    const padded = `event: change\nid: 01\ndata: ${JSON.stringify(change(1))}\n\n`;
    response.emitRaw(padded);
    await expect(iterator.next()).resolves.toMatchObject({ value: change(1) });
    response.emitRaw(padded);
    response.emit(change(2));
    await expect(iterator.next()).resolves.toMatchObject({ value: change(2) });
    stream.close();
  });

  it("treats clean EOF as a healthy rotation without advancing from live ids", async () => {
    const connector = testConnector();
    const timing = testTiming(0.5);
    const stream = createStashEventStream(connector, {}, timing);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await connector.next();
    first.respond(closedEventResponse({ type: "ready", head: 4, checkpoint: 4 }, change(9)));
    await iterator.next();
    await iterator.next();

    const delay = await timing.next();
    expect(delay.milliseconds).toBe(125);
    expect(stream.failureCount).toBe(0);
    delay.release();
    const second = await connector.next();
    expect(second.since).toBe(4);
    stream.close();
  });

  it("backs off retryable failures, re-notifies the count, and resets only after ready", async () => {
    const connector = testConnector();
    const timing = testTiming();
    const stream = createStashEventStream(connector, {}, timing);
    const snapshots: { status: string; failures: number }[] = [];
    stream.onStatus((status) => {
      snapshots.push({
        status: typeof status === "string" ? status : "failed",
        failures: stream.failureCount,
      });
    });
    stream.onStatus(() => {
      throw new Error("observer failure");
    });

    const first = await connector.next();
    first.reject(new TypeError("offline"));
    const oneSecond = await timing.next();
    expect(oneSecond.milliseconds).toBe(1_000);
    oneSecond.release();

    const second = await connector.next();
    second.reject(new TypeError("still offline"));
    const twoSeconds = await timing.next();
    expect(twoSeconds.milliseconds).toBe(2_000);
    twoSeconds.release();

    const third = await connector.next();
    const beforeReady = openEventResponse();
    third.respond(beforeReady.response);
    const iterator = stream[Symbol.asyncIterator]();
    const replayed = iterator.next();
    beforeReady.emit(change(7));
    await expect(replayed).resolves.toMatchObject({ value: change(7) });
    beforeReady.error(new TypeError("body failed"));
    const fourSeconds = await timing.next();
    expect(fourSeconds.milliseconds).toBe(4_000);
    expect(stream.failureCount).toBe(3);
    fourSeconds.release();

    const fourth = await connector.next();
    expect(fourth.since).toBe(7);
    const healthy = openEventResponse();
    fourth.respond(healthy.response);
    const ready = iterator.next();
    healthy.emit({ type: "ready", head: 9, checkpoint: 9 });
    await ready;
    expect(stream.status).toBe("live");
    expect(stream.failureCount).toBe(0);
    expect(snapshots).toEqual([
      { status: "connecting", failures: 0 },
      { status: "reconnecting", failures: 1 },
      { status: "reconnecting", failures: 2 },
      { status: "reconnecting", failures: 3 },
      { status: "live", failures: 0 },
    ]);
    stream.close();
  });

  it("retries 429, 5xx, missing bodies, and wrong content types", async () => {
    const connector = testConnector();
    const timing = testTiming();
    const stream = createStashEventStream(connector, {}, timing);
    const responses = [
      new Response("limited", { status: 429 }),
      new Response("broken", { status: 503 }),
      new Response(null, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      new Response("not SSE", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ];

    for (const [index, response] of responses.entries()) {
      const connection = await connector.next();
      connection.respond(response);
      const delay = await timing.next();
      expect(delay.milliseconds).toBe([1_000, 2_000, 4_000, 8_000][index]);
      delay.release();
    }
    const finalConnection = await connector.next();
    expect(finalConnection.since).toBeUndefined();
    stream.close();
  });

  it("turns a 401 on reconnect into a terminal StashHttpError", async () => {
    const connector = testConnector();
    const timing = testTiming();
    const stream = createStashEventStream(connector, {}, timing);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await connector.next();
    first.respond(
      closedEventResponse(
        { type: "ready", head: 2, checkpoint: 2 },
        { type: "reconnect", reason: "lifetime" },
      ),
    );
    await iterator.next();
    await iterator.next();
    const rotation = await timing.next();
    rotation.release();

    const reconnect = await connector.next();
    reconnect.respond(
      Response.json(
        { error: { code: "unauthorized", message: "Token is no longer valid" } },
        { status: 401 },
      ),
    );
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(stream.status).toEqual({
      failed: expect.objectContaining({
        name: "StashHttpError",
        status: 401,
        code: "unauthorized",
      }),
    });
    if (typeof stream.status !== "string") {
      expect(stream.status.failed).toBeInstanceOf(StashHttpError);
    }
    stream.close();
    expect(stream.status).toBe("closed");
  });

  it("closes pending iteration and cancels an active response on close or abort", async () => {
    const connector = testConnector();
    const stream = createStashEventStream(connector);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    const connection = await connector.next();
    const response = openEventResponse();
    connection.respond(response.response);
    stream.close();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await response.cancelled;
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(connection.signal.aborted).toBe(true);
    expect(stream.status).toBe("closed");
    stream.close();

    const external = new AbortController();
    external.abort();
    const unusedConnector = testConnector();
    const alreadyClosed = createStashEventStream(unusedConnector, { signal: external.signal });
    expect(alreadyClosed.status).toBe("closed");
    expect(unusedConnector.count).toBe(0);
    await expect(alreadyClosed[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("uses immediate, isolated, independently idempotent status subscriptions", () => {
    const connector = testConnector();
    const stream = createStashEventStream(connector);
    const listener = vi.fn();
    const unsubscribe = stream.onStatus(listener);
    const throwingUnsubscribe = stream.onStatus(() => {
      throw new Error("not the stream's failure");
    });
    expect(listener).toHaveBeenCalledWith("connecting");
    unsubscribe();
    unsubscribe();
    throwingUnsubscribe();
    stream.close();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects an invalid starting checkpoint synchronously", () => {
    const connector = testConnector();
    expect(() => createStashEventStream(connector, { since: -1 })).toThrow(
      new TypeError("events since must be a non-negative safe integer"),
    );
    expect(connector.count).toBe(0);
  });
});
