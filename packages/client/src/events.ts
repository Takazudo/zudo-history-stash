import type { ErrorCode, LiveStatus, StashEvent } from "@takazudo/zudo-history-stash-core";
import { StashHttpError } from "./parse.js";
import { parseStashEventStream } from "./sse.js";

const DEDUPE_LIMIT = 1_000;
const EVENT_QUEUE_CAPACITY = 1;
const MAX_ERROR_BODY_BYTES = 64 * 1_024;
const MAX_NETWORK_DELAY_MS = 30_000;
const MAX_ROTATION_JITTER_MS = 250;

/** Options for one advisory live-event stream. */
export interface EventsOptions {
  since?: number;
  signal?: AbortSignal;
}

/** The client-bound form of the dependency-neutral Core lifecycle type. */
export type StashLiveStatus = LiveStatus<StashHttpError>;

/** An async event stream with an independently observable lifecycle channel. */
export interface StashEventStream extends AsyncIterable<StashEvent> {
  readonly status: StashLiveStatus;
  /** Consecutive retryable failures since the last validated `ready` event. */
  readonly failureCount: number;
  /** Subscribes and immediately invokes the callback with the current lifecycle state. */
  onStatus(callback: (status: StashLiveStatus) => void): () => void;
  close(): void;
}

/** Narrow fetch-only boundary used by the reconnect engine. */
export interface StashEventConnector {
  connect(since: number | undefined, signal: AbortSignal): Promise<Response>;
}

/** Injectable timing seams for deterministic reconnect tests. */
export interface StashEventStreamDependencies {
  random(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

type QueueWaiter<T> = (result: IteratorResult<T>) => void;
type QueueAdmission<T> = {
  value: T;
  settle(admitted: boolean): void;
};

/** @internal A fixed-capacity queue for the reconnect loop's single producer. */
export class BoundedAsyncQueue<T> {
  readonly #capacity: number;
  readonly #values: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #pendingAdmission: QueueAdmission<T> | undefined;
  #ended = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(value: T): Promise<boolean> {
    if (this.#ended) return Promise.resolve(false);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return Promise.resolve(true);
    }
    if (this.#values.length < this.#capacity) {
      this.#values.push(value);
      return Promise.resolve(true);
    }
    if (this.#pendingAdmission !== undefined) {
      throw new Error("stash event queue has more than one pending producer");
    }
    return new Promise((settle) => {
      this.#pendingAdmission = { value, settle };
    });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#values.length = 0;
    const pendingAdmission = this.#pendingAdmission;
    this.#pendingAdmission = undefined;
    pendingAdmission?.settle(false);
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    if (this.#values.length > 0) {
      const value = this.#values.shift()!;
      this.#admitPending();
      return Promise.resolve({ done: false, value });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #admitPending(): void {
    const pendingAdmission = this.#pendingAdmission;
    if (pendingAdmission === undefined || this.#ended) return;
    this.#pendingAdmission = undefined;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(pendingAdmission.value);
    else waiter({ done: false, value: pendingAdmission.value });
    pendingAdmission.settle(true);
  }
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const defaultDependencies: StashEventStreamDependencies = {
  random: Math.random,
  sleep: defaultSleep,
};

function normalizedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 0.999_999_999));
}

function rotationDelay(random: () => number): number {
  return Math.floor(normalizedRandom(random) * (MAX_ROTATION_JITTER_MS + 1));
}

function networkDelay(failureCount: number, random: () => number): number {
  const exponential = Math.min(
    MAX_NETWORK_DELAY_MS,
    1_000 * 2 ** Math.min(Math.max(failureCount - 1, 0), 5),
  );
  const jitter = Math.floor(exponential * 0.2 * normalizedRandom(random));
  return exponential - jitter;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // A response body can already be locked, closed, or errored.
  }
}

function isEventStream(response: Response): boolean {
  return (
    response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "text/event-stream"
  );
}

async function boundedErrorBody(response: Response): Promise<unknown> {
  const body = response.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorCode(body: unknown): ErrorCode | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? (code as ErrorCode) : undefined;
}

function terminalStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function validSince(since: number | undefined): boolean {
  return since === undefined || (Number.isSafeInteger(since) && since >= 0);
}

