// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { handleViewerRequest, type ViewerEnv } from "./worker.js";

function assets(): ViewerEnv["ASSETS"] {
  return { fetch: vi.fn(async () => new Response("asset")) };
}

describe("viewer proxy", () => {
  it("forwards only allowed request data and passes the response through", async () => {
    let forwardedInput: RequestInfo | URL | undefined;
    let forwardedInit: RequestInit | undefined;
    const stash = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        forwardedInput = input;
        forwardedInit = init;
        return Response.json({ ok: true }, { headers: { ETag: `"v1-hash"` } });
      }),
    };
    const request = new Request("https://viewer.example/api/v1/stashes/a/files/x?version=1", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "if-none-match": `"v1-hash"`,
        "idempotency-key": "request-1",
        cookie: "must-not-forward=1",
        "x-extra": "no",
      },
      body: '{"value":1}',
    });

    const response = await handleViewerRequest(request, { ASSETS: assets(), STASH: stash });
    expect(forwardedInput).toBe("https://stash.internal/v1/stashes/a/files/x?version=1");
    expect(forwardedInit?.method).toBe("POST");
    expect(forwardedInit?.signal).toBe(request.signal);
    const headers = new Headers(forwardedInit?.headers);
    expect([...headers.keys()]).toEqual([
      "authorization",
      "content-type",
      "idempotency-key",
      "if-none-match",
    ]);
    expect(await new Response(forwardedInit?.body).text()).toBe('{"value":1}');
    expect(response.headers.get("etag")).toBe(`"v1-hash"`);
  });

  it("preserves a service-binding rate-limit response body and Retry-After header", async () => {
    const body = '{"error":{"code":"rate-limited","message":"The request was rate limited."}}';
    const upstream = new Response(body, {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
    const stash = { fetch: vi.fn(async () => upstream) };

    const response = await handleViewerRequest(
      new Request("https://viewer.example/api/v1/me", {
        headers: { Authorization: "Bearer zhs_rate_limited" },
      }),
      { ASSETS: assets(), STASH: stash },
    );

    expect(stash.fetch).toHaveBeenCalledTimes(1);
    expect(response).toBe(upstream);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe(body);
  });

  it.each(["/api", "/api/health", "/api/v1", "/api/v2/health"])(
    "rejects non-contract API path %s",
    async (path) => {
      const stash = { fetch: vi.fn(async () => new Response()) };
      const response = await handleViewerRequest(new Request(`https://viewer.example${path}`), {
        ASSETS: assets(),
        STASH: stash,
      });
      expect(response.status).toBe(404);
      expect(stash.fetch).not.toHaveBeenCalled();
    },
  );

  it("requires a configured upstream for API requests", async () => {
    await expect(
      handleViewerRequest(new Request("https://viewer.example/api/v1/health"), {
        ASSETS: assets(),
      }),
    ).rejects.toThrow("requires either STASH or STASH_BASE_URL");
  });

  it("serves non-API requests from static assets", async () => {
    const binding = assets();
    const request = new Request("https://viewer.example/s/example");
    expect(await (await handleViewerRequest(request, { ASSETS: binding })).text()).toBe("asset");
    expect(binding.fetch).toHaveBeenCalledWith(request);
  });
});
