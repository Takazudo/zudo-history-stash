import type { StashEvent } from "@takazudo/zudo-history-stash-core";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  STASH_EVENTS_INSPECT,
  STASH_EVENTS_MAX_STREAM_MS_HEADER,
  STASH_EVENTS_PUBLISH_PATH,
  STASH_EVENTS_SUBSCRIBE_PATH,
  type StashEvents,
} from "../../src/events/stash-events.js";

const INTERNAL_ORIGIN = "https://stash-events.internal";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function eventFrame(event: StashEvent): string {
  const id = event.type === "change" ? `id: ${event.changeId}\n` : "";
  return `event: ${event.type}\n${id}data: ${JSON.stringify(event)}\n\n`;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, init);
}

async function subscribe(
  instance: StashEvents,
  options: { lifetimeMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.lifetimeMs !== undefined) {
    headers.set(STASH_EVENTS_MAX_STREAM_MS_HEADER, String(options.lifetimeMs));
  }
  return instance.fetch(request(STASH_EVENTS_SUBSCRIBE_PATH, { headers, signal: options.signal }));
}

function readerFor(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  return response.body!.getReader();
}

async function publish(instance: StashEvents, event: StashEvent): Promise<Response> {
  return instance.fetch(
    request(STASH_EVENTS_PUBLISH_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([event]),
    }),
  );
}

async function readText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ text: string; done: boolean }> {
  const result = await reader.read();
  return {
    text: result.value === undefined ? "" : decoder.decode(result.value),
    done: result.done,
  };
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The producer may already have closed the stream during the assertion.
  }
}

function stub() {
  return env.STASH_EVENTS.getByName(crypto.randomUUID());
}

function inspect(instance: StashEvents) {
  return instance[STASH_EVENTS_INSPECT]();
}

