import {
  BODY_LIMIT_BYTES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_BODY_BYTES,
  ROUTES,
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
  listStashes: { method: "GET", path: "/v1/stashes" },
  getStash: { method: "GET", path: "/v1/stashes/demo" },
  createToken: { method: "POST", path: "/v1/stashes/demo/tokens" },
  listTokens: { method: "GET", path: "/v1/stashes/demo/tokens" },
  revokeToken: { method: "DELETE", path: "/v1/stashes/demo/tokens/tok_1" },
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
    const token = fake.mintToken("demo", "write");

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
