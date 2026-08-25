import { describe, expect, it, vi } from "vitest";
import { createViewerStashClient } from "./stash-client-provider.js";

describe("createViewerStashClient", () => {
  it("uses the real SDK against /api with the token and request signal", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ principal: "admin" }),
    );
    const client = createViewerStashClient("zhs_admin", vi.fn(), fetcher);
    const controller = new AbortController();

    const result = await client.me({ signal: controller.signal });

    expect(result).toEqual({ ok: true, value: { principal: "admin" } });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBe("/api/v1/me");
    expect(init?.headers).toEqual({ Authorization: "Bearer zhs_admin" });
    expect(init?.signal).toBe(controller.signal);
  });

  it("notifies the provider when the API returns 401", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () =>
      Response.json({ error: { code: "unauthorized", message: "Expired" } }, { status: 401 }),
    );
    const client = createViewerStashClient("zhs_expired", onUnauthorized, fetcher);

    const result = await client.me();

    expect(result.ok).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps /me failures in the result channel expected by the app shell", async () => {
    const client = createViewerStashClient("zhs_admin", vi.fn(), async () =>
      Response.json({ error: { code: "internal", message: "D1 unavailable" } }, { status: 503 }),
    );

    await expect(client.me()).resolves.toEqual({
      ok: false,
      error: { status: 503, code: "internal", message: "D1 unavailable" },
    });
  });
});
