import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import type { Env } from "../src/env.js";
import { bearer, request } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

afterEach(() => vi.restoreAllMocks());

describe("error logging", () => {
  it("never writes request body text to console lines", async () => {
    const secretBody = "body-that-must-never-be-logged";
    const calls: unknown[][] = [];
    for (const method of ["debug", "error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => calls.push(args));
    }
    const base = createTestEnv().env;
    const bindings: Env = {
      ...base,
      DB: new Proxy(base.DB, {
        get() {
          throw new Error("database unavailable");
        },
      }),
    };
    const response = await request(
      app,
      "http://stash.test/v1/me",
      {
        method: "POST",
        headers: { ...bearer(`zhs_${"x".repeat(43)}`), "Content-Type": "text/plain" },
        body: secretBody,
      },
      bindings,
    );
    expect(response.status).toBe(401);
    expect(JSON.stringify(calls)).not.toContain(secretBody);
  });
});
