import { env } from "cloudflare:workers";
import { BODY_LIMIT_BYTES, MAX_BODY_BYTES } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { escapedPutRequest, repeatedAsciiRequest } from "../helpers/large-json.js";

const STASH = "route-files";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

async function api(
  path: string,
  init: RequestInit = {},
  token: string | null = "test-admin",
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return request(app, `${BASE}${path}`, { ...init, headers });
}

async function jsonApi(
  method: "PUT" | "POST",
  path: string,
  body: unknown,
  options: { token?: string | null; headers?: HeadersInit } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  return api(
    path,
    { method, headers, body: JSON.stringify(body) },
    options.token === undefined ? "test-admin" : options.token,
  );
}

async function put(
  path: string,
  body: string,
  expectedVersion: number | null,
  options: { idempotencyKey?: string; skipIfUnchanged?: boolean } = {},
): Promise<Response> {
  return jsonApi(
    "PUT",
    `/files/${path}`,
    {
      body,
      expectedVersion,
      ...(options.skipIfUnchanged ? { skipIfUnchanged: true } : {}),
    },
    {
      headers:
        options.idempotencyKey === undefined
          ? undefined
          : { "Idempotency-Key": options.idempotencyKey },
    },
  );
}

async function expectCode(response: Response, status: number, code: string): Promise<unknown> {
  expect(response.status).toBe(status);
  const body = await response.json<{ error: { code: string } }>();
  expect(body.error.code).toBe(code);
  return body;
}

