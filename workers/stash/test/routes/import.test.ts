import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";

const url = "http://example.test/v1/stashes/route-import/import";

function body(overrides: Record<string, unknown> = {}) {
  return {
    path: "history.txt",
    expectedVersion: null,
    versions: [
      {
        kind: "put",
        body: "route body",
        author: "route author",
        message: "route message",
        meta: { source: "route" },
        createdAt: 1_000,
      },
    ],
    ...overrides,
  };
}

async function post(payload: unknown, token = "test-admin") {
  return request(app, url, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash("route-import");
});

describe("POST stash import", () => {
  it("returns the bounded 201 response shape for an administrator", async () => {
    const response = await post(body());
    expect(response.status).toBe(201);
    const json = await response.json<Record<string, unknown>>();
    expect(json).toEqual({
      path: "history.txt",
      headVersion: 1,
      firstChangeId: expect.any(Number),
    });
    expect(json).not.toHaveProperty("versions");
    expect(JSON.stringify(json)).not.toContain("route body");
  });

  it("conceals the admin route from stash tokens", async () => {
    const token = await mintToken("route-import", "write");
    const response = await post(body(), token.token);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "The requested resource was not found." },
    });
  });

  it("returns generic 400 validation errors without echoing request bodies", async () => {
    const marker = "ZHS_IMPORT_BODY_MUST_NOT_BE_ECHOED";
    const response = await post(
      body({
        unexpected: marker,
        versions: [{ kind: "put", body: marker, createdAt: 1_000 }],
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toEqual({
      error: { code: "validation", message: "Invalid import input." },
    });
  });

  it("maps store-only timestamp validation to the same body-safe 400 shape", async () => {
    const marker = "ZHS_FUTURE_IMPORT_BODY_MUST_NOT_BE_ECHOED";
    const response = await post(
      body({ versions: [{ kind: "put", body: marker, createdAt: Date.now() + 60_000 }] }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "validation" } });
  });
});
