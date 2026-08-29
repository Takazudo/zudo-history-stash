import {
  STASH_CLIENT_ID_HEADER,
  StashEventSchema,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import type { Env } from "../../src/env.js";
import { eventOrigin } from "../../src/events/publish.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const STASH = "publish-events";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

function recordingEnv(
  options: {
    failure?: "reject" | "throw";
    importVersionIds?: readonly number[];
  } = {},
): {
  bindings: Env;
  events: StashEvent[];
  names: string[];
} {
  const base = createTestEnv().env;
  const events: StashEvent[] = [];
  const names: string[] = [];
  const namespace = new Proxy(base.STASH_EVENTS, {
    get(target, property, receiver) {
      if (property === "getByName") {
        return (name: string) => {
          names.push(name);
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(stubTarget, stubProperty, stubReceiver) {
              if (stubProperty === "fetch") {
                return (input: Request): Promise<Response> => {
                  const error = new Error("Injected event publication failure");
                  if (options.failure === "throw") throw error;
                  if (options.failure === "reject") return Promise.reject(error);
                  return input.json().then((value) => {
                    events.push(StashEventSchema.parse(value));
                    return new Response(null, { status: 204 });
                  });
                };
              }
              const value = Reflect.get(stubTarget, stubProperty, stubReceiver);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database =
    options.importVersionIds === undefined
      ? base.DB
      : new Proxy(base.DB, {
          get(target, property, receiver) {
            if (property !== "withSession") return Reflect.get(target, property, receiver);
            return (...args: Parameters<D1Database["withSession"]>) => {
              const session = target.withSession(...args);
              return new Proxy(session, {
                get(sessionTarget, sessionProperty, sessionReceiver) {
                  if (sessionProperty !== "batch") {
                    return Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
                  }
                  return async (statements: D1PreparedStatement[]) => {
                    const results = await session.batch(statements);
                    if (statements.length !== 5 || results.at(-1)?.meta.changes !== 1)
                      return results;
                    const ids = options.importVersionIds ?? [];
                    const versionIndexes = [1, 2, 3];
                    return results.map((result, index) => {
                      const versionOffset = versionIndexes.indexOf(index);
                      if (versionOffset < 0 || ids[versionOffset] === undefined) return result;
                      return {
                        ...result,
                        meta: { ...result.meta, last_row_id: ids[versionOffset] },
                      };
                    });
                  };
                },
              });
            };
          },
        });
  return { bindings: { ...base, DB: database, STASH_EVENTS: namespace }, events, names };
}

async function mutation(
  bindings: Env,
  path: string,
  body: unknown,
  options: { method?: "POST" | "PUT"; key?: string; clientId?: string } = {},
): Promise<Response> {
  const headers = new Headers({ ...bearer("test-admin"), "Content-Type": "application/json" });
  if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
  if (options.clientId !== undefined) headers.set(STASH_CLIENT_ID_HEADER, options.clientId);
  return request(
    app,
    `${BASE}${path}`,
    { method: options.method ?? "POST", headers, body: JSON.stringify(body) },
    bindings,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("event publication", () => {
  it("accepts only canonical client origins after the actual Request boundary", () => {
    expect(
      eventOrigin(new Request("https://x", { headers: { [STASH_CLIENT_ID_HEADER]: "tab A!~" } })),
    ).toBe("tab A!~");
    expect(eventOrigin(new Request("https://x"))).toBeNull();
    expect(
      eventOrigin(
        new Request("https://x", { headers: { [STASH_CLIENT_ID_HEADER]: "x".repeat(65) } }),
      ),
    ).toBeNull();
    expect(
      eventOrigin(
        new Request("https://x", { headers: { [STASH_CLIENT_ID_HEADER]: "internal\ttab" } }),
      ),
    ).toBeNull();

    const normalized = new Request("https://x", {
      headers: { [STASH_CLIENT_ID_HEADER]: " edge-space " },
    });
    expect(normalized.headers.get(STASH_CLIENT_ID_HEADER)).toBe("edge-space");
    expect(eventOrigin(normalized)).toBe("edge-space");
    expect(
      () =>
        new Request("https://x", {
          headers: { [STASH_CLIENT_ID_HEADER]: "nul\0byte" },
        }),
    ).toThrow(TypeError);
  });

  it("publishes only new file versions and preserves exact ids and origin", async () => {
    const { bindings, events } = recordingEnv();
    const put = await mutation(
      bindings,
      "/files/a.txt",
      { body: "one", expectedVersion: null },
      { method: "PUT", key: "put-one", clientId: "tab A!~" },
    );
    const putResult = await put.json<{ changeId: number; createdAt: string }>();
    expect(events).toEqual([
      expect.objectContaining({
        type: "change",
        changeId: putResult.changeId,
        stash: STASH,
        path: "a.txt",
        version: 1,
        kind: "put",
        origin: "tab A!~",
        createdAt: putResult.createdAt,
      }),
    ]);

    await mutation(
      bindings,
      "/files/a.txt",
      { body: "one", expectedVersion: null },
      { method: "PUT", key: "put-one" },
    );
    await mutation(
      bindings,
      "/files/a.txt",
      { body: "one", expectedVersion: 1, skipIfUnchanged: true },
      { method: "PUT" },
    );
    await mutation(
      bindings,
      "/files/a.txt",
      { body: "stale", expectedVersion: 99 },
      { method: "PUT" },
    );
    expect(events).toHaveLength(1);

    const deleted = await mutation(
      bindings,
      "/delete/a.txt",
      { expectedVersion: 1 },
      { key: "delete-one" },
    );
    const deleteResult = await deleted.json<{ changeId: number }>();
    expect(events.at(-1)).toMatchObject({
      type: "change",
      changeId: deleteResult.changeId,
      version: 2,
      kind: "delete",
      origin: null,
    });
    await mutation(bindings, "/delete/a.txt", { expectedVersion: 1 }, { key: "delete-one" });

    const rollback = await mutation(
      bindings,
      "/rollback/a.txt",
      { expectedVersion: 2, toVersion: 1 },
      { key: "rollback-one" },
    );
    const rollbackResult = await rollback.json<{ changeId: number }>();
    expect(events.at(-1)).toMatchObject({
      type: "change",
      changeId: rollbackResult.changeId,
      version: 3,
      kind: "rollback",
    });
    await mutation(
      bindings,
      "/rollback/a.txt",
      { expectedVersion: 2, toVersion: 1 },
      { key: "rollback-one" },
    );
    expect(events).toHaveLength(3);
  });

  it("publishes import events in statement order with each exact inserted id", async () => {
    const exactIds = [101, 303, 707];
    const { bindings, events } = recordingEnv({ importVersionIds: exactIds });
    const response = await mutation(
      bindings,
      "/import",
      {
        path: "history.txt",
        expectedVersion: null,
        versions: [
          { kind: "put", body: "one", createdAt: 1_000 },
          { kind: "delete", body: null, createdAt: 1_001 },
          { kind: "rollback", body: null, rollbackOf: 1, createdAt: 1_002 },
        ],
      },
      { clientId: "importer" },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const rows = await bindings.DB.prepare(
      "SELECT id, version, kind FROM versions WHERE stash_name = ? ORDER BY version",
    )
      .bind(STASH)
      .all<{ id: number; version: number; kind: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.map(({ id }) => id).every((id) => !exactIds.includes(id))).toBe(true);
    expect(events.map((event) => (event.type === "change" ? event.changeId : -1))).toEqual(
      exactIds,
    );
    expect(events.map((event) => (event.type === "change" ? event.kind : ""))).toEqual([
      "put",
      "delete",
      "rollback",
    ]);
    expect(events.every((event) => event.type === "change" && event.origin === "importer")).toBe(
      true,
    );
    await expect(response.json()).resolves.toEqual({
      commitId: `legacy:${exactIds[0]}`,
      path: "history.txt",
      headVersion: 3,
      firstChangeId: exactIds[0],
    });
    const refused = await mutation(bindings, "/import", {
      path: "history.txt",
      expectedVersion: null,
      versions: [{ kind: "put", body: "stale", createdAt: 2_000 }],
    });
    expect(refused.status).toBe(409);
    expect(events).toHaveLength(3);

    const continued = await mutation(
      bindings,
      "/import",
      {
        path: "history.txt",
        expectedVersion: 3,
        versions: [{ kind: "rollback", body: null, rollbackOf: 1, createdAt: 1_003 }],
      },
      { clientId: "continuation" },
    );
    expect(continued.status).toBe(201);
    const rollbackRow = await bindings.DB.prepare(
      `SELECT id, size_bytes, created_at FROM versions
       WHERE stash_name = ? AND path = ? AND version = 4`,
    )
      .bind(STASH, "history.txt")
      .first<{ id: number; size_bytes: number; created_at: number }>();
    if (rollbackRow === null) throw new Error("Expected committed continuation rollback");
    expect(rollbackRow.size_bytes).toBe(3);
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toEqual({
      type: "change",
      changeId: rollbackRow.id,
      commitId: `legacy:${rollbackRow.id}`,
      stash: STASH,
      path: "history.txt",
      version: 4,
      kind: "rollback",
      origin: "continuation",
      createdAt: new Date(rollbackRow.created_at).toISOString(),
    });
    await expect(continued.json()).resolves.toEqual({
      commitId: `legacy:${rollbackRow.id}`,
      path: "history.txt",
      headVersion: 4,
      firstChangeId: rollbackRow.id,
    });
  });

  it.each(["reject", "throw"] as const)(
    "swallows a %s from stub.fetch after the durable commit",
    async (failure) => {
      const { bindings, names } = recordingEnv({ failure });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const response = await mutation(
          bindings,
          `/files/${failure}.txt`,
          { body: "committed", expectedVersion: null },
          { method: "PUT" },
        );
        expect(response.status).toBe(201);
        const result = await response.json<{ version: number; changeId: number }>();
        expect(result).toMatchObject({ version: 1, changeId: expect.any(Number) });
        await expect(
          bindings.DB.prepare(
            "SELECT COUNT(*) AS count FROM versions WHERE stash_name = ? AND path = ?",
          )
            .bind(STASH, `${failure}.txt`)
            .first("count"),
        ).resolves.toBe(1);
        expect(names).toEqual([STASH]);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("publication failed"));
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});
