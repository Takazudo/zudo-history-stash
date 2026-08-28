import { describe, expect, it } from "vitest";
import { buildDiffModel } from "./index.js";
import type { DiffCell, DiffModel, DiffModelRow } from "./diff-model.js";
import { computeDiff } from "./diff.js";
import type { DiffHunk } from "./diff.js";
import { roundTripFixtures } from "./diff.fixtures.js";
import { DIFF_MAX_INTRALINE_CHARS, DIFF_MAX_INTRALINE_LENGTH } from "./limits.js";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const labels = { fromLabel: "a/example.txt", toLabel: "b/example.txt" };

function hunk(lines: string[], options: Partial<Omit<DiffHunk, "lines">> = {}): DiffHunk {
  return {
    oldStart: 1,
    oldLines: lines.filter((line) => line.startsWith("-") || line.startsWith(" ")).length,
    newStart: 1,
    newLines: lines.filter((line) => line.startsWith("+") || line.startsWith(" ")).length,
    lines,
    ...options,
  };
}

function codeRows(model: DiffModel): Exclude<DiffModelRow, { kind: "hunk" | "marker" }>[] {
  return model.rows.filter(
    (row): row is Exclude<DiffModelRow, { kind: "hunk" | "marker" }> =>
      row.kind !== "hunk" && row.kind !== "marker",
  );
}

function cells(model: DiffModel): DiffCell[] {
  const result: DiffCell[] = [];
  for (const row of codeRows(model)) {
    if (row.left !== null) result.push(row.left);
    if (row.right !== null) result.push(row.right);
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  const record = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(record)) deepFreeze(record[key]);
  return Object.freeze(value);
}

