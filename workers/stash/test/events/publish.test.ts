import { StashEventSchema, type StashEvent } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import type { Env } from "../../src/env.js";
import { eventOrigin } from "../../src/events/publish.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const STASH = "publish-events";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

function recordingEnv(options: { importVersionIds?: readonly number[]; reject?: boolean } = {}): {
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
                return async (input: Request) => {
                  if (options.reject) throw new Error("Injected event publication failure");
                  events.push(StashEventSchema.parse(await input.json()));
                  return new Response(null, { status: 204 });
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
  if (options.clientId !== undefined) headers.set("X-Stash-Client-Id", options.clientId);
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
  it("accepts only bounded client origins", () => {
    expect(
      eventOrigin(new Request("https://x", { headers: { "X-Stash-Client-Id": "tab-a" } })),
    ).toBe("tab-a");
    expect(eventOrigin(new Request("https://x"))).toBeNull();
    expect(
      eventOrigin(new Request("https://x", { headers: { "X-Stash-Client-Id": "x".repeat(65) } })),
    ).toBeNull();
  });

  it("publishes only new file versions and preserves exact ids and origin", async () => {
    const { bindings, events } = recordingEnv();
    const put = await mutation(
      bindings,
      "/files/a.txt",
      { body: "one", expectedVersion: null },
      { method: "PUT", key: "put-one", clientId: "tab-a" },
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
        origin: "tab-a",
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
  });

  it("publishes proposal transitions once, with approval change before status", async () => {
    const { bindings, events } = recordingEnv();
    const createdResponse = await mutation(
      bindings,
      "/proposals",
      { path: "review.md", body: "candidate", baseVersion: null },
      { key: "proposal-one", clientId: "reviewer" },
    );
    const created = await createdResponse.json<{ id: string }>();
    expect(events).toEqual([
      expect.objectContaining({
        type: "proposal",
        proposalId: created.id,
        status: "open",
        origin: "reviewer",
      }),
    ]);
    await mutation(
      bindings,
      "/proposals",
      { path: "review.md", body: "candidate", baseVersion: null },
      { key: "proposal-one" },
    );
    expect(events).toHaveLength(1);
    const mismatch = await mutation(
      bindings,
      "/proposals",
      { path: "review.md", body: "different", baseVersion: null },
      { key: "proposal-one" },
    );
    expect(mismatch.status).toBe(422);
    expect(events).toHaveLength(1);

    const approvedResponse = await mutation(bindings, `/proposals/${created.id}/approve`, {});
    const approved = await approvedResponse.json<{
      appliedChangeId: number;
      appliedVersion: number;
      createdAt: string;
    }>();
    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        type: "change",
        changeId: approved.appliedChangeId,
        version: approved.appliedVersion,
        createdAt: approved.createdAt,
      }),
      expect.objectContaining({ type: "proposal", proposalId: created.id, status: "applied" }),
    ]);
    await mutation(bindings, `/proposals/${created.id}/approve`, {});
    expect(events).toHaveLength(3);

    const rejectCreate = await mutation(bindings, "/proposals", {
      path: "reject.md",
      body: "candidate",
      baseVersion: null,
    });
    const rejected = await rejectCreate.json<{ id: string }>();
    expect(events.at(-1)).toMatchObject({ type: "proposal", status: "open" });
    await mutation(bindings, `/proposals/${rejected.id}/reject`, { reason: "no" });
    expect(events.at(-1)).toMatchObject({
      type: "proposal",
      proposalId: rejected.id,
      status: "rejected",
    });
    const count = events.length;
    await mutation(bindings, `/proposals/${rejected.id}/reject`, { reason: "again" });
    expect(events).toHaveLength(count);
  });

  it("swallows publication failures after the durable commit", async () => {
    const { bindings, names } = recordingEnv({ reject: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await mutation(
        bindings,
        "/files/failure.txt",
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
          .bind(STASH, "failure.txt")
          .first("count"),
      ).resolves.toBe(1);
      expect(names).toEqual([STASH]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("publication failed"));
    } finally {
      consoleError.mockRestore();
    }
  });
});