describe("StashEvents Durable Object", () => {
  it("publishes one encoded frame to every subscriber without an initial ready event", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents, state) => {
      const first = readerFor(await subscribe(instance));
      const second = readerFor(await subscribe(instance));
      const event: StashEvent = {
        type: "change",
        changeId: 41,
        commitId: "cmt_test_41",
        stash: "docs",
        path: "guide.json",
        version: 3,
        kind: "put",
        origin: "viewer-a",
        createdAt: "2026-08-28T00:00:00.000Z",
      };
      try {
        const firstRead = first.read();
        const secondRead = second.read();
        expect((await publish(instance, event)).status).toBe(204);

        const [firstChunk, secondChunk] = await Promise.all([firstRead, secondRead]);
        expect(decoder.decode(firstChunk.value)).toBe(eventFrame(event));
        expect(decoder.decode(secondChunk.value)).toBe(eventFrame(event));
        expect(inspect(instance).activeSubscriberCount).toBe(2);
        expect(await state.storage.list()).toEqual(new Map());
      } finally {
        await Promise.all([cancelReader(first), cancelReader(second)]);
      }
      expect(inspect(instance).activeSubscriberCount).toBe(0);
      expect(inspect(instance).heartbeatActive).toBe(false);
    });
  });

  it("validates and publishes an ordered event array while commit frames remain live-only", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      const reader = readerFor(await subscribe(instance));
      const change: StashEvent = {
        type: "change",
        changeId: 50,
        commitId: "cmt_batch",
        stash: "docs",
        path: "one.txt",
        version: 1,
        kind: "put",
        origin: null,
        createdAt: "2026-08-28T00:00:00.000Z",
      };
      const commit: StashEvent = {
        type: "commit",
        commitId: "cmt_batch",
        stash: "docs",
        entryCount: 1,
        firstChangeId: 50,
        lastChangeId: 50,
        origin: null,
      };
      try {
        const response = await instance.fetch(
          request(STASH_EVENTS_PUBLISH_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([change, commit]),
          }),
        );
        expect(response.status).toBe(204);
        expect(await readText(reader)).toEqual({ text: eventFrame(change), done: false });
        expect(await readText(reader)).toEqual({ text: eventFrame(commit), done: false });
        expect(eventFrame(change)).toContain("id: 50\n");
        expect(eventFrame(commit)).not.toContain("id:");
      } finally {
        await cancelReader(reader);
      }
    });
  });

  it("drops only an unread subscriber when its queued bytes exceed 256 KiB", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      const slow = readerFor(await subscribe(instance));
      const fast = readerFor(await subscribe(instance));
      const event: StashEvent = {
        type: "change",
        changeId: 42,
        commitId: "cmt_test_42",
        stash: "docs",
        path: "x".repeat(70_000),
        version: 1,
        kind: "put",
        origin: null,
        createdAt: "2026-08-28T00:00:00.000Z",
      };
      expect(encoder.encode(eventFrame(event)).byteLength * 4).toBeGreaterThan(256 * 1024);

      try {
        for (let index = 0; index < 4; index += 1) {
          const fastRead = fast.read();
          expect((await publish(instance, event)).status).toBe(204);
          expect(decoder.decode((await fastRead).value)).toBe(eventFrame(event));
        }
        expect(inspect(instance).activeSubscriberCount).toBe(1);

        while (!(await slow.read()).done) {
          // Drain any controller-held chunk left before overflow closed the stream.
        }
      } finally {
        await Promise.all([cancelReader(slow), cancelReader(fast)]);
      }
    });
  });

  it("uses one 25-second heartbeat interval and stops it with the last subscriber", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      let first: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let second: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        first = readerFor(await subscribe(instance, { lifetimeMs: 60_000 }));
        second = readerFor(await subscribe(instance, { lifetimeMs: 60_000 }));
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        const firstRead = first.read();
        const secondRead = second.read();
        await vi.advanceTimersByTimeAsync(25_000);
        expect(await readTextFrom(firstRead)).toBe(": ping\n\n");
        expect(await readTextFrom(secondRead)).toBe(": ping\n\n");

        await cancelReader(first);
        expect(inspect(instance).heartbeatActive).toBe(true);
        await cancelReader(second);
        expect(inspect(instance).heartbeatActive).toBe(false);
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        if (first !== undefined) await cancelReader(first);
        if (second !== undefined) await cancelReader(second);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("emits a lifetime reconnect frame and then closes", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      vi.useFakeTimers();
      const reader = readerFor(await subscribe(instance, { lifetimeMs: 50 }));
      const event: StashEvent = { type: "reconnect", reason: "shutdown" };
      try {
        expect((await publish(instance, event)).status).toBe(204);
        await vi.advanceTimersByTimeAsync(50);
        expect(await readText(reader)).toEqual({ text: eventFrame(event), done: false });
        expect(await readText(reader)).toEqual({
          text: eventFrame({ type: "reconnect", reason: "lifetime" }),
          done: false,
        });
        expect(await readText(reader)).toEqual({ text: "", done: true });
        expect(inspect(instance).activeSubscriberCount).toBe(0);
        expect(inspect(instance).heartbeatActive).toBe(false);
      } finally {
        await cancelReader(reader);
        vi.useRealTimers();
      }
    });
  });

  it("emits the lifetime frame directly when a reader is already waiting", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      vi.useFakeTimers();
      const reader = readerFor(await subscribe(instance, { lifetimeMs: 50 }));
      try {
        const reconnect = reader.read();
        await vi.advanceTimersByTimeAsync(50);
        expect(await readTextFrom(reconnect)).toBe(
          eventFrame({ type: "reconnect", reason: "lifetime" }),
        );
        expect(await readText(reader)).toEqual({ text: "", done: true });
        expect(inspect(instance).activeSubscriberCount).toBe(0);
        expect(inspect(instance).heartbeatActive).toBe(false);
      } finally {
        await cancelReader(reader);
        vi.useRealTimers();
      }
    });
  });

  it("does not undercount a controller-held near-cap frame when lifetime fires", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      vi.useFakeTimers();
      const lifetimeFrameBytes = encoder.encode(
        eventFrame({ type: "reconnect", reason: "lifetime" }),
      ).byteLength;
      const baseEvent: StashEvent = {
        type: "change",
        changeId: 42,
        commitId: "cmt_test_42",
        stash: "docs",
        path: "",
        version: 1,
        kind: "put",
        origin: null,
        createdAt: "2026-08-28T00:00:00.000Z",
      };
      const baseBytes = encoder.encode(eventFrame(baseEvent)).byteLength;
      const targetBytes = 256 * 1024 - lifetimeFrameBytes + 1;
      const event = {
        ...baseEvent,
        path: "x".repeat(targetBytes - baseBytes),
      } satisfies StashEvent;
      expect(encoder.encode(eventFrame(event)).byteLength).toBe(targetBytes);

      const reader = readerFor(await subscribe(instance, { lifetimeMs: 50 }));
      try {
        expect((await publish(instance, event)).status).toBe(204);
        await vi.advanceTimersByTimeAsync(50);
        expect(await readText(reader)).toEqual({ text: eventFrame(event), done: false });
        expect(await readText(reader)).toEqual({ text: "", done: true });
      } finally {
        await cancelReader(reader);
        vi.useRealTimers();
      }
    });
  });

  it("returns shutdown to the 257th subscriber without registering it", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      const accepted: Response[] = [];
      let rejectedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        for (let index = 0; index < 256; index += 1) accepted.push(await subscribe(instance));
        expect(inspect(instance).activeSubscriberCount).toBe(256);

        rejectedReader = readerFor(await subscribe(instance));
        expect(await readText(rejectedReader)).toEqual({
          text: eventFrame({ type: "reconnect", reason: "shutdown" }),
          done: false,
        });
        expect(await readText(rejectedReader)).toEqual({ text: "", done: true });
        expect(inspect(instance).activeSubscriberCount).toBe(256);
      } finally {
        if (rejectedReader !== undefined) await cancelReader(rejectedReader);
        await Promise.all(accepted.map(async (response) => response.body?.cancel()));
      }
      expect(inspect(instance).activeSubscriberCount).toBe(0);
      expect(inspect(instance).heartbeatActive).toBe(false);
    });
  });

  it("cleans up independently on body cancellation and request abort", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      const cancelled = readerFor(await subscribe(instance));
      const abortController = new AbortController();
      const aborted = readerFor(await subscribe(instance, { signal: abortController.signal }));
      try {
        expect(inspect(instance).activeSubscriberCount).toBe(2);
        await cancelReader(cancelled);
        expect(inspect(instance).activeSubscriberCount).toBe(1);

        abortController.abort();
        await Promise.resolve();
        expect(inspect(instance).activeSubscriberCount).toBe(0);
        expect(await readText(aborted)).toEqual({ text: "", done: true });

        abortController.abort();
        await cancelReader(aborted);
        expect(inspect(instance).activeSubscriberCount).toBe(0);
      } finally {
        await Promise.all([cancelReader(cancelled), cancelReader(aborted)]);
      }
    });
  });

  it("rejects malformed publishes and unknown endpoints without disturbing subscribers", async () => {
    await runInDurableObject(stub(), async (instance: StashEvents) => {
      const reader = readerFor(await subscribe(instance));
      const event: StashEvent = { type: "reconnect", reason: "shutdown" };
      try {
        const malformed = await instance.fetch(
          request(STASH_EVENTS_PUBLISH_PATH, { method: "POST", body: "{" }),
        );
        expect(malformed.status).toBe(400);
        const singleton = await instance.fetch(
          request(STASH_EVENTS_PUBLISH_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
          }),
        );
        expect(singleton.status).toBe(400);
        expect((await instance.fetch(request("/unknown"))).status).toBe(404);
        expect(inspect(instance).activeSubscriberCount).toBe(1);

        const pending = reader.read();
        expect((await publish(instance, event)).status).toBe(204);
        expect(await readTextFrom(pending)).toBe(eventFrame(event));
      } finally {
        await cancelReader(reader);
      }
    });
  });
});

async function readTextFrom(
  result: Promise<ReadableStreamReadResult<Uint8Array>>,
): Promise<string> {
  const chunk = await result;
  expect(chunk.done).toBe(false);
  return chunk.value === undefined ? "" : decoder.decode(chunk.value);
}
