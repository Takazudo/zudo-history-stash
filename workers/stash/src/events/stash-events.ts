import { StashEventSchema, type StashEvent } from "@takazudo/zudo-history-stash-core";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export const STASH_EVENTS_PUBLISH_PATH = "/publish";
export const STASH_EVENTS_SUBSCRIBE_PATH = "/subscribe";
export const STASH_EVENTS_MAX_STREAM_MS_HEADER = "X-Stash-Events-Max-Stream-Ms";
export const STASH_EVENTS_INSPECT = Symbol("StashEvents.inspect");

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_SUBSCRIBERS = 256;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const encoder = new TextEncoder();
const HEARTBEAT_FRAME = encoder.encode(": ping\n\n");
const LIFETIME_FRAME = encodeEvent({ type: "reconnect", reason: "lifetime" });
const SHUTDOWN_FRAME = encodeEvent({ type: "reconnect", reason: "shutdown" });

interface QueueEntry {
  bytes: Uint8Array;
  terminal: boolean;
}

function encodeEvent(event: StashEvent): Uint8Array {
  const id = event.type === "change" ? `id: ${event.changeId}\n` : "";
  return encoder.encode(`event: ${event.type}\n${id}data: ${JSON.stringify(event)}\n\n`);
}

function errorResponse(status: number, message: string, allow?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (allow !== undefined) headers.set("Allow", allow);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export function parseStashEventsLifetimeMs(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_TIMER_DELAY_MS
    ? milliseconds
    : null;
}

class Subscriber {
  private readonly queue: QueueEntry[] = [];
  private queuedBytes = 0;
  private deliveredBytes = 0;
  private accepting = true;
  private controllerAvailable = true;
  private detached = false;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onAbort = (): void => this.closeImmediately();

  constructor(
    readonly id: number,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly signal: AbortSignal,
    private readonly remove: (subscriber: Subscriber) => void,
  ) {}

  start(lifetimeMs: number): void {
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    this.lifetimeTimer = setTimeout(() => this.finishWith(LIFETIME_FRAME), lifetimeMs);
    if (this.signal.aborted) this.closeImmediately();
  }

  offer(bytes: Uint8Array): void {
    if (!this.accepting || !this.controllerAvailable) return;
    if (this.deliveredBytes + this.queuedBytes + bytes.byteLength > MAX_BUFFERED_BYTES) {
      this.closeImmediately();
      return;
    }
    this.queue.push({ bytes, terminal: false });
    this.queuedBytes += bytes.byteLength;
    this.drainOne();
  }

  pull(): void {
    if (!this.controllerAvailable) return;
    this.deliveredBytes = 0;
    this.drainOne();
  }

  cancel(): void {
    if (!this.controllerAvailable) return;
    this.accepting = false;
    this.controllerAvailable = false;
    this.detach();
    this.discardAllBuffers();
  }

  private finishWith(bytes: Uint8Array): void {
    if (!this.accepting || !this.controllerAvailable) return;
    this.accepting = false;
    this.detach();

    if (this.deliveredBytes + this.queuedBytes + bytes.byteLength > MAX_BUFFERED_BYTES) {
      this.clearPendingQueue();
    }
    if (this.deliveredBytes + bytes.byteLength > MAX_BUFFERED_BYTES) {
      this.closeImmediately();
      return;
    }

    this.queue.push({ bytes, terminal: true });
    this.queuedBytes += bytes.byteLength;
    // The queue is already byte-bounded, so terminal rotation can flush and close synchronously.
    while (this.controllerAvailable && this.queue.length > 0) this.drainOne(true);
  }

  private drainOne(ignoreBackpressure = false): void {
    if (!this.controllerAvailable) return;
    const desiredSize = this.controller.desiredSize;
    if (desiredSize === null) {
      this.cancel();
      return;
    }
    if (!ignoreBackpressure && desiredSize <= 0) return;

    const entry = this.queue.shift();
    if (entry === undefined) return;
    this.queuedBytes -= entry.bytes.byteLength;
    try {
      this.controller.enqueue(entry.bytes);
    } catch {
      this.cancel();
      return;
    }
    this.deliveredBytes += entry.bytes.byteLength;

    if (entry.terminal) {
      this.controllerAvailable = false;
      this.discardAllBuffers();
      try {
        this.controller.close();
      } catch {
        // A simultaneous consumer cancellation already closed the controller.
      }
    }
  }

  private closeImmediately(): void {
    if (!this.controllerAvailable) return;
    this.accepting = false;
    this.controllerAvailable = false;
    this.detach();
    this.discardAllBuffers();
    try {
      this.controller.close();
    } catch {
      // A simultaneous consumer cancellation already closed the controller.
    }
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    if (this.lifetimeTimer !== null) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
    this.signal.removeEventListener("abort", this.onAbort);
    this.remove(this);
  }

  private clearPendingQueue(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private discardAllBuffers(): void {
    this.clearPendingQueue();
    this.deliveredBytes = 0;
  }
}

export class StashEvents extends DurableObject<Env> {
  private readonly subscribers = new Map<number, Subscriber>();
  private nextSubscriberId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  [STASH_EVENTS_INSPECT](): { activeSubscriberCount: number; heartbeatActive: boolean } {
    return {
      activeSubscriberCount: this.subscribers.size,
      heartbeatActive: this.heartbeatTimer !== null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === STASH_EVENTS_PUBLISH_PATH) {
      if (request.method !== "POST") return errorResponse(405, "Method not allowed.", "POST");
      return this.publish(request);
    }
    if (path === STASH_EVENTS_SUBSCRIBE_PATH) {
      if (request.method !== "GET") return errorResponse(405, "Method not allowed.", "GET");
      return this.subscribe(request);
    }
    return errorResponse(404, "Not found.");
  }

  private async publish(request: Request): Promise<Response> {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return errorResponse(400, "Invalid event.");
    }
    const events = StashEventSchema.array().min(1).safeParse(value);
    if (!events.success) return errorResponse(400, "Invalid event batch.");

    for (const event of events.data) {
      const frame = encodeEvent(event);
      for (const subscriber of this.subscribers.values()) subscriber.offer(frame);
    }
    return new Response(null, { status: 204 });
  }

  private subscribe(request: Request): Response {
    const lifetimeMs = parseStashEventsLifetimeMs(
      request.headers.get(STASH_EVENTS_MAX_STREAM_MS_HEADER) ?? this.env.STASH_EVENTS_MAX_STREAM_MS,
    );
    if (lifetimeMs === null) return errorResponse(400, "Invalid stream lifetime.");

    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      return this.streamResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(SHUTDOWN_FRAME);
            controller.close();
          },
        }),
      );
    }

    let subscriber: Subscriber;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = new Subscriber(
          this.nextSubscriberId++,
          controller,
          request.signal,
          (removed) => this.removeSubscriber(removed),
        );
        this.subscribers.set(subscriber.id, subscriber);
        if (this.subscribers.size === 1) this.startHeartbeat();
        subscriber.start(lifetimeMs);
      },
      pull: () => subscriber.pull(),
      cancel: () => subscriber.cancel(),
    });
    return this.streamResponse(stream);
  }

  private streamResponse(stream: ReadableStream<Uint8Array>): Response {
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      for (const subscriber of this.subscribers.values()) subscriber.offer(HEARTBEAT_FRAME);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private removeSubscriber(subscriber: Subscriber): void {
    if (this.subscribers.get(subscriber.id) !== subscriber) return;
    this.subscribers.delete(subscriber.id);
    if (this.subscribers.size === 0 && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
