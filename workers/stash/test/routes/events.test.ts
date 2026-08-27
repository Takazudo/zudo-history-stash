import type { StashEvent } from "@takazudo/zudo-history-stash-core";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { createStashStore } from "../../src/d1/store.js";
import {
  STASH_EVENTS_INSPECT,
  STASH_EVENTS_PUBLISH_PATH,
  type StashEvents,
} from "../../src/events/stash-events.js";
import type { Env } from "../../src/env.js";
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
): Promise<Response> {
  return request(
    app,
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
): {
  bindings: Env;
  canceled: Promise<void>;
  cancelCalls: () => number;
} {
  // The DO suite proves that its source cancel hook removes the subscriber. Current Miniflare
  // does not propagate cancellation across DurableObjectStub.fetch(), so this probe isolates the
  // route's responsibility: both terminal paths must cancel the upstream response body exactly once.
  let resolveCanceled: () => void = () => undefined;
  const canceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  let cancelCalls = 0;
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
                  return Promise.resolve(
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
  };
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
  for (let offset = 0; offset < count; offset += 100) {
    const statements = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
      const change = offset + index + 1;
      return bindings.DB.prepare(
        `INSERT INTO versions
           (stash_name, path, version, kind, blob_hash, size_bytes, author, message, created_at)
         VALUES (?, ?, 1, 'put', ?, 1, '', '', ?)`,
      ).bind(stash, `bulk/${change}.txt`, `hash-${change}`, change);
    });
    await bindings.DB.batch(statements);
  }
}

beforeEach(resetDatabase);

describe("stash events route", () => {
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
        type: "proposal",
        proposalId: "prp_1756339200000deadbeef",
        stash,
        path: "gap.txt",
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
  });
});
