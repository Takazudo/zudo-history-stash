import {
  BODY_LIMIT_BYTES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_BODY_BYTES,
  ROUTES,
  sha256Hex,
  type RouteId,
} from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  FAKE_SUPPORTED_ROUTE_IDS,
  createFakeStash,
} from "../../src/testing/index.js";

const ADMIN = "fake-admin";

function request(
  fake: ReturnType<typeof createFakeStash>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ADMIN}`);
  return fake.fetch(`https://fake.invalid${path}`, { ...init, headers });
}

async function errorCode(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { code?: unknown } };
  return body.error?.code;
}

const UNSUPPORTED_SAMPLES: Record<
  Exclude<RouteId, (typeof CONFORMANCE_SUPPORTED_ROUTE_IDS)[number]>,
  { method: string; path: string }
> = {
  health: { method: "GET", path: "/v1/health" },
  importHistory: { method: "POST", path: "/v1/stashes/demo/import" },
  listChanges: { method: "GET", path: "/v1/changes" },
};

describe("fake route boundary", () => {
  it("pins the implementation and trace to the exact supported route set", () => {
    expect(new Set(FAKE_SUPPORTED_ROUTE_IDS)).toEqual(new Set(CONFORMANCE_SUPPORTED_ROUTE_IDS));
    expect(ROUTES.filter((route) => !FAKE_SUPPORTED_ROUTE_IDS.includes(route.id))).toHaveLength(
      Object.keys(UNSUPPORTED_SAMPLES).length,
    );
  });

  it.each(Object.entries(UNSUPPORTED_SAMPLES))(
    "returns documented 501 for unsupported %s",
    async (_routeId, sample) => {
      const fake = createFakeStash({ adminToken: ADMIN });
      const response = await request(fake, sample.path, { method: sample.method });
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "not-implemented" },
      });
    },
  );

  it("returns 501 for an unknown route rather than pretending to be a full server", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    const response = await request(fake, "/v1/not-a-real-route");
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe("not-implemented");
  });
});

describe("inspectable state and fixture helpers", () => {
  it("exposes each table and reset clears them without replacing state", async () => {
    const fake = createFakeStash({ adminToken: ADMIN, now: () => 1_700_000_000_000 });
    const exposed = fake.state;
    expect(fake.createStash("demo")).toBe("demo");
    const token = await fake.mintToken("demo", "write");

    const response = await fake.fetch("https://fake.invalid/v1/stashes/demo/files/a.txt", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "fixture",
      },
      body: JSON.stringify({ body: "hello", expectedVersion: null }),
    });
    expect(response.status).toBe(201);
    expect(exposed.stashes.size).toBe(1);
    expect(exposed.tokens.size).toBe(1);
    expect(exposed.blobs.get("demo")?.size).toBe(1);
    expect(exposed.files.get("demo")?.size).toBe(1);
    expect(exposed.versions).toHaveLength(1);
    expect(exposed.idempotency.get("demo")?.size).toBe(1);

    fake.reset();
    expect(fake.state).toBe(exposed);
    expect(exposed.stashes.size).toBe(0);
    expect(exposed.tokens.size).toBe(0);
    expect(exposed.blobs.size).toBe(0);
    expect(exposed.files.size).toBe(0);
    expect(exposed.versions).toHaveLength(0);
    expect(exposed.idempotency.size).toBe(0);
  });
});