describe("buildDiffModel", () => {
  it("models pure additions with same display segments and no intraline marks", () => {
    const model = buildDiffModel([
      hunk(["+alpha", "+beta"], { oldStart: 0, oldLines: 0, newStart: 4 }),
    ]);

    expect(codeRows(model)).toEqual([
      {
        kind: "added",
        left: null,
        right: { lineNumber: 4, text: "alpha", segments: [{ kind: "same", text: "alpha" }] },
      },
      {
        kind: "added",
        left: null,
        right: { lineNumber: 5, text: "beta", segments: [{ kind: "same", text: "beta" }] },
      },
    ]);
    expect(model.stats).toEqual({ added: 2, removed: 0 });
    expect(model.intralineSkipped).toBe(0);
  });

  it("models pure removals with exact old-side line numbers", () => {
    const model = buildDiffModel([
      hunk(["-alpha", "-beta"], { oldStart: 8, newStart: 0, newLines: 0 }),
    ]);

    expect(codeRows(model)).toEqual([
      {
        kind: "removed",
        left: { lineNumber: 8, text: "alpha", segments: [{ kind: "same", text: "alpha" }] },
        right: null,
      },
      {
        kind: "removed",
        left: { lineNumber: 9, text: "beta", segments: [{ kind: "same", text: "beta" }] },
        right: null,
      },
    ]);
    expect(model.stats).toEqual({ added: 0, removed: 2 });
  });

  it("pairs a 2-vs-3 changed block index-wise and leaves one added row", () => {
    const model = buildDiffModel([
      hunk(["-old one", "-old two", "+new one", "+new two", "+new three"]),
    ]);

    expect(codeRows(model).map((row) => row.kind)).toEqual([
      "changed-pair",
      "changed-pair",
      "added",
    ]);
    expect(codeRows(model).map((row) => [row.left?.lineNumber, row.right?.lineNumber])).toEqual([
      [1, 1],
      [2, 2],
      [undefined, 3],
    ]);
  });

  it("models a context-only hunk on both sides", () => {
    const model = buildDiffModel([hunk([" alpha", " beta"], { oldStart: 3, newStart: 7 })]);

    expect(codeRows(model)).toEqual([
      {
        kind: "context",
        left: { lineNumber: 3, text: "alpha", segments: [{ kind: "same", text: "alpha" }] },
        right: { lineNumber: 7, text: "alpha", segments: [{ kind: "same", text: "alpha" }] },
      },
      {
        kind: "context",
        left: { lineNumber: 4, text: "beta", segments: [{ kind: "same", text: "beta" }] },
        right: { lineNumber: 8, text: "beta", segments: [{ kind: "same", text: "beta" }] },
      },
    ]);
  });

  it("preserves hunk rows and resets counters for multiple hunks", () => {
    const model = buildDiffModel([
      hunk([" first", "-old", "+new"], { oldStart: 2, newStart: 5 }),
      hunk([" later"], { oldStart: 20, newStart: 30 }),
    ]);

    expect(model.rows).toMatchObject([
      {
        kind: "hunk",
        header: "@@ -2,2 +5,2 @@",
        oldStart: 2,
        oldLines: 2,
        newStart: 5,
        newLines: 2,
      },
      { kind: "context", left: { lineNumber: 2 }, right: { lineNumber: 5 } },
      { kind: "changed-pair", left: { lineNumber: 3 }, right: { lineNumber: 6 } },
      {
        kind: "hunk",
        header: "@@ -20,1 +30,1 @@",
        oldStart: 20,
        oldLines: 1,
        newStart: 30,
        newLines: 1,
      },
      { kind: "context", left: { lineNumber: 20 }, right: { lineNumber: 30 } },
    ]);
    expect(model.unified.filter((row) => row.kind === "hunk")).toEqual([
      { kind: "hunk", header: "@@ -2,2 +5,2 @@" },
      { kind: "hunk", header: "@@ -20,1 +30,1 @@" },
    ]);
  });

  it("attaches an old-only no-newline marker without changing counters", () => {
    const model = buildDiffModel([
      hunk(["-before", NO_NEWLINE_MARKER, "+after"], { oldStart: 11, newStart: 21 }),
    ]);

    expect(codeRows(model)).toMatchObject([
      {
        kind: "changed-pair",
        left: {
          lineNumber: 11,
          text: "before",
          noNewline: true,
        },
        right: {
          lineNumber: 21,
          text: "after",
        },
      },
    ]);
  });

  it("attaches a new-only no-newline marker without changing counters", () => {
    const model = buildDiffModel([
      hunk(["-before", "+after", NO_NEWLINE_MARKER], { oldStart: 11, newStart: 21 }),
    ]);

    const row = codeRows(model)[0];
    expect(row).toMatchObject({
      kind: "changed-pair",
      left: { lineNumber: 11 },
      right: { lineNumber: 21, noNewline: true },
    });
    if (row?.kind !== "changed-pair") throw new Error("expected a changed pair");
    expect(row.left.noNewline).toBeUndefined();
  });

  it("pairs across jsdiff's two no-newline markers and marks both cells", () => {
    const model = buildDiffModel([
      hunk(["-before", NO_NEWLINE_MARKER, "+after", NO_NEWLINE_MARKER], {
        oldStart: 11,
        newStart: 21,
      }),
    ]);

    expect(model.rows.filter((row) => row.kind === "marker")).toEqual([]);
    expect(codeRows(model)).toMatchObject([
      {
        kind: "changed-pair",
        left: { lineNumber: 11, noNewline: true },
        right: { lineNumber: 21, noNewline: true },
      },
    ]);
    expect(model.unified).toMatchObject([
      { kind: "hunk" },
      { kind: "removed", oldLine: 11, newLine: null, noNewline: true },
      { kind: "added", oldLine: null, newLine: 21, noNewline: true },
    ]);
  });

  it("marks both context cells for a context no-newline marker", () => {
    const model = buildDiffModel([hunk([" same", NO_NEWLINE_MARKER])]);

    expect(codeRows(model)).toMatchObject([
      {
        kind: "context",
        left: { lineNumber: 1, noNewline: true },
        right: { lineNumber: 1, noNewline: true },
      },
    ]);
    expect(model.unified).toMatchObject([{ kind: "hunk" }, { kind: "context", noNewline: true }]);
  });

  it("keeps genuinely unknown lines as side-aware markers", () => {
    const old = buildDiffModel([hunk(["-first", "? old metadata", "-second"])]);
    const next = buildDiffModel([hunk(["+first", "? new metadata", "+second"])]);
    const consecutive = buildDiffModel([
      hunk(["-first", "? old metadata 1", "? old metadata 2", "-second"]),
    ]);
    const ambiguous = buildDiffModel([hunk(["-first", "? transition", "+second"])]);

    expect(old.rows.find((row) => row.kind === "marker")).toEqual({
      kind: "marker",
      text: "? old metadata",
      side: "old",
    });
    expect(next.rows.find((row) => row.kind === "marker")).toEqual({
      kind: "marker",
      text: "? new metadata",
      side: "new",
    });
    expect(consecutive.rows.filter((row) => row.kind === "marker")).toEqual([
      { kind: "marker", text: "? old metadata 1", side: "old" },
      { kind: "marker", text: "? old metadata 2", side: "old" },
    ]);
    expect(ambiguous.rows.find((row) => row.kind === "marker")).toEqual({
      kind: "marker",
      text: "? transition",
      side: "both",
    });
  });

  it("uses character segments for CJK pairs", () => {
    const model = buildDiffModel([hunk(["-猫です", "+犬です"])]);

    expect(codeRows(model)).toEqual([
      {
        kind: "changed-pair",
        left: {
          lineNumber: 1,
          text: "猫です",
          segments: [
            { kind: "removed", text: "猫" },
            { kind: "same", text: "です" },
          ],
        },
        right: {
          lineNumber: 1,
          text: "犬です",
          segments: [
            { kind: "added", text: "犬" },
            { kind: "same", text: "です" },
          ],
        },
      },
    ]);
  });

  it("uses character segments when either side has no whitespace", () => {
    const model = buildDiffModel([hunk(["-abcd", "+abXd"])]);

    expect(codeRows(model)).toMatchObject([
      {
        kind: "changed-pair",
        left: {
          segments: [
            { kind: "same", text: "ab" },
            { kind: "removed", text: "c" },
            { kind: "same", text: "d" },
          ],
        },
        right: {
          segments: [
            { kind: "same", text: "ab" },
            { kind: "added", text: "X" },
            { kind: "same", text: "d" },
          ],
        },
      },
    ]);
  });

  it("diffs at the exact per-pair cap and skips one character beyond it", () => {
    const withinOld = `${"a".repeat(DIFF_MAX_INTRALINE_LENGTH - 1)}x`;
    const withinNew = `${"a".repeat(DIFF_MAX_INTRALINE_LENGTH - 1)}y`;
    const overOld = `${"a".repeat(DIFF_MAX_INTRALINE_LENGTH)}x`;
    const overNew = `${"a".repeat(DIFF_MAX_INTRALINE_LENGTH)}y`;

    const within = buildDiffModel([hunk([`-${withinOld}`, `+${withinNew}`])]);
    const over = buildDiffModel([hunk([`-${overOld}`, `+${overNew}`])]);

    expect(within.intralineSkipped).toBe(0);
    expect(
      cells(within)
        .flatMap((cell) => cell.segments)
        .some((segment) => segment.kind !== "same"),
    ).toBe(true);
    expect(over.intralineSkipped).toBe(1);
    expect(cells(over).map((cell) => cell.segments)).toEqual([
      [{ kind: "same", text: overOld }],
      [{ kind: "same", text: overNew }],
    ]);
  });

  it("spends the aggregate intraline budget deterministically", () => {
    const oldText = `${"a".repeat(798)}x `;
    const newText = `${"a".repeat(798)}y `;
    const pairCountAtBudget = DIFF_MAX_INTRALINE_CHARS / (oldText.length + newText.length);
    const pairCount = pairCountAtBudget + 3;
    const lines = [
      ...Array.from({ length: pairCount }, () => `-${oldText}`),
      ...Array.from({ length: pairCount }, () => `+${newText}`),
    ];

    const first = buildDiffModel([hunk(lines)]);
    const second = buildDiffModel([hunk(lines)]);

    expect(Number.isInteger(pairCountAtBudget)).toBe(true);
    expect(first.intralineSkipped).toBe(3);
    expect(first).toEqual(second);
    const finalRow = codeRows(first).at(-1);
    expect(finalRow).toMatchObject({
      kind: "changed-pair",
      left: { segments: [{ kind: "same", text: oldText }] },
      right: { segments: [{ kind: "same", text: newText }] },
    });
  });

  it("disables all intraline work without counting limit skips", () => {
    const model = buildDiffModel([hunk(["-old value", "+new value"])], { intraline: false });

    expect(codeRows(model)).toMatchObject([
      {
        kind: "changed-pair",
        left: { segments: [{ kind: "same", text: "old value" }] },
        right: { segments: [{ kind: "same", text: "new value" }] },
      },
    ]);
    expect(model.intralineSkipped).toBe(0);
  });

  it("normalizes CRLF display text and tracks it per side", () => {
    const model = buildDiffModel([hunk(["-before\r", "+after", " old context"])]);

    expect(model.crlf).toEqual({ old: true, new: false });
    expect(cells(model).every((cell) => !cell.text.includes("\r"))).toBe(true);
    expect(
      cells(model).every((cell) => cell.segments.every((segment) => !segment.text.includes("\r"))),
    ).toBe(true);

    const context = buildDiffModel([hunk([" shared\r"])]);
    expect(context.crlf).toEqual({ old: true, new: true });

    const marker = buildDiffModel([hunk(["-old", "? old marker\r", "-later"])]);
    expect(marker.crlf).toEqual({ old: true, new: false });
    expect(marker.rows.find((row) => row.kind === "marker")).toEqual({
      kind: "marker",
      text: "? old marker",
      side: "old",
    });
    expect(JSON.stringify(marker)).not.toContain("\\r");
  });

  it.each(roundTripFixtures.slice(0, 3))(
    "matches computeDiff stats for $name",
    ({ fromText, toText }) => {
      const result = computeDiff({ fromText, toText, ...labels });
      if (result.state !== "ready") throw new Error("expected a ready diff fixture");

      expect(buildDiffModel(result.hunks).stats).toEqual(result.stats);
    },
  );

  it("does not mutate deep-frozen input and is deterministic", () => {
    const input = deepFreeze([
      hunk([" context", "-old", NO_NEWLINE_MARKER, "+new", NO_NEWLINE_MARKER]),
    ]);

    const first = buildDiffModel(input);
    const second = buildDiffModel(input);

    expect(first).toEqual(second);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input[0]?.lines)).toBe(true);
  });

  it("keeps every cell's segment text equal to its display text", () => {
    const model = buildDiffModel([
      hunk([" context", "-old words here", "-猫です", "+new words here", "+犬です", "+extra"]),
    ]);

    for (const cell of cells(model)) {
      expect(cell.segments.map((segment) => segment.text).join("")).toBe(cell.text);
    }
  });

  it("round-trips through runtime JSON without optional-field drift", () => {
    const model = buildDiffModel([
      hunk([" context", "-before", NO_NEWLINE_MARKER, "+after", NO_NEWLINE_MARKER]),
    ]);

    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});
