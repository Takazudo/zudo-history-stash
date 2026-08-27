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
        "x-stash-client-id": "tab-viewer-1",
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
      "x-stash-client-id",
    ]);
    expect(headers.get("x-stash-client-id")).toBe("tab-viewer-1");
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

  it.each(["binding", "base-url"] as const)(
    "passes %s SSE bytes through before close and propagates abort plus body cancellation",
    async (mode) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let streamClosed = false;
      const bodyCancelled = vi.fn();
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          cancel(reason) {
            bodyCancelled(reason);
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        },
      );
      const forwardedSignal: { current: AbortSignal | null } = { current: null };
      const upstreamFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwardedSignal.current = init?.signal ?? null;
        return upstream;
      });
      const env: ViewerEnv =
        mode === "binding"
          ? { ASSETS: assets(), STASH: { fetch: upstreamFetch } }
          : { ASSETS: assets(), STASH_BASE_URL: "https://stash.example/" };
      if (mode === "base-url") vi.stubGlobal("fetch", upstreamFetch);
      const downstream = new AbortController();
      const downstreamRequest = new Request(
        "https://viewer.example/api/v1/stashes/notes/events?since=7",
        {
          headers: {
            Authorization: "Bearer zhs_live",
            "X-Stash-Client-Id": "tab-stream",
          },
          signal: downstream.signal,
        },
      );

      const response = await handleViewerRequest(downstreamRequest, env);

      expect(response).toBe(upstream);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const [input, init] = upstreamFetch.mock.calls[0] ?? [];
      expect(input).toBe(
        mode === "binding"
          ? "https://stash.internal/v1/stashes/notes/events?since=7"
          : "https://stash.example/v1/stashes/notes/events?since=7",
      );
      expect(new Headers(init?.headers).get("x-stash-client-id")).toBe("tab-stream");
      expect(forwardedSignal.current).toBe(downstreamRequest.signal);

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected a streaming response body");
      streamController.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("event: ready\ndata: {}\n\n");
      expect(first.done).toBe(false);
      expect(streamClosed).toBe(false);

      downstream.abort("viewer navigated");
      expect(forwardedSignal.current?.aborted).toBe(true);
      await reader.cancel("consumer closed");
      expect(bodyCancelled).toHaveBeenCalledWith("consumer closed");
      streamClosed = true;
    },
  );

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