describe("stash administration routes", () => {
  it("creates, gets, and keyset-paginates strict stash records", async () => {
    const timestamp = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    const alpha = await request(fake, "/v1/stashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "alpha",
        description: "Alpha stash",
        meta: { owner: "viewer" },
      }),
    });
    expect(alpha.status).toBe(201);
    await expect(alpha.json()).resolves.toEqual({
      name: "alpha",
      description: "Alpha stash",
      meta: { owner: "viewer" },
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    fake.createStash("beta");
    fake.createStash("gamma");

    const first = await request(fake, "/v1/stashes?limit=1");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      stashes: [
        {
          name: "alpha",
          description: "Alpha stash",
          fileCount: 0,
          deletedFileCount: 0,
          lastChangeId: null,
          lastChangeAt: null,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      nextAfter: "alpha",
    });
    const second = await request(fake, "/v1/stashes?limit=1&after=alpha");
    await expect(second.json()).resolves.toMatchObject({
      stashes: [{ name: "beta" }],
      nextAfter: "beta",
    });

    const detail = await request(fake, "/v1/stashes/alpha");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      name: "alpha",
      meta: { owner: "viewer" },
    });
    const duplicate = await request(fake, "/v1/stashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("exists");
  });

  it("validates admin inputs and reports missing stashes without leaking access", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    const missing = await request(fake, "/v1/stashes/missing");
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not-found");

    for (const path of ["/v1/stashes?limit=201", "/v1/stashes?unexpected=true"]) {
      const invalid = await request(fake, path);
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("validation");
    }

    const unauthenticated = await fake.fetch("https://fake.invalid/v1/stashes");
    expect(unauthenticated.status).toBe(401);
    expect(await errorCode(unauthenticated)).toBe("unauthorized");
  });
});

