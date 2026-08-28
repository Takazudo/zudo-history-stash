export function isLoopbackViewerUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  );
}

export function requireLoopbackViewerUrl(value: string): string {
  if (!isLoopbackViewerUrl(value)) {
    throw new Error("chromium-live may mutate only a loopback dev:full origin");
  }
  return value;
}

export function resolveViewerBaseUrl(
  externalBaseUrl: string | undefined,
  liveHarness: boolean,
): string {
  const value =
    externalBaseUrl ?? (liveHarness ? "http://localhost:8787" : "http://127.0.0.1:5173");
  return liveHarness ? requireLoopbackViewerUrl(value) : value;
}
