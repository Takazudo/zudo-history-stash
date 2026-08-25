import { applyPatch, formatPatch, structuredPatch } from "diff";
import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff.js";
import { roundTripFixtures } from "./diff.fixtures.js";

const labels = { fromLabel: "a/docs/example.md@v3", toLabel: "b/docs/example.md@v5" };
const encoder = new TextEncoder();

describe("computeDiff", () => {
  it.each(roundTripFixtures)("round-trips $name", ({ fromText, toText }) => {
    const result = computeDiff({ fromText, toText, ...labels });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected a ready diff");
    expect(result.truncated).toBe(false);
    expect(applyPatch(fromText, result.unified)).toBe(toText);
  });

  it("short-circuits identical text", () => {
    expect(computeDiff({ fromText: "同じ\r\n", toText: "同じ\r\n", ...labels })).toEqual({
      state: "same",
    });
  });

  it("uses one structured patch for the hunks and formatted output", () => {
    const fromText = "one\ntwo\nthree\n";
    const toText = "one\nchanged\nthree\n";
    const patch = structuredPatch(
      labels.fromLabel,
      labels.toLabel,
      fromText,
      toText,
      undefined,
      undefined,
      { context: 1, timeout: 2_000, maxEditLength: 50_000 },
    );
    if (patch === undefined) throw new Error("fixture unexpectedly exceeded complexity limits");

    const result = computeDiff({ fromText, toText, context: 1, ...labels });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected a ready diff");
    expect(result.hunks).toEqual(patch.hunks);
    expect(result.unified).toBe(formatPatch(patch));
  });

  it("preserves CRLF bytes and no-newline markers", () => {
    const crlf = computeDiff({
      fromText: "first\r\nsecond\r\n",
      toText: "first\r\nthird\r\n",
      ...labels,
    });
    if (crlf.state !== "ready") throw new Error("expected a ready diff");
    expect(crlf.hunks[0]?.lines).toEqual([" first\r", "-second\r", "+third\r"]);
    expect(applyPatch("first\r\nsecond\r\n", crlf.unified)).toBe("first\r\nthird\r\n");

    const noTrailingNewline = computeDiff({ fromText: "before", toText: "after", ...labels });
    if (noTrailingNewline.state !== "ready") throw new Error("expected a ready diff");
    expect(
      noTrailingNewline.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith("\\")),
    ).toEqual(["\\ No newline at end of file", "\\ No newline at end of file"]);
  });

  it("counts added and removed hunk lines", () => {
    const result = computeDiff({
      fromText: "alpha\nbravo\ncharlie\ndelta\n",
      toText: "alpha\nbeta\ncharlie\necho\nfoxtrot\n",
      ...labels,
    });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected a ready diff");
    expect(result.stats).toEqual({ added: 3, removed: 2 });
  });

  it("enforces the byte cap per side using exact UTF-8 byte lengths", () => {
    expect(computeDiff({ fromText: "界界", toText: "界", maxBytes: 5, ...labels })).toEqual({
      state: "oversized",
      reason: "bytes",
    });
    expect(computeDiff({ fromText: "界", toText: "界界", maxBytes: 5, ...labels })).toEqual({
      state: "oversized",
      reason: "bytes",
    });
    expect(computeDiff({ fromText: "界", toText: "海", maxBytes: 3, ...labels }).state).toBe(
      "ready",
    );
  });

  it("maps jsdiff 9 maxEditLength aborts to complexity", () => {
    const options = { context: 3, timeout: 2_000, maxEditLength: 1 };
    expect(
      structuredPatch("a", "b", "before\n", "after\n", undefined, undefined, options),
    ).toBeUndefined();
    expect(computeDiff({ fromText: "before\n", toText: "after\n", ...labels, ...options })).toEqual(
      { state: "oversized", reason: "complexity" },
    );
  });

  it("maps jsdiff 9 timeout aborts to complexity", () => {
    const fromText = Array.from({ length: 20_000 }, (_, index) => `old${index}`).join("\n");
    const toText = Array.from({ length: 20_000 }, (_, index) => `new${index}`).join("\n");
    const options = { context: 3, timeout: 0, maxEditLength: 50_000 };
    expect(
      structuredPatch("a", "b", fromText, toText, undefined, undefined, options),
    ).toBeUndefined();
    expect(
      computeDiff({ fromText, toText, ...labels, timeoutMs: 0, maxEditLength: 50_000 }),
    ).toEqual({ state: "oversized", reason: "complexity" });
  });

  it("truncates only at a complete UTF-8 line boundary", () => {
    const fromText = "alpha\n古い行\nomega\n";
    const toText = "alpha\n新しい行\nomega\n";
    const full = computeDiff({ fromText, toText, ...labels });
    if (full.state !== "ready") throw new Error("expected a ready diff");
    const lines = full.unified.match(/.*\n/g);
    if (lines === null || lines.length < 6) throw new Error("expected a multiline patch");
    const expected = lines.slice(0, 5).join("");
    const maxUnifiedBytes = encoder.encode(expected).byteLength;

    const result = computeDiff({ fromText, toText, ...labels, maxUnifiedBytes });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected a ready diff");
    expect(result).toMatchObject({ truncated: true, unified: expected });
    expect(full.unified.startsWith(result.unified)).toBe(true);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(result.unified))).toBe(
      result.unified,
    );
    expect(encoder.encode(result.unified).byteLength).toBeLessThanOrEqual(maxUnifiedBytes);
  });

  it("does not truncate when the byte cap exactly fits", () => {
    const full = computeDiff({ fromText: "old\n", toText: "new\n", ...labels });
    if (full.state !== "ready") throw new Error("expected a ready diff");

    expect(
      computeDiff({
        fromText: "old\n",
        toText: "new\n",
        ...labels,
        maxUnifiedBytes: encoder.encode(full.unified).byteLength,
      }),
    ).toEqual(full);
  });

  it("returns an empty line-safe prefix when the unified byte cap is zero", () => {
    const result = computeDiff({
      fromText: "old\n",
      toText: "new\n",
      ...labels,
      maxUnifiedBytes: 0,
    });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected a ready diff");
    expect(result.unified).toBe("");
    expect(result.truncated).toBe(true);
  });
});
