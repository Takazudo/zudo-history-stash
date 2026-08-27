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
    expect(limits).toContain("5,000,000 UTF-8 bytes");
    expect(limits).toContain("32 MiB (33,554,432 bytes)");
    expect(limits).toContain("524,288 bytes");
    expect(limits).toContain("private R2");
    expect(limits).toContain("content-addressed orphan");
    expect(limits).toContain("future GC");

    const deferred = section("Deferred");
    expect(deferred).toContain("binary request bodies");
    expect(deferred).toContain("byte-range reads");
    expect(deferred).toContain("download endpoints");
    expect(deferred).not.toContain("R2 spill");
  });
});
