import type { StashEvent } from "@takazudo/zudo-history-stash-core";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, createApp } from "../../src/app.js";
import { createStashStore } from "../../src/d1/store.js";
import {
  STASH_EVENTS_INSPECT,
  STASH_EVENTS_PUBLISH_PATH,
  type StashEvents,
} from "../../src/events/stash-events.js";
import { prefixedLiveStream } from "../../src/events/subscribe.js";
import type { Env } from "../../src/env.js";
import { effectiveStashEventsLifetimeMs } from "../../src/routes/events.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const decoder = new TextDecoder();

interface ParsedFrame {
  id: string | null;
  event: StashEvent;
}

class EventReader {
  private buffered = "";

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(maxReads = 8): Promise<ParsedFrame> {
    for (let readCount = 0; readCount < maxReads; readCount += 1) {
      const parsed = this.takeFrame();
      if (parsed !== null) return parsed;
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("Event stream closed before the next frame.");
      this.buffered += decoder.decode(chunk.value, { stream: true });
    }
    throw new Error(`Event frame exceeded the ${maxReads}-read test bound.`);
  }

  async expectDone(maxReads = 2): Promise<void> {
    for (let readCount = 0; readCount < maxReads; readCount += 1) {
      if (this.takeFrame() !== null) throw new Error("Unexpected trailing event frame.");
      const chunk = await this.reader.read();
      if (chunk.done) return;
      this.buffered += decoder.decode(chunk.value, { stream: true });
    }
    throw new Error(`Event stream did not close within ${maxReads} reads.`);
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // The producer may already have closed while the assertion was running.
    }
  }

  private takeFrame(): ParsedFrame | null {
    for (;;) {
      const boundary = this.buffered.indexOf("\n\n");
      if (boundary === -1) return null;
      const raw = this.buffered.slice(0, boundary);
      this.buffered = this.buffered.slice(boundary + 2);
      if (raw.startsWith(":")) continue;

      const lines = raw.split("\n");
      const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null;
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (eventName === undefined || data === undefined) {
        throw new Error(`Malformed SSE frame: ${raw}`);
      }
      const event = JSON.parse(data) as StashEvent;
      if (event.type !== eventName) throw new Error("SSE event and data types differ.");
      return { id, event };
    }
  }
}

function eventReader(response: Response): EventReader {
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  return new EventReader(response.body!.getReader());
}

