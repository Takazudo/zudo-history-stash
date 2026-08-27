import { describe, expect, it } from "vitest";
import {
  isLoopbackViewerUrl,
  requireLoopbackViewerUrl,
  resolveViewerBaseUrl,
} from "../../e2e/live-safety.js";

describe("live browser origin safety", () => {
  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
    "https://localhost:8787",
  ])("accepts the loopback origin %s", (url) => {
    expect(isLoopbackViewerUrl(url)).toBe(true);
    expect(requireLoopbackViewerUrl(url)).toBe(url);
  });

  it.each(["https://viewer.example.com", "http://192.0.2.1:8787", "not-a-url"])(
    "rejects the non-loopback origin %s before a live test can send requests",
    (url) => {
      expect(isLoopbackViewerUrl(url)).toBe(false);
      expect(() => requireLoopbackViewerUrl(url)).toThrow(/loopback dev:full origin/u);
    },
  );

  it("fences an externally supplied PW_BASE_URL whenever PW_LIVE is enabled", () => {
    expect(resolveViewerBaseUrl(undefined, true)).toBe("http://localhost:8787");
    expect(resolveViewerBaseUrl("http://127.0.0.1:8787", true)).toBe("http://127.0.0.1:8787");
    expect(() => resolveViewerBaseUrl("https://viewer.example.com", true)).toThrow(
      /loopback dev:full origin/u,
    );
    expect(resolveViewerBaseUrl("https://viewer.example.com", false)).toBe(
      "https://viewer.example.com",
    );
  });
});
