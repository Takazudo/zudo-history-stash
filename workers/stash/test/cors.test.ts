import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { request } from "./helpers/app.js";

describe("CORS", () => {
  it("answers an allowed unauthenticated preflight", async () => {
    const response = await request(app, "http://stash.test/v1/me", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization,Content-Type,If-None-Match,Idempotency-Key",
    );
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "ETag,X-Stash-Version,Idempotent-Replayed",
    );
  });

  it("adds no CORS headers for a disallowed origin", async () => {
    const response = await request(app, "http://stash.test/v1/health", {
      headers: { Origin: "https://evil.example" },
    });
    for (const name of response.headers.keys()) {
      expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    }
  });
});