async function countRows(table: "versions" | "idempotency"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
    .bind(STASH)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("file route reads", () => {
  it("lists live and deleted files with strict pagination queries", async () => {
    await put("a.txt", "a", null);
    await put("b.txt", "b", null);
    await jsonApi("POST", "/delete/a.txt", { expectedVersion: 1 });

    const live = await api("/files?limit=1");
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({
      files: [
        expect.objectContaining({
          path: "b.txt",
          headVersion: 1,
          deleted: false,
          hash: expect.stringMatching(/^sha256-/),
          size: 1,
          updatedAt: expect.stringMatching(/Z$/),
        }),
      ],
      nextAfter: null,
    });

    const first = await api("/files?includeDeleted=true&limit=1");
    expect(first.status).toBe(200);
    const firstPage = await first.json<{
      files: { path: string; deleted: boolean }[];
      nextAfter: string | null;
    }>();
    expect(firstPage).toMatchObject({
      files: [{ path: "a.txt", deleted: true }],
      nextAfter: "a.txt",
    });
    const second = await api(`/files?includeDeleted=true&limit=1&after=${firstPage.nextAfter}`);
    await expect(second.json()).resolves.toMatchObject({
      files: [{ path: "b.txt", deleted: false }],
      nextAfter: null,
    });

    await expectCode(await api("/files?limit=201"), 400, "validation");
    await expectCode(await api("/files?unexpected=true"), 400, "validation");
  });

  it("round-trips exact bodies and returns only the public file representation", async () => {
    const bodies = ["日本語", "line1\r\nline2", ""];
    for (const [index, body] of bodies.entries()) {
      const path = `exact/${index}.txt`;
      expect((await put(path, body, null)).status).toBe(201);
      const response = await api(`/files/${path}`);
      expect(response.status).toBe(200);
      const record = await response.json<Record<string, unknown>>();
      expect(record).toMatchObject({ path, version: 1, body, deleted: false, kind: "put" });
      expect(record).toMatchObject({
        representation: "text",
        contentAccess: "inline",
        contentType: "text/plain; charset=utf-8",
        byteSize: new TextEncoder().encode(body).byteLength,
        etag: expect.stringMatching(/^sha256-/),
      });
      expect(record).not.toHaveProperty("rollbackOf");
    }
  });

  it("uses representation ETags and implements exact, list, weak, and star 304 checks", async () => {
    const created = await put("etag.txt", "etag body", null);
    const result = await created.json<{ hash: string }>();
    const etag = `"v1-${result.hash}"`;

    const first = await api("/files/etag.txt");
    expect(first.status).toBe(200);
    expect(first.headers.get("ETag")).toBe(etag);
    expect(first.headers.get("X-Stash-Version")).toBe("1");

    for (const ifNoneMatch of [etag, `"other", ${etag}`, `W/${etag}`, "*"]) {
      const response = await api("/files/etag.txt", {
        headers: { "If-None-Match": ifNoneMatch },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(response.headers.get("X-Stash-Version")).toBe("1");
      expect(await response.text()).toBe("");
    }
  });

  it("changes the ETag when an identical rollback appends a representation", async () => {
    await put("identical.txt", "same", null);
    const head = await api("/files/identical.txt");
    const oldEtag = head.headers.get("ETag");
    expect(oldEtag).not.toBeNull();

    const rollback = await jsonApi(
      "POST",
      "/rollback/identical.txt",
      { expectedVersion: 1, toVersion: 1 },
      { headers: { "Idempotency-Key": "identical-rollback" } },
    );
    expect(rollback.status).toBe(201);
    await expect(rollback.json()).resolves.toMatchObject({
      version: 2,
      rollbackOf: 1,
      identicalToHead: true,
    });

    const next = await api("/files/identical.txt", {
      headers: { "If-None-Match": oldEtag ?? "" },
    });
    expect(next.status).toBe(200);
    expect(next.headers.get("ETag")).not.toBe(oldEtag);
    expect(next.headers.get("ETag")).toMatch(/^"v2-sha256-/);
  });

  it("distinguishes a deleted head, an explicit tombstone version, and a missing version", async () => {
    await put("deleted.txt", "live", null);
    expect((await jsonApi("POST", "/delete/deleted.txt", { expectedVersion: 1 })).status).toBe(200);

    const head = await api("/files/deleted.txt");
    const deleted = (await expectCode(head, 404, "file-deleted")) as {
      current?: Record<string, unknown>;
    };
    expect(deleted.current).toMatchObject({
      version: 2,
      hash: null,
      deleted: true,
      kind: "delete",
      author: "",
      createdAt: expect.stringMatching(/Z$/),
    });

    const tombstone = await api("/files/deleted.txt?version=2");
    expect(tombstone.status).toBe(200);
    expect(tombstone.headers.get("ETag")).toBe('"v2-deleted"');
    expect(tombstone.headers.get("X-Stash-Version")).toBe("2");
    await expect(tombstone.json()).resolves.toMatchObject({
      path: "deleted.txt",
      version: 2,
      hash: null,
      size: 0,
      kind: "delete",
      deleted: true,
      body: null,
    });
    const tombstoneNotModified = await api("/files/deleted.txt?version=2", {
      headers: { "If-None-Match": 'W/"v2-deleted"' },
    });
    expect(tombstoneNotModified.status).toBe(304);
    expect(tombstoneNotModified.headers.get("ETag")).toBe('"v2-deleted"');
    expect(await tombstoneNotModified.text()).toBe("");

    await expectCode(await api("/files/deleted.txt?version=99"), 404, "version-not-found");
    await expectCode(await api("/files/deleted.txt?version=0"), 400, "validation");
    await expectCode(await api("/files/missing.txt"), 404, "not-found");
  });

  it("decodes a nested dotted path once and rejects traversal or a second decode", async () => {
    const path = "dir.with.dot/nested/file.name.txt";
    expect((await put(path, "path body", null)).status).toBe(201);
    await expect((await api(`/files/${path}`)).json()).resolves.toMatchObject({ path });

    await expectCode(await api("/files/a%2F..%2Fb"), 400, "invalid-path");
    await expectCode(await api("/files/%2561.txt"), 400, "invalid-path");
  });
});

describe("file route writes", () => {
  it("maps create, stale, exists, skip-if-unchanged, and already-deleted outcomes", async () => {
    const created = await put("cas.txt", "base", null);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      version: 1,
      hash: expect.stringMatching(/^sha256-/),
      size: 4,
      changeId: expect.any(Number),
      createdAt: expect.stringMatching(/Z$/),
    });

    const stale = await put("cas.txt", "base", 2);
    const staleBody = (await expectCode(stale, 409, "stale")) as {
      current?: Record<string, unknown>;
    };
    expect(staleBody.current).toMatchObject({ version: 1, deleted: false, kind: "put" });
    await expectCode(await put("cas.txt", "base", null), 409, "exists");

    const unchanged = await put("cas.txt", "base", 1, {
      idempotencyKey: "unchanged-key",
      skipIfUnchanged: true,
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.headers.get("Idempotent-Replayed")).toBeNull();
    await expect(unchanged.json()).resolves.toEqual({ unchanged: true, version: 1 });

    const deletion = await jsonApi("POST", "/delete/cas.txt", { expectedVersion: 1 });
    expect(deletion.status).toBe(200);
    await expect(deletion.json()).resolves.toEqual({
      commitId: "legacy:2",
      version: 2,
      changeId: expect.any(Number),
      createdAt: expect.stringMatching(/Z$/),
    });
    await expectCode(
      await jsonApi("POST", "/delete/cas.txt", { expectedVersion: 2 }),
      409,
      "already-deleted",
    );
  });

  it("replays put and delete responses with their original statuses", async () => {
    const first = await put("ledger.txt", "first", null, { idempotencyKey: "put-ledger" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await put("ledger.txt", "first", null, { idempotencyKey: "put-ledger" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(await countRows("versions")).toBe(1);

    await expectCode(
      await put("ledger.txt", "different", null, { idempotencyKey: "put-ledger" }),
      422,
      "idempotency-key-reused",
    );

    const deletion = await jsonApi(
      "POST",
      "/delete/ledger.txt",
      { expectedVersion: 1 },
      { headers: { "Idempotency-Key": "delete-ledger" } },
    );
    const deletionBody = await deletion.json();
    expect(deletion.status).toBe(200);
    const deletionReplay = await jsonApi(
      "POST",
      "/delete/ledger.txt",
      { expectedVersion: 1 },
      { headers: { "Idempotency-Key": "delete-ledger" } },
    );
    expect(deletionReplay.status).toBe(200);
    expect(deletionReplay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await deletionReplay.json()).toEqual(deletionBody);
    expect(await countRows("versions")).toBe(2);
  });

  it("replays rollback once and maps missing and tombstone targets", async () => {
    await put("rollback.txt", "one", null);
    await put("rollback.txt", "two", 1);
    await jsonApi("POST", "/delete/rollback.txt", { expectedVersion: 2 });

    await expectCode(
      await jsonApi("POST", "/rollback/rollback.txt", { expectedVersion: 3, toVersion: 99 }),
      404,
      "version-not-found",
    );
    await expectCode(
      await jsonApi("POST", "/rollback/rollback.txt", { expectedVersion: 3, toVersion: 3 }),
      422,
      "rollback-target-tombstone",
    );

    const input = { expectedVersion: 3, toVersion: 1, author: "route" };
    const first = await jsonApi("POST", "/rollback/rollback.txt", input, {
      headers: { "Idempotency-Key": "rollback-ledger" },
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      version: 4,
      hash: expect.stringMatching(/^sha256-/),
      rollbackOf: 1,
      identicalToHead: false,
      changeId: expect.any(Number),
      createdAt: expect.stringMatching(/Z$/),
      representation: "text",
      contentType: "text/plain; charset=utf-8",
      byteSize: 3,
      etag: expect.stringMatching(/^sha256-/),
    });
    const replay = await jsonApi("POST", "/rollback/rollback.txt", input, {
      headers: { "Idempotency-Key": "rollback-ledger" },
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(await countRows("versions")).toBe(4);
  });

  it("returns body-safe validation errors and validates idempotency keys", async () => {
    const marker = "ZHS_ROUTE_BODY_MUST_NOT_BE_ECHOED";
    const unknown = await jsonApi("PUT", "/files/validation.txt", {
      body: marker,
      expectedVersion: null,
      unexpected: marker,
    });
    expect(unknown.status).toBe(400);
    const unknownText = await unknown.text();
    expect(unknownText).not.toContain(marker);
    expect(JSON.parse(unknownText)).toMatchObject({ error: { code: "validation" } });

    await expectCode(
      await api("/files/malformed.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      400,
      "validation",
    );
    await expectCode(
      await api("/files/no-content-type.txt", {
        method: "PUT",
        body: JSON.stringify({ body: "key", expectedVersion: null }),
      }),
      400,
      "validation",
    );
    await expectCode(
      await api("/files/malformed-content-type.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json;" },
        body: JSON.stringify({ body: "key", expectedVersion: null }),
      }),
      400,
      "validation",
    );
    await expectCode(
      await jsonApi(
        "PUT",
        "/files/key.txt",
        { body: "key", expectedVersion: null },
        { headers: { "Idempotency-Key": "x".repeat(201) } },
      ),
      400,
      "validation",
    );
    await expectCode(
      await jsonApi(
        "PUT",
        "/files/empty-key.txt",
        { body: "key", expectedVersion: null },
        { headers: { "Idempotency-Key": "" } },
      ),
      400,
      "validation",
    );
  });

  it("distinguishes Unicode, decoded-body, and raw-request size failures", async () => {
    await expectCode(
      await api("/files/surrogate.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: '{"body":"\\uD800","expectedVersion":null}',
      }),
      400,
      "body-not-well-formed",
    );

    await expectCode(
      await put("large.txt", "x".repeat(MAX_BODY_BYTES + 1), null),
      413,
      "payload-too-large",
    );

    const rawTooLarge = repeatedAsciiRequest(BODY_LIMIT_BYTES + 1);
    await expectCode(
      await api("/files/raw-too-large.txt", {
        method: "PUT",
        headers: {
          "Content-Length": String(rawTooLarge.byteLength),
          "Content-Type": "application/json",
        },
        body: rawTooLarge.body,
      }),
      413,
      "payload-too-large",
    );

    const escaped = escapedPutRequest(MAX_BODY_BYTES);
    expect(escaped.byteLength).toBeLessThan(BODY_LIMIT_BYTES);
    const accepted = await api("/files/escaped.txt", {
      method: "PUT",
      headers: {
        "Content-Length": String(escaped.byteLength),
        "Content-Type": "application/json",
      },
      body: escaped.body,
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({ size: MAX_BODY_BYTES });
  }, 60_000);

  it("enforces authentication, write scope, and foreign-stash concealment", async () => {
    await expectCode(await api("/files", {}, null), 401, "unauthorized");

    const read = await mintToken(STASH, "read");
    for (const [method, path, body] of [
      ["PUT", "/files/denied.txt", { body: "x", expectedVersion: null }],
      ["POST", "/delete/denied.txt", { expectedVersion: 1 }],
      ["POST", "/rollback/denied.txt", { expectedVersion: 1, toVersion: 1 }],
    ] as const) {
      await expectCode(await jsonApi(method, path, body, { token: read.token }), 403, "scope");
    }

    await seedStash("foreign-route");
    const foreign = await mintToken("foreign-route", "write");
    await expectCode(await api("/files", {}, foreign.token), 404, "not-found");
    await expectCode(await api("/files/missing.txt", {}, foreign.token), 404, "not-found");
  });
});
