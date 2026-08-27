import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Env } from "../../src/env.js";
import { bearer, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const STASH = "route-lifecycle";
const NOW = 1_900_000_000_000;
const app = createApp({ now: () => NOW });

function lifecycleRequest(path: string, method: "DELETE" | "POST", token = "test-admin") {
  return request(app, `http://example.test${path}`, {
    method,
    headers: bearer(token),
  });
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("stash lifecycle routes", () => {
  it("handles DELETE /v1/stashes/:stash and returns its pinned timestamps", async () => {
    const response = await lifecycleRequest(`/v1/stashes/${STASH}`, "DELETE");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: STASH,
      deletedAt: new Date(NOW).toISOString(),
      revokedTokens: 0,
      restoreUntil: new Date(NOW + 30 * 86_400_000).toISOString(),
    });

    const again = await lifecycleRequest(`/v1/stashes/${STASH}`, "DELETE");
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: "already-deleted" } });
  });

  it("handles POST /v1/stashes/:stash/restore and rejects non-admin principals", async () => {
    expect((await lifecycleRequest(`/v1/stashes/${STASH}`, "DELETE")).status).toBe(200);
    const response = await lifecycleRequest(`/v1/stashes/${STASH}/restore`, "POST");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: STASH,
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    });

    const bindings: Env = createTestEnv().env;
    const unauthorized = await request(
      app,
      `http://example.test/v1/stashes/${STASH}/restore`,
      { method: "POST", headers: bearer("not-admin") },
      bindings,
    );
    expect(unauthorized.status).toBe(401);
  });
});
