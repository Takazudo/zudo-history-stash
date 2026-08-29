import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import apiReference from "../../../../docs/api.md?raw";

function section(title: string): string {
  const marker = `## ${title}`;
  const start = apiReference.indexOf(marker);
  if (start < 0) throw new Error(`Missing API reference section: ${title}`);
  const next = apiReference.indexOf("\n## ", start + marker.length);
  return apiReference.slice(start, next < 0 ? undefined : next);
}

describe("API reference route coverage", () => {
  for (const route of ROUTES) {
    it(`documents ${route.method} ${route.template}`, () => {
      expect(apiReference).toContain(`### \`${route.method} ${route.template}\``);
    });
  }

  it("pins the raised limits, storage tiers, orphan caveat, and deferred work", () => {
    const limits = section("Limits and storage tiers");
    const normalizedLimits = limits.replace(/\s+/gu, " ");
    expect(normalizedLimits).toContain("5,000,000 UTF-8 bytes");
    expect(normalizedLimits).toContain("32 MiB (33,554,432 bytes)");
    expect(normalizedLimits).toContain("524,288 bytes");
    expect(normalizedLimits).toContain("private R2");
    expect(normalizedLimits).toContain("content-addressed orphan");
    expect(normalizedLimits).toContain("future GC");

    const deferred = section("Deferred");
    expect(deferred).not.toContain("binary request bodies");
    expect(deferred).not.toContain("byte-range reads");
    expect(deferred).not.toContain("download endpoints");
    expect(deferred).not.toContain("R2 spill");
  });

  it("documents the fetch-only live-events framing, handoff, recovery, and cost contract", () => {
    const live = section("Live change events");
    for (const phrase of [
      "Server-Sent Events",
      "EventSource",
      "Authorization",
      "subscribes to the stash Durable Object first",
      "ready.checkpoint",
      "latest live ID",
      "exact ID",
      "Commit and change-set events are",
      'reason: "lifetime" | "replay-limit" | "shutdown"',
      ": ping",
      "token-expiry boundary",
      "X-Stash-Client-Id",
      "non-hibernating",
      "duration continuously",
    ]) {
      expect(live).toContain(phrase);
    }
  });
});