/** Creates the reconnecting implementation behind `client.files(stash).events()`. */
export function createStashEventStream(
  connector: StashEventConnector,
  options: EventsOptions = {},
  dependencies: Partial<StashEventStreamDependencies> = {},
): StashEventStream {
  if (!validSince(options.since)) {
    throw new TypeError("events since must be a non-negative safe integer");
  }

  const timing = { ...defaultDependencies, ...dependencies };
  const queue = new BoundedAsyncQueue<StashEvent>(EVENT_QUEUE_CAPACITY);
  const lifecycle = new AbortController();
  const listeners = new Set<(status: StashLiveStatus) => void>();
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  let checkpoint = options.since;
  let currentConnection: AbortController | undefined;
  let currentStatus: StashLiveStatus = "connecting";
  let consecutiveFailures = 0;
  let stopped = false;

  const notify = (nextStatus: StashLiveStatus, force = false) => {
    const changed = currentStatus !== nextStatus;
    currentStatus = nextStatus;
    if (!changed && !force) return;
    for (const listener of [...listeners]) {
      try {
        listener(currentStatus);
      } catch {
        // Status observers cannot alter the stream lifecycle.
      }
    }
  };

  const finalize = (status: StashLiveStatus) => {
    if (stopped) return;
    stopped = true;
    options.signal?.removeEventListener("abort", stop);
    queue.end();
    seenIds.clear();
    seenOrder.length = 0;
    const connection = currentConnection;
    currentConnection = undefined;
    connection?.abort();
    lifecycle.abort();
    notify(status);
    listeners.clear();
  };

  const stop = () => finalize("closed");

  const fail = (error: StashHttpError) => finalize({ failed: error });

  const rememberChange = (id: string): boolean => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > DEDUPE_LIMIT) {
      const expired = seenOrder.shift();
      if (expired !== undefined) seenIds.delete(expired);
    }
    return true;
  };

  const wait = async (milliseconds: number): Promise<boolean> => {
    try {
      await timing.sleep(milliseconds, lifecycle.signal);
      return !stopped;
    } catch {
      return false;
    }
  };

  const retry = async (): Promise<boolean> => {
    consecutiveFailures += 1;
    notify("reconnecting", true);
    return wait(networkDelay(consecutiveFailures, timing.random));
  };

  const run = async () => {
    while (!stopped) {
      const connection = new AbortController();
      currentConnection = connection;
      let response: Response;
      try {
        response = await connector.connect(checkpoint, connection.signal);
      } catch {
        if (stopped) return;
        currentConnection = undefined;
        if (!(await retry())) return;
        continue;
      }

      if (stopped) {
        await cancelBody(response.body);
        return;
      }

      if (terminalStatus(response.status)) {
        const body = await boundedErrorBody(response);
        if (stopped) return;
        fail(new StashHttpError(response.status, errorCode(body), body));
        return;
      }

      if (response.status !== 200 || response.body === null || !isEventStream(response)) {
        await cancelBody(response.body);
        currentConnection = undefined;
        if (!(await retry())) return;
        continue;
      }

      let ready = false;
      let retryableFailure = false;
      try {
        for await (const { event, id } of parseStashEventStream(response.body, connection.signal)) {
          if (stopped) return;
          if (event.type === "change") {
            if (!ready) checkpoint = event.changeId;
            if (id === undefined) throw new TypeError("validated change event is missing its id");
            if (rememberChange(id) && (!(await queue.push(event)) || stopped)) return;
          } else {
            if (event.type === "ready") {
              ready = true;
              checkpoint = event.checkpoint ?? undefined;
              consecutiveFailures = 0;
              notify("live");
            }
            if (!(await queue.push(event)) || stopped) return;
            if (event.type === "reconnect") break;
          }
        }
      } catch {
        if (!stopped) retryableFailure = true;
      } finally {
        connection.abort();
        currentConnection = undefined;
      }

      if (stopped) return;
      if (retryableFailure) {
        if (!(await retry())) return;
      } else {
        notify("reconnecting");
        if (!(await wait(rotationDelay(timing.random)))) return;
      }
    }
  };

  const stream: StashEventStream = {
    get status() {
      return currentStatus;
    },
    get failureCount() {
      return consecutiveFailures;
    },
    onStatus(callback) {
      let subscribed = !stopped;
      if (subscribed) listeners.add(callback);
      try {
        callback(currentStatus);
      } catch {
        // Match later notifications: a listener owns its own failures.
      }
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(callback);
      };
    },
    close: stop,
    [Symbol.asyncIterator]() {
      return {
        next: () => queue.next(),
        return: async () => {
          stop();
          return { done: true, value: undefined };
        },
      };
    },
  };

  if (options.signal?.aborted) stop();
  else {
    options.signal?.addEventListener("abort", stop, { once: true });
    void run().catch((cause: unknown) => {
      if (stopped) return;
      fail(new StashHttpError(0, undefined, undefined, cause));
    });
  }

  return stream;
}