describe("token administration and capabilities", () => {
  it("stores only hashes, lists newest first, and resolves read/write principals", async () => {
    let timestamp = Date.parse("2026-08-26T00:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    fake.createStash("demo");
    fake.createStash("foreign");
    const create = async (label: string, scope: "read" | "write") => {
      const response = await request(fake, "/v1/stashes/demo/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, scope }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as {
        id: string;
        token: string;
        label: string;
        scope: "read" | "write";
        createdAt: string;
      };
    };

    const reader = await create("Reader", "read");
    timestamp += 1;
    const writer = await create("Writer", "write");
    expect(reader.id).toMatch(/^tok_[0-9a-f]{32}$/);
    expect(reader.token).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);
    const storedReader = fake.state.tokens.get(reader.id);
    expect(storedReader?.tokenHash).toBe((await sha256Hex(reader.token)).slice("sha256-".length));
    expect(storedReader?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...fake.state.tokens.values()])).not.toContain(reader.token);

    const listed = await request(fake, "/v1/stashes/demo/tokens");
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { tokens: Array<Record<string, unknown>> };
    expect(listedBody).toEqual({
      tokens: [
        {
          id: writer.id,
          label: "Writer",
          scope: "write",
          createdAt: writer.createdAt,
          revokedAt: null,
          lastUsedAt: null,
        },
        {
          id: reader.id,
          label: "Reader",
          scope: "read",
          createdAt: reader.createdAt,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    });
    expect(JSON.stringify(listedBody)).not.toContain(reader.token);
    expect(JSON.stringify(listedBody)).not.toContain("tokenHash");

    const asToken = (token: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fake.fetch(`https://fake.invalid${path}`, { ...init, headers });
    };
    await expect((await asToken(reader.token, "/v1/me")).json()).resolves.toEqual({
      principal: "stash",
      stash: "demo",
      tokenId: reader.id,
      scope: "read",
    });
    expect((await asToken(reader.token, "/v1/stashes/demo")).status).toBe(200);
    expect((await asToken(reader.token, "/v1/stashes/foreign")).status).toBe(404);
    expect((await asToken(reader.token, "/v1/stashes")).status).toBe(404);
    expect((await asToken(reader.token, "/v1/stashes/demo/tokens")).status).toBe(404);

    const denied = await asToken(reader.token, "/v1/stashes/demo/files/read-only.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "denied", expectedVersion: null }),
    });
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("scope");
    const allowed = await asToken(writer.token, "/v1/stashes/demo/files/write.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "allowed", expectedVersion: null }),
    });
    expect(allowed.status).toBe(201);
  });

  it("revokes immediately and handles missing, foreign, and invalid token operations", async () => {
    const timestamp = Date.parse("2026-08-26T01:00:00.000Z");
    const fake = createFakeStash({ adminToken: ADMIN, now: () => timestamp });
    fake.createStash("demo");
    fake.createStash("foreign");
    const secret = await fake.mintToken("demo", "write");
    const row = [...fake.state.tokens.values()][0];
    if (row === undefined) throw new Error("fixture token was not stored");

    const revoke = await request(fake, `/v1/stashes/demo/tokens/${row.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);
    expect(await revoke.text()).toBe("");
    expect(row.revokedAt).toBe(timestamp);

    const rejected = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(rejected.status).toBe(401);
    expect(await errorCode(rejected)).toBe("unauthorized");
    const list = await request(fake, "/v1/stashes/demo/tokens");
    await expect(list.json()).resolves.toMatchObject({
      tokens: [{ id: row.id, revokedAt: "2026-08-26T01:00:00.000Z" }],
    });

    for (const path of [
      "/v1/stashes/demo/tokens/tok_missing",
      `/v1/stashes/foreign/tokens/${row.id}`,
    ]) {
      const missing = await request(fake, path, { method: "DELETE" });
      expect(missing.status).toBe(404);
      expect(await errorCode(missing)).toBe("not-found");
    }
    const missingCreate = await request(fake, "/v1/stashes/missing/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "read" }),
    });
    expect(missingCreate.status).toBe(404);
    expect((await request(fake, "/v1/stashes/missing/tokens")).status).toBe(404);

    for (const body of [{ scope: "admin" }, { label: "missing scope" }, { scope: "read", x: 1 }]) {
      const invalid = await request(fake, "/v1/stashes/demo/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await errorCode(invalid)).toBe("validation");
    }
  });
});

describe("bearer parsing", () => {
  it("rejects basic, duplicated, and unknown bearer credentials", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    for (const authorization of [
      "Basic abc",
      `Bearer ${ADMIN}, Bearer ${ADMIN}`,
      `Bearer zhs_${"x".repeat(43)}`,
    ]) {
      const response = await fake.fetch("https://fake.invalid/v1/me", {
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthorized");
    }
  });
});

describe("validation and limits", () => {
  it("reuses strict core schemas for unknown fields and query limits", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const unknown = await request(fake, "/v1/stashes/demo/files/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x", expectedVersion: null, unknown: true }),
    });
    expect(unknown.status).toBe(400);
    expect(await errorCode(unknown)).toBe("validation");

    const excessiveLimit = await request(fake, "/v1/stashes/demo/files?limit=201");
    expect(excessiveLimit.status).toBe(400);
    expect(await errorCode(excessiveLimit)).toBe("validation");
  });

  it("distinguishes Unicode, body-byte, request-byte, and key limits", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("demo");
    const put = async (body: unknown, headers: Record<string, string> = {}) =>
      request(fake, "/v1/stashes/demo/files/a.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const malformed = await put({ body: "\ud800", expectedVersion: null });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("body-not-well-formed");

    const tooLarge = await put({ body: "x".repeat(MAX_BODY_BYTES + 1), expectedVersion: null });
    expect(tooLarge.status).toBe(413);
    expect(await errorCode(tooLarge)).toBe("payload-too-large");

    const key = await put(
      { body: "x", expectedVersion: null },
      { "Idempotency-Key": "k".repeat(IDEMPOTENCY_KEY_MAX_CHARS + 1) },
    );
    expect(key.status).toBe(400);
    expect(await errorCode(key)).toBe("validation");

    const emptyKey = await put({ body: "x", expectedVersion: null }, { "Idempotency-Key": "" });
    expect(emptyKey.status).toBe(400);
    expect(await errorCode(emptyKey)).toBe("validation");

    const malformedContentType = await request(fake, "/v1/stashes/demo/files/content-type.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json;" },
      body: JSON.stringify({ body: "x", expectedVersion: null }),
    });
    expect(malformedContentType.status).toBe(400);
    expect(await errorCode(malformedContentType)).toBe("validation");

    const requestTooLarge = await request(fake, "/v1/stashes/demo/files/raw.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(BODY_LIMIT_BYTES + 1),
    });
    expect(requestTooLarge.status).toBe(413);
    expect(await errorCode(requestTooLarge)).toBe("payload-too-large");

    const escaped = await put({
      body: "\u0001".repeat(MAX_BODY_BYTES),
      expectedVersion: null,
    });
    expect(escaped.status).toBe(201);
    await expect(escaped.json()).resolves.toMatchObject({ size: MAX_BODY_BYTES });
  });
});
