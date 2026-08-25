import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import type { Env } from "../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

describe("bearer authentication and route capabilities", () => {
  beforeEach(resetDatabase);

  it("rejects an absent bearer token", async () => {
    await expectCode(await request(app, "http://stash.test/v1/me"), 401, "unauthorized");
  });

  it("rejects Basic authentication", async () => {
    await expectCode(
      await request(app, "http://stash.test/v1/me", { headers: { Authorization: "Basic abc" } }),
      401,
      "unauthorized",
    );
  });

  it("rejects two Authorization headers", async () => {
    const headers = new Headers();
    headers.append("Authorization", "Bearer test-admin");
    headers.append("Authorization", "Bearer test-admin");
    await expectCode(
      await request(app, "http://stash.test/v1/me", { headers }),
      401,
      "unauthorized",
    );
  });

  it("rejects an unknown stash token", async () => {
    await expectCode(
      await request(app, "http://stash.test/v1/me", { headers: bearer(`zhs_${"x".repeat(43)}`) }),
      401,
      "unauthorized",
    );
  });

  it("rejects a revoked token", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "write");
    await createTestEnv()
      .env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), minted.id)
      .run();
    await expectCode(
      await request(app, "http://stash.test/v1/me", { headers: bearer(minted.token) }),
      401,
      "unauthorized",
    );
  });

  it("returns 403 when a read token reaches a write-capability route", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "read");
    await expectCode(
      await request(app, "http://stash.test/v1/stashes/alpha/files/a.txt", {
        method: "PUT",
        headers: bearer(minted.token),
      }),
      403,
      "scope",
    );
  });

  it("allows a read token on the read-capability candidate-diff POST", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "read");
    const response = await request(app, "http://stash.test/v1/stashes/alpha/diff/a.txt", {
      method: "POST",
      headers: bearer(minted.token),
    });
    expect(response.status).toBe(400);
  });

  it("hides admin routes from stash principals", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "write");
    await expectCode(
      await request(app, "http://stash.test/v1/stashes", { headers: bearer(minted.token) }),
      404,
      "not-found",
    );
  });

  it("hides another stash from a stash principal", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "write");
    await expectCode(
      await request(app, "http://stash.test/v1/stashes/beta/files", {
        headers: bearer(minted.token),
      }),
      404,
      "not-found",
    );
  });

  it("allows admin and stash principals through their capability gates", async () => {
    const admin = await request(app, "http://stash.test/v1/stashes", {
      headers: bearer("test-admin"),
    });
    expect(admin.status).toBe(200);

    await seedStash("alpha");
    const minted = await mintToken("alpha", "write");
    const stash = await request(app, "http://stash.test/v1/stashes/alpha/files", {
      headers: bearer(minted.token),
    });
    expect(stash.status).toBe(200);
  });

  it("fails closed when D1 throws", async () => {
    const base = createTestEnv().env;
    const throwingDb = new Proxy(base.DB, {
      get() {
        throw new Error("database unavailable");
      },
    });
    const bindings: Env = { ...base, DB: throwingDb };
    await expectCode(
      await request(
        app,
        "http://stash.test/v1/me",
        { headers: bearer(`zhs_${"x".repeat(43)}`) },
        bindings,
      ),
      401,
      "unauthorized",
    );
  });

  it("touches last_used_at through waitUntil", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "read");
    await request(app, "http://stash.test/v1/me", { headers: bearer(minted.token) });
    const row = await createTestEnv()
      .env.DB.prepare("SELECT last_used_at FROM tokens WHERE id = ?")
      .bind(minted.id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeTypeOf("number");
  });
});
