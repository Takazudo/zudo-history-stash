import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "./helpers/app.js";

describe("GET /v1/me", () => {
  beforeEach(resetDatabase);

  it("returns the admin principal", async () => {
    const response = await request(app, "http://stash.test/v1/me", {
      headers: bearer("test-admin"),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ principal: "admin" });
  });

  it("returns the stash principal without its secret", async () => {
    await seedStash("alpha");
    const minted = await mintToken("alpha", "read");
    const response = await request(app, "http://stash.test/v1/me", {
      headers: bearer(minted.token),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      principal: "stash",
      stash: "alpha",
      tokenId: minted.id,
      scope: "read",
      expiresAt: null,
    });
  });

  it("returns the authenticated token expiry", async () => {
    const expiresAt = 2_000_000_000_000;
    await seedStash("expiring");
    const minted = await mintToken("expiring", "write", { expiresAt });
    const response = await request(app, "http://stash.test/v1/me", {
      headers: bearer(minted.token),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      principal: "stash",
      stash: "expiring",
      tokenId: minted.id,
      scope: "write",
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });
});
