import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { request } from "./helpers/app.js";

describe("GET /v1/health", () => {
  it("is open and carries the smoke-test marker", async () => {
    const response = await request(app, "http://stash.test/v1/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "zudo-history-stash",
      marker: "ZHS_HEALTH_OK",
    });
  });
});