async function connect(
  stash: string,
  suffix = "",
  token = "test-admin",
  bindings: Env = createTestEnv().env,
  application = app,
): Promise<Response> {
  return request(
    application,
    `http://stash.test/v1/stashes/${stash}/events${suffix}`,
    { headers: bearer(token) },
    bindings,
  );
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

async function put(
  bindings: Env,
  stash: string,
  path: string,
  expectedVersion: number | null = null,
) {
  const result = await createStashStore(bindings, {
    now: () => Date.parse("2026-08-28T01:02:03.000Z"),
  }).writes.put(stash, path, { body: path, expectedVersion });
  if (!result.ok || "unchanged" in result.value) throw new Error("Fixture write failed.");
  return result.value;
}

async function publish(bindings: Env, stash: string, event: StashEvent): Promise<void> {
  const response = await bindings.STASH_EVENTS.getByName(stash).fetch(
    `https://events.internal${STASH_EVENTS_PUBLISH_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  expect(response.status).toBe(204);
}

async function subscriberCount(bindings: Env, stash: string): Promise<number> {
  return runInDurableObject(
    bindings.STASH_EVENTS.getByName(stash),
    async (instance: StashEvents) => instance[STASH_EVENTS_INSPECT]().activeSubscriberCount,
  );
}

function instrumentSubscriptionCancellation(
  bindings: Env,
  stash: string,
  options: { rejectCancel?: boolean } = {},
): {
  bindings: Env;
  canceled: Promise<void>;
  cancelCalls: () => number;
  capturedSignal: () => AbortSignal | undefined;
  lifetimeHeader: () => string | null;
  namespaceCalls: () => number;
  requestAborted: Promise<void>;
  signalAbortedAtCancel: () => readonly (boolean | undefined)[];
  subscribeCalls: () => number;
} {
  // The DO suite proves that its source cancel hook removes the subscriber. Current Miniflare
  // does not propagate cancellation across DurableObjectStub.fetch(), so this probe isolates the
  // route's responsibility: both terminal paths must cancel the upstream response body exactly once.
  let resolveCanceled: () => void = () => undefined;
  const canceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  let resolveRequestAborted: () => void = () => undefined;
  const requestAborted = new Promise<void>((resolve) => {
    resolveRequestAborted = resolve;
  });
  let cancelCalls = 0;
  let capturedSignal: AbortSignal | undefined;
  let namespaceCalls = 0;
  const signalAbortedAtCancel: (boolean | undefined)[] = [];
  let subscribeCalls = 0;
  let lifetimeHeader: string | null = null;
  const namespace = new Proxy(bindings.STASH_EVENTS, {
    get(target, property) {
      if (property === "getByName") {
        return (...args: Parameters<typeof target.getByName>) => {
          namespaceCalls += 1;
          const stub = target.getByName(...args);
          if (args[0] !== stash) return stub;
          return new Proxy(stub, {
            get(stubTarget, stubProperty) {
              if (stubProperty === "fetch") {
                return (...fetchArgs: Parameters<typeof stubTarget.fetch>) => {
                  const input = fetchArgs[0];
                  const url = new URL(input instanceof Request ? input.url : String(input));
                  if (url.pathname !== "/subscribe") return stubTarget.fetch(...fetchArgs);
                  subscribeCalls += 1;
                  const requestSignal = input instanceof Request ? input.signal : undefined;
                  capturedSignal = requestSignal;
                  if (requestSignal?.aborted === true) {
                    resolveRequestAborted();
                  } else {
                    requestSignal?.addEventListener("abort", resolveRequestAborted, { once: true });
                  }
                  lifetimeHeader =
                    input instanceof Request
                      ? input.headers.get("X-Stash-Events-Max-Stream-Ms")
                      : new Headers(fetchArgs[1]?.headers).get("X-Stash-Events-Max-Stream-Ms");
                  return Promise.resolve(
                    new Response(
                      new ReadableStream<Uint8Array>({
                        cancel() {
                          cancelCalls += 1;
                          signalAbortedAtCancel.push(requestSignal?.aborted);
                          resolveCanceled();
                          if (options.rejectCancel === true) {
                            return Promise.reject(new Error("fixture subscription cancel failed"));
                          }
                        },
                      }),
                      { headers: { "Content-Type": "text/event-stream" } },
                    ),
                  );
                };
              }
              const value: unknown = Reflect.get(stubTarget, stubProperty, stubTarget);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    bindings: { ...bindings, STASH_EVENTS: namespace },
    canceled,
    cancelCalls: () => cancelCalls,
    capturedSignal: () => capturedSignal,
    lifetimeHeader: () => lifetimeHeader,
    namespaceCalls: () => namespaceCalls,
    requestAborted,
    signalAbortedAtCancel: () => signalAbortedAtCancel,
    subscribeCalls: () => subscribeCalls,
  };
}

function instrumentSubscriptionRejection(
  bindings: Env,
  stash: string,
): {
  bindings: Env;
  capturedSignal: () => AbortSignal | undefined;
  subscribeCalls: () => number;
} {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const namespace = new Proxy(bindings.STASH_EVENTS, {
    get(target, property) {
      if (property === "getByName") {
        return (...args: Parameters<typeof target.getByName>) => {
          const stub = target.getByName(...args);
          if (args[0] !== stash) return stub;
          return new Proxy(stub, {
            get(stubTarget, stubProperty) {
              if (stubProperty === "fetch") {
                return (...fetchArgs: Parameters<typeof stubTarget.fetch>) => {
                  const input = fetchArgs[0];
                  const url = new URL(input instanceof Request ? input.url : String(input));
                  if (url.pathname !== "/subscribe") return stubTarget.fetch(...fetchArgs);
                  calls += 1;
                  signal = input instanceof Request ? input.signal : undefined;
                  return Promise.reject(new Error("subscription dispatch failed"));
                };
              }
              const value: unknown = Reflect.get(stubTarget, stubProperty, stubTarget);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    bindings: { ...bindings, STASH_EVENTS: namespace },
    capturedSignal: () => signal,
    subscribeCalls: () => calls,
  };
}

function instrumentDelayedSubscription(
  bindings: Env,
  stash: string,
): {
  bindings: Env;
  canceled: Promise<void>;
  cancelCalls: () => number;
  capturedSignal: () => AbortSignal | undefined;
  dispatched: Promise<void>;
  release: () => void;
} {
  let resolveDispatched: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  let resolveResponse: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  let resolveCanceled: () => void = () => undefined;
  const canceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  let signal: AbortSignal | undefined;
  let cancelCalls = 0;
  let released = false;
  const namespace = new Proxy(bindings.STASH_EVENTS, {
    get(target, property) {
      if (property === "getByName") {
        return (...args: Parameters<typeof target.getByName>) => {
          const stub = target.getByName(...args);
          if (args[0] !== stash) return stub;
          return new Proxy(stub, {
            get(stubTarget, stubProperty) {
              if (stubProperty === "fetch") {
                return (...fetchArgs: Parameters<typeof stubTarget.fetch>) => {
                  const input = fetchArgs[0];
                  const url = new URL(input instanceof Request ? input.url : String(input));
                  if (url.pathname !== "/subscribe") return stubTarget.fetch(...fetchArgs);
                  signal = input instanceof Request ? input.signal : undefined;
                  resolveDispatched();
                  return response;
                };
              }
              const value: unknown = Reflect.get(stubTarget, stubProperty, stubTarget);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    bindings: { ...bindings, STASH_EVENTS: namespace },
    canceled,
    cancelCalls: () => cancelCalls,
    capturedSignal: () => signal,
    dispatched,
    release() {
      if (released) return;
      released = true;
      resolveResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls += 1;
              resolveCanceled();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    },
  };
}

function rejectingChangesDatabase(db: D1Database): D1Database {
  function wrapStatement(statement: D1PreparedStatement, reject: boolean): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            wrapStatement(target.bind(...values), reject);
        }
        if (property === "all" && reject) {
          return () => Promise.reject(new Error("fixture change read failed"));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return new Proxy(db, {
    get(target, property) {
      if (property === "withSession") {
        return (constraint?: string) => {
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty === "prepare") {
                return (sql: string) =>
                  wrapStatement(sessionTarget.prepare(sql), /\bchange_id\b/iu.test(sql));
              }
              const value: unknown = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function delayedAscendingSnapshot(db: D1Database): {
  db: D1Database;
  snapshotTaken: Promise<void>;
  release: () => void;
} {
  let markSnapshotTaken: () => void = () => undefined;
  let releaseSnapshot: () => void = () => undefined;
  const snapshotTaken = new Promise<void>((resolve) => {
    markSnapshotTaken = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let delayed = false;

  function wrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            wrapStatement(target.bind(...values));
        }
        if (property === "all") {
          return async <T = unknown>(): Promise<D1Result<T>> => {
            const result = await target.all<T>();
            if (!delayed) {
              delayed = true;
              markSnapshotTaken();
              await released;
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function wrapSession(session: D1DatabaseSession): D1DatabaseSession {
    return new Proxy(session, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return /\bv\.id\s*>\s*\?/i.test(sql) ? wrapStatement(statement) : statement;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return {
    db: new Proxy(db, {
      get(target, property) {
        if (property === "withSession") {
          return (constraint?: string) => wrapSession(target.withSession(constraint));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    snapshotTaken,
    release: releaseSnapshot,
  };
}

async function seedChanges(bindings: Env, stash: string, count: number): Promise<void> {
  for (let offset = 0; offset < count; offset += 50) {
    const statements: D1PreparedStatement[] = [];
    for (const index of Array.from({ length: Math.min(50, count - offset) }, (_, i) => i)) {
      const change = offset + index + 1;
      const commitId = `cmt_events_${change}`;
      statements.push(
        bindings.DB.prepare(
          `INSERT INTO commits (id, stash_name, source, entry_count, created_by, created_at)
           VALUES (?, ?, 'put', 1, 'test-fixture', ?)`,
        ).bind(commitId, stash, change),
        bindings.DB.prepare(
          `INSERT INTO versions
           (stash_name, path, version, kind, blob_hash, size_bytes, author, message, created_at, commit_id)
         VALUES (?, ?, 1, 'put', ?, 1, '', '', ?, ?)`,
        ).bind(stash, `bulk/${change}.txt`, `hash-${change}`, change, commitId),
      );
    }
    await bindings.DB.batch(statements);
  }
}

describe("prefixed live stream", () => {
  it("releases each consumed replay frame before continuing with the live reader", async () => {
    const firstReplay = new Uint8Array([1]);
    const secondReplay = new Uint8Array([2]);
    const thirdReplay = new Uint8Array([3]);
    const prefix = [firstReplay, secondReplay, thirdReplay];
    let liveController!: ReadableStreamDefaultController<Uint8Array>;
    const liveSource = new ReadableStream<Uint8Array>({
      start(controller) {
        liveController = controller;
      },
    });
    const liveReader = liveSource.getReader();
    let liveClosed = false;
    let closeCalls = 0;
    const stream = prefixedLiveStream(
      prefix,
      {
        reader: liveReader,
        async close(reason) {
          if (liveClosed) return;
          liveClosed = true;
          closeCalls += 1;
          await liveReader.cancel(reason);
        },
      },
      liveReader.read(),
    );
    const reader = stream.getReader();

    try {
      await expect(reader.read()).resolves.toEqual({ done: false, value: firstReplay });
      expect(prefix).not.toContain(firstReplay);
      await expect(reader.read()).resolves.toEqual({ done: false, value: secondReplay });
      await expect(reader.read()).resolves.toEqual({ done: false, value: thirdReplay });
      expect(prefix).toHaveLength(0);

      const liveFrame = new Uint8Array([4]);
      liveController.enqueue(liveFrame);
      await expect(reader.read()).resolves.toEqual({ done: false, value: liveFrame });
      expect(closeCalls).toBe(0);
    } finally {
      await reader.cancel();
    }
    expect(closeCalls).toBe(1);
  });

  it("releases unconsumed replay frames when downstream cancellation wins", async () => {
    const prefix = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const liveReader = new ReadableStream<Uint8Array>().getReader();
    let closeCalls = 0;
    const stream = prefixedLiveStream(
      prefix,
      {
        reader: liveReader,
        async close(reason) {
          closeCalls += 1;
          await liveReader.cancel(reason);
        },
      },
      liveReader.read(),
    );

    await stream.cancel("downstream closed");

    expect(prefix).toHaveLength(0);
    expect(closeCalls).toBe(1);
  });
});

beforeEach(resetDatabase);

describe("stash events route", () => {
  it("uses the configured maximum for admin and non-expiring principals", () => {
    const now = Date.parse("2026-08-28T01:00:00.000Z");
    expect(effectiveStashEventsLifetimeMs("300000", { kind: "admin" }, now)).toBe(300_000);
    expect(
      effectiveStashEventsLifetimeMs(
        "300000",
        {
          kind: "stash",
          stash: "events-lifetime",
          tokenId: "tok_non_expiring",
          scope: "read",
          expiresAt: null,
        },
        now,
      ),
    ).toBe(300_000);
  });

  it("fails closed while resolving the exact principal and configuration lifetime fence", () => {
    const now = Date.parse("2026-08-28T01:00:00.000Z");
    const expiring = (expiresAt: string) => ({
      kind: "stash" as const,
      stash: "events-lifetime",
      tokenId: "tok_expiring",
      scope: "read" as const,
      expiresAt,
    });

    expect(
      effectiveStashEventsLifetimeMs("500", expiring(new Date(now + 250).toISOString()), now),
    ).toBe(250);
    expect(
      effectiveStashEventsLifetimeMs("500", expiring(new Date(now + 1_000).toISOString()), now),
    ).toBe(500);

    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => effectiveStashEventsLifetimeMs("500", { kind: "admin" }, invalidNow)).toThrow(
        "event stream lifetime is invalid",
      );
    }
    expect(() => effectiveStashEventsLifetimeMs("500", expiring("not-a-date"), now)).toThrow(
      "event stream lifetime is invalid",
    );
    expect(() =>
      effectiveStashEventsLifetimeMs("500", expiring(new Date(now).toISOString()), now),
    ).toThrow("valid bearer token");
    expect(() =>
      effectiveStashEventsLifetimeMs("500", expiring(new Date(now - 1).toISOString()), now),
    ).toThrow("valid bearer token");
  });

  it.each(["0", "+1", "-1", " 1", "1 ", "1.5", "9007199254740992", "2147483648"])(
    "rejects invalid configured lifetime %j before Durable Object dispatch",
    async (configured) => {
      const stash = `events-invalid-lifetime-${configured.replaceAll(/\W/gu, "x")}`;
      await seedStash(stash);
      const baseBindings = createTestEnv().env;
      const probe = instrumentSubscriptionCancellation(baseBindings, stash);
      const bindings = { ...probe.bindings, STASH_EVENTS_MAX_STREAM_MS: configured };

      const response = await connect(stash, "", "test-admin", bindings);

      await expectError(response, 500, "internal");
      expect(probe.namespaceCalls()).toBe(0);
      expect(probe.subscribeCalls()).toBe(0);
      expect(probe.cancelCalls()).toBe(0);
      expect(await subscriberCount(baseBindings, stash)).toBe(0);
    },
  );

  it("forwards the exact expiring-principal effective lifetime to Durable Object dispatch", async () => {
    const stash = "events-forwarded-effective-lifetime";
    const now = Date.parse("2026-08-28T01:00:00.000Z");
    await seedStash(stash);
    const token = await mintToken(stash, "read", { expiresAt: now + 250 });
    const baseBindings = createTestEnv().env;
    const probe = instrumentSubscriptionCancellation(baseBindings, stash);
    const bindings = { ...probe.bindings, STASH_EVENTS_MAX_STREAM_MS: "500" };
    const application = createApp({ now: () => now });
    const reader = eventReader(await connect(stash, "", token.token, bindings, application));
    try {
      expect((await reader.next()).event).toEqual({ type: "ready", head: null, checkpoint: null });
      expect(probe.subscribeCalls()).toBe(1);
      expect(probe.lifetimeHeader()).toBe("250");
    } finally {
      await reader.close();
    }
    await probe.canceled;
    expect(probe.cancelCalls()).toBe(1);
  });

  it("rotates a revoked non-expiring principal at the configured lifetime and denies reconnect", async () => {
    const stash = "events-revoked-rotation";
    const now = Date.parse("2026-08-28T01:00:00.000Z");
    await seedStash(stash);
    const token = await mintToken(stash, "read");
    const baseBindings = createTestEnv().env;
    const bindings = { ...baseBindings, STASH_EVENTS_MAX_STREAM_MS: "500" };
    const application = createApp({ now: () => now });
    let reader: EventReader | undefined;
    try {
      reader = eventReader(await connect(stash, "", token.token, bindings, application));
      expect((await reader.next()).event).toEqual({ type: "ready", head: null, checkpoint: null });
      expect(await subscriberCount(baseBindings, stash)).toBe(1);

      await baseBindings.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
        .bind(now, token.id)
        .run();
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      await expect.poll(() => subscriberCount(baseBindings, stash)).toBe(0);
      await publish(baseBindings, stash, {
        type: "change-set",
        changeSetId: "cst_1756339200000deadbeef",
        stash,
        paths: ["after-revocation.txt"],
        status: "open",
        origin: "peer-after-revocation",
      });
      await reader.expectDone();

      const denied = await connect(stash, "", token.token, bindings, application);
      await expectError(denied, 401, "unauthorized");
      expect(await subscriberCount(baseBindings, stash)).toBe(0);
    } finally {
      await reader?.close();
    }
  });

  it("caps rotation at token expiry, removes the subscriber, and denies reconnect", async () => {
    const stash = "events-expiry-rotation";
    let clock = Date.parse("2026-08-28T02:00:00.000Z");
    const expiresAt = clock + 250;
    await seedStash(stash);
    const token = await mintToken(stash, "read", { expiresAt });
    const baseBindings = createTestEnv().env;
    const bindings = { ...baseBindings, STASH_EVENTS_MAX_STREAM_MS: "500" };
    const application = createApp({ now: () => clock });
    let reader: EventReader | undefined;
    try {
      reader = eventReader(await connect(stash, "", token.token, bindings, application));
      expect((await reader.next()).event).toEqual({ type: "ready", head: null, checkpoint: null });
      expect(await subscriberCount(baseBindings, stash)).toBe(1);

      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      await expect.poll(() => subscriberCount(baseBindings, stash)).toBe(0);

      clock = expiresAt;
      const denied = await connect(stash, "", token.token, bindings, application);
      await expectError(denied, 401, "unauthorized");
      expect(await subscriberCount(baseBindings, stash)).toBe(0);
    } finally {
      await reader?.close();
    }
  });

  it("drops an unread replay prefix at expiry before emitting one lifetime terminal", async () => {
    const stash = "events-expiry-slow-replay";
    let clock = Date.parse("2026-08-28T02:30:00.000Z");
    const lifetimeMs = 250;
    const expiresAt = clock + lifetimeMs;
    await seedStash(stash);
    const token = await mintToken(stash, "read", { expiresAt });
    const bindings = { ...createTestEnv().env, STASH_EVENTS_MAX_STREAM_MS: "1000" };
    const changes = [
      await put(bindings, stash, "one.txt"),
      await put(bindings, stash, "two.txt"),
      await put(bindings, stash, "three.txt"),
      await put(bindings, stash, "four.txt"),
    ];
    const application = createApp({ now: () => clock });
    const reader = eventReader(
      await connect(stash, "?since=0", token.token, bindings, application),
    );
    try {
      expect(await reader.next()).toEqual({
        id: String(changes[0]!.changeId),
        event: expect.objectContaining({ type: "change", path: "one.txt" }),
      });

      // wait-ok: this deliberately withholds downstream demand beyond the authenticated lifetime.
      await new Promise((resolve) => setTimeout(resolve, lifetimeMs + 50));

      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      await expect.poll(() => subscriberCount(bindings, stash)).toBe(0);

      clock = expiresAt;
      const denied = await connect(stash, "?since=0", token.token, bindings, application);
      await expectError(denied, 401, "unauthorized");
    } finally {
      await reader.close();
    }
  });

  it("does not publish a stalled D1 replay result after the authenticated deadline", async () => {
    const stash = "events-expiry-stalled-replay";
    let clock = Date.parse("2026-08-28T02:45:00.000Z");
    const lifetimeMs = 150;
    const expiresAt = clock + lifetimeMs;
    await seedStash(stash);
    const token = await mintToken(stash, "read", { expiresAt });
    const baseBindings = createTestEnv().env;
    await put(baseBindings, stash, "late.txt");
    const gate = delayedAscendingSnapshot(baseBindings.DB);
    const bindings = {
      ...baseBindings,
      DB: gate.db,
      STASH_EVENTS_MAX_STREAM_MS: "500",
    };
    const application = createApp({ now: () => clock });
    const pendingResponse = connect(stash, "?since=0", token.token, bindings, application);
    let reader: EventReader | undefined;
    try {
      await gate.snapshotTaken;
      reader = eventReader(await pendingResponse);
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });

      gate.release();
      await reader.expectDone();
      await expect.poll(() => subscriberCount(baseBindings, stash)).toBe(0);

      clock = expiresAt;
      const denied = await connect(stash, "?since=0", token.token, baseBindings, application);
      await expectError(denied, 401, "unauthorized");
    } finally {
      gate.release();
      await reader?.close();
    }
  });

  it("uses the absolute monotonic fence when a late replay settles before its overdue timer", async () => {
    const stash = "events-expiry-overdue-timer";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    await put(baseBindings, stash, "late-same-turn.txt");
    const gate = delayedAscendingSnapshot(baseBindings.DB);
    const probe = instrumentSubscriptionCancellation({ ...baseBindings, DB: gate.db }, stash);
    const bindings = { ...probe.bindings, STASH_EVENTS_MAX_STREAM_MS: "60000" };
    let monotonicNow = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const pendingResponse = connect(stash, "?since=0", "test-admin", bindings);
    let reader: EventReader | undefined;
    try {
      await gate.snapshotTaken;
      monotonicNow += 60_001;
      gate.release();

      reader = eventReader(await pendingResponse);
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      await probe.canceled;
      expect(probe.cancelCalls()).toBe(1);
      await probe.requestAborted;
      expect(probe.capturedSignal()?.aborted).toBe(true);
      expect(probe.signalAbortedAtCancel()).toEqual([true]);
    } finally {
      gate.release();
      nowSpy.mockRestore();
      await reader?.close();
    }
  });

  it("starts fresh at the current head and returns the exact streaming headers", async () => {
    const stash = "events-fresh";
    await seedStash(stash);
    const bindings = createTestEnv().env;
    await put(bindings, stash, "first.txt");
    const latest = await put(bindings, stash, "second.txt");
    const response = await connect(stash, "", "test-admin", bindings);
    const reader = eventReader(response);
    try {
      expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Accel-Buffering")).toBe("no");
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "ready", head: latest.changeId, checkpoint: latest.changeId },
      });
    } finally {
      await reader.close();
    }
  });

  it("replays exact ascending ids with null origins before the ready checkpoint", async () => {
    const stash = "events-replay";
    await seedStash(stash);
    const bindings = createTestEnv().env;
    const first = await put(bindings, stash, "first.txt");
    const second = await put(bindings, stash, "second.txt");
    const third = await put(bindings, stash, "third.txt");
    const reader = eventReader(
      await connect(stash, `?since=${first.changeId}`, "test-admin", bindings),
    );
    try {
      expect(await reader.next()).toEqual({
        id: String(second.changeId),
        event: {
          type: "change",
          changeId: second.changeId,
          commitId: second.commitId,
          stash,
          path: "second.txt",
          version: 1,
          kind: "put",
          origin: null,
          createdAt: second.createdAt,
        },
      });
      expect(await reader.next()).toEqual({
        id: String(third.changeId),
        event: expect.objectContaining({
          type: "change",
          changeId: third.changeId,
          path: "third.txt",
          origin: null,
        }),
      });
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "ready", head: third.changeId, checkpoint: third.changeId },
      });
    } finally {
      await reader.close();
    }
  });

  it("does not lose the subscribe-to-replay gap and emits its change exactly once", async () => {
    const stash = "events-gap";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const gate = delayedAscendingSnapshot(baseBindings.DB);
    const bindings = { ...baseBindings, DB: gate.db };
    const pendingResponse = connect(stash, "?since=0", "test-admin", bindings);
    let reader: EventReader | undefined;
    try {
      await gate.snapshotTaken;
      expect(await subscriberCount(baseBindings, stash)).toBe(1);

      const created = await put(baseBindings, stash, "gap.txt");
      await publish(baseBindings, stash, {
        type: "change",
        changeId: created.changeId,
        commitId: created.commitId,
        stash,
        path: "gap.txt",
        version: created.version,
        kind: "put",
        origin: "gap-test",
        createdAt: created.createdAt,
      });
      gate.release();

      reader = eventReader(await pendingResponse);
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "ready", head: created.changeId, checkpoint: 0 },
      });
      expect(await reader.next()).toEqual({
        id: String(created.changeId),
        event: expect.objectContaining({
          type: "change",
          changeId: created.changeId,
          origin: "gap-test",
        }),
      });

      const sentinel: StashEvent = {
        type: "change-set",
        changeSetId: "cst_1756339200000deadbeef",
        stash,
        paths: ["gap.txt"],
        status: "open",
        origin: null,
      };
      await publish(baseBindings, stash, sentinel);
      expect(await reader.next()).toEqual({ id: null, event: sentinel });
    } finally {
      gate.release();
      await reader?.close();
    }
  });

  it("preserves an exact-id duplicate across the replay-to-live handoff", async () => {
    const stash = "events-duplicate";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const created = await put(baseBindings, stash, "duplicate.txt");
    const gate = delayedAscendingSnapshot(baseBindings.DB);
    const bindings = { ...baseBindings, DB: gate.db };
    const pendingResponse = connect(stash, "?since=0", "test-admin", bindings);
    let reader: EventReader | undefined;
    try {
      await gate.snapshotTaken;
      await publish(baseBindings, stash, {
        type: "change",
        changeId: created.changeId,
        commitId: created.commitId,
        stash,
        path: "duplicate.txt",
        version: created.version,
        kind: "put",
        origin: "live-duplicate",
        createdAt: created.createdAt,
      });
      gate.release();

      reader = eventReader(await pendingResponse);
      expect(await reader.next()).toEqual({
        id: String(created.changeId),
        event: expect.objectContaining({
          type: "change",
          changeId: created.changeId,
          origin: null,
        }),
      });
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "ready", head: created.changeId, checkpoint: created.changeId },
      });
      expect(await reader.next()).toEqual({
        id: String(created.changeId),
        event: expect.objectContaining({
          type: "change",
          changeId: created.changeId,
          origin: "live-duplicate",
        }),
      });
    } finally {
      gate.release();
      await reader?.close();
    }
  });

  it("opens no Durable Object stream for concealed, revoked, or rate-limited requests", async () => {
    const stash = "events-guarded";
    await seedStash(stash);
    const bindings = createTestEnv().env;
    await seedStash("other-events");
    const foreign = await mintToken("other-events", "read");
    const revoked = await mintToken(stash, "read");
    await bindings.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), revoked.id)
      .run();
    await seedStash("deleted-events");
    await bindings.DB.prepare("UPDATE stashes SET deleted_at = ? WHERE name = ?")
      .bind(Date.now(), "deleted-events")
      .run();

    const foreignResponse = await connect(stash, "", foreign.token, bindings);
    await expectError(foreignResponse, 404, "not-found");
    const revokedResponse = await connect(stash, "", revoked.token, bindings);
    await expectError(revokedResponse, 401, "unauthorized");
    const deletedResponse = await request(
      app,
      "http://stash.test/v1/stashes/deleted-events/events",
      { headers: bearer("test-admin") },
      bindings,
    );
    await expectError(deletedResponse, 404, "not-found");

    const rateLimitedBindings = {
      ...bindings,
      RL_READ: { limit: () => Promise.resolve({ success: false }) },
    };
    const allowed = await mintToken(stash, "read");
    const limitedResponse = await connect(stash, "", allowed.token, rateLimitedBindings);
    await expectError(limitedResponse, 429, "rate-limited");
    expect(limitedResponse.headers.get("Retry-After")).toBe("60");

    const invalidResponse = await connect(stash, "?since=-1", "test-admin", bindings);
    await expectError(invalidResponse, 400, "validation");

    expect(await subscriberCount(bindings, stash)).toBe(0);
    expect(await subscriberCount(bindings, "deleted-events")).toBe(0);
  });

  it("aborts the internal subscription when its initial dispatch rejects", async () => {
    const stash = "events-subscribe-rejection";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const probe = instrumentSubscriptionRejection(baseBindings, stash);

    const response = await connect(stash, "", "test-admin", probe.bindings);

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("X-Accel-Buffering")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal", message: "An internal error occurred." },
    });
    expect(probe.subscribeCalls()).toBe(1);
    expect(probe.capturedSignal()).toBeDefined();
    expect(probe.capturedSignal()?.aborted).toBe(true);
    expect(await subscriberCount(baseBindings, stash)).toBe(0);
  });

  it("bounds stalled Durable Object dispatch and releases a response that settles late", async () => {
    const stash = "events-stalled-dispatch";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const probe = instrumentDelayedSubscription(baseBindings, stash);
    const bindings = { ...probe.bindings, STASH_EVENTS_MAX_STREAM_MS: "75" };
    const pendingResponse = connect(stash, "", "test-admin", bindings);
    let reader: EventReader | undefined;
    try {
      await probe.dispatched;
      reader = eventReader(await pendingResponse);
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      expect(probe.capturedSignal()?.aborted).toBe(true);

      probe.release();
      await probe.canceled;
      expect(probe.cancelCalls()).toBe(1);
    } finally {
      probe.release();
      await reader?.close();
    }
  });

  it("closes the live subscription before returning a pre-deadline D1 failure", async () => {
    const stash = "events-change-read-failure";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const failingBindings = { ...baseBindings, DB: rejectingChangesDatabase(baseBindings.DB) };
    const probe = instrumentSubscriptionCancellation(failingBindings, stash, {
      rejectCancel: true,
    });

    const response = await connect(stash, "", "test-admin", probe.bindings);

    await expectError(response, 500, "internal");
    await probe.canceled;
    expect(probe.cancelCalls()).toBe(1);
    expect(probe.signalAbortedAtCancel()).toEqual([false]);
    await probe.requestAborted;
    expect(probe.capturedSignal()?.aborted).toBe(true);
  });

  it("lets the authenticated deadline beat an unread replay-limit prefix", async () => {
    const stash = "events-replay-limit-expiry";
    let clock = Date.parse("2026-08-28T03:00:00.000Z");
    const lifetimeMs = 800;
    const expiresAt = clock + lifetimeMs;
    await seedStash(stash);
    const token = await mintToken(stash, "read", { expiresAt });
    const baseBindings = createTestEnv().env;
    const probe = instrumentSubscriptionCancellation(baseBindings, stash);
    const bindings = { ...probe.bindings, STASH_EVENTS_MAX_STREAM_MS: "2000" };
    await seedChanges(baseBindings, stash, 1_001);
    const application = createApp({ now: () => clock });
    const reader = eventReader(
      await connect(stash, "?since=0", token.token, bindings, application),
    );
    try {
      expect(await reader.next()).toEqual({
        id: "1",
        event: expect.objectContaining({ type: "change", changeId: 1, origin: null }),
      });

      // wait-ok: this deliberately withholds demand past the authenticated lifetime so the
      // buffered replay-limit branch must be discarded rather than drained.
      await new Promise((resolve) => setTimeout(resolve, lifetimeMs + 50));

      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "lifetime" },
      });
      await reader.expectDone();
      await probe.canceled;
      expect(probe.cancelCalls()).toBe(1);

      clock = expiresAt;
      const denied = await connect(stash, "?since=0", token.token, baseBindings, application);
      await expectError(denied, 401, "unauthorized");
    } finally {
      await reader.close();
    }
  });

  it("rotates after 1,000 replayed changes and closes without a ready frame", async () => {
    const stash = "events-replay-limit";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const probe = instrumentSubscriptionCancellation(baseBindings, stash);
    await seedChanges(baseBindings, stash, 1_001);
    const reader = eventReader(await connect(stash, "?since=0", "test-admin", probe.bindings));
    try {
      for (let expectedId = 1; expectedId <= 1_000; expectedId += 1) {
        const frame = await reader.next();
        expect(frame.id).toBe(String(expectedId));
        expect(frame.event).toMatchObject({ type: "change", changeId: expectedId, origin: null });
      }
      expect(await reader.next()).toEqual({
        id: null,
        event: { type: "reconnect", reason: "replay-limit" },
      });
      await reader.expectDone();
      await probe.canceled;
      expect(probe.cancelCalls()).toBe(1);
      expect(probe.signalAbortedAtCancel()).toEqual([false]);
      await probe.requestAborted;
      expect(probe.capturedSignal()?.aborted).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("propagates downstream cancellation to the Durable Object response body", async () => {
    const stash = "events-cancel";
    await seedStash(stash);
    const baseBindings = createTestEnv().env;
    const probe = instrumentSubscriptionCancellation(baseBindings, stash);
    const reader = eventReader(await connect(stash, "", "test-admin", probe.bindings));
    try {
      expect((await reader.next()).event).toEqual({ type: "ready", head: null, checkpoint: null });
      expect(probe.cancelCalls()).toBe(0);
    } finally {
      await reader.close();
    }
    await probe.canceled;
    expect(probe.cancelCalls()).toBe(1);
    expect(probe.signalAbortedAtCancel()).toEqual([false]);
    await probe.requestAborted;
    expect(probe.capturedSignal()?.aborted).toBe(true);
  });
});
