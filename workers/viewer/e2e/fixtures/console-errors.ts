import { test as base } from "@playwright/test";

export interface AllowedConsoleError {
  pattern: RegExp;
  why: string;
}

interface ConsoleErrorOptions {
  allowedConsoleErrors: AllowedConsoleError[];
  mockLiveEvents: boolean;
}

export const test = base.extend<ConsoleErrorOptions>({
  // Keep this empty by default. Every test-specific exception must include a narrow pattern and why.
  allowedConsoleErrors: [[], { option: true }],
  // Mock suites do not own live transport behavior. Keep one open, abort-bound SSE response so the
  // application can mount normally without weakening each spec's unexpected-request allowlist.
  mockLiveEvents: [true, { option: true }],
  page: async ({ page, allowedConsoleErrors, mockLiveEvents }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (!allowedConsoleErrors.some(({ pattern }) => pattern.test(text))) errors.push(text);
    });

    if (mockLiveEvents) {
      await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        let opened = 0;
        let aborted = 0;
        let canceled = 0;
        const active = new Set<number>();

        Object.defineProperty(window, "__zhsMockLiveEvents", {
          configurable: true,
          value: {
            snapshot: () => ({ opened, aborted, canceled, active: active.size }),
          },
        });

        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const inputUrl =
            input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.href
                : String(input);
          const url = new URL(inputUrl, window.location.href);
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
            .toUpperCase()
            .trim();
          const isEventsRequest =
            method === "GET" && /^\/api\/v1\/stashes\/[^/]+\/events$/u.test(url.pathname);
          if (!isEventsRequest) return nativeFetch(input, init);

          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          const id = ++opened;
          let releaseStream: () => void = () => {
            active.delete(id);
          };
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let released = false;
              const release = () => {
                if (released) return;
                released = true;
                active.delete(id);
                signal?.removeEventListener("abort", handleAbort);
              };
              releaseStream = release;
              const handleAbort = () => {
                if (released) return;
                aborted += 1;
                release();
                controller.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
              };

              active.add(id);
              if (signal?.aborted) handleAbort();
              else signal?.addEventListener("abort", handleAbort, { once: true });
            },
            cancel() {
              canceled += 1;
              releaseStream();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": "text/event-stream; charset=utf-8",
            },
          });
        };
      });
    }

    await use(page);

    if (errors.length > 0) {
      throw new Error(`Unexpected browser console errors:\n${errors.join("\n")}`);
    }
  },
});

export { expect } from "@playwright/test";
