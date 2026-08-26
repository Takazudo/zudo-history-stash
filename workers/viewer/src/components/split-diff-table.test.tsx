import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiffModelRow } from "@takazudo/zudo-history-stash-core";
import { SplitDiffTable } from "./split-diff-table.js";

const ROWS: DiffModelRow[] = [
  {
    kind: "hunk",
    header: "@@ -10,4 +20,4 @@",
    oldStart: 10,
    oldLines: 4,
    newStart: 20,
    newLines: 4,
  },
  {
    kind: "context",
    left: {
      lineNumber: 10,
      text: "shared line",
      segments: [{ kind: "same", text: "shared line" }],
    },
    right: {
      lineNumber: 20,
      text: "shared line",
      segments: [{ kind: "same", text: "shared line" }],
    },
  },
  {
    kind: "changed-pair",
    left: {
      lineNumber: 11,
      text: "hello old world",
      segments: [
        { kind: "same", text: "hello " },
        { kind: "removed", text: "old" },
        { kind: "same", text: " world" },
      ],
      noNewline: true,
    },
    right: {
      lineNumber: 21,
      text: "hello new world",
      segments: [
        { kind: "same", text: "hello " },
        { kind: "added", text: "new" },
        { kind: "same", text: " world" },
      ],
    },
  },
  {
    kind: "removed",
    left: {
      lineNumber: 12,
      text: "old only",
      segments: [{ kind: "same", text: "old only" }],
    },
    right: null,
  },
  {
    kind: "added",
    left: null,
    right: {
      lineNumber: 22,
      text: "new only",
      segments: [{ kind: "same", text: "new only" }],
      noNewline: true,
    },
  },
  { kind: "marker", text: "? source marker", side: "both" },
];

function row(container: HTMLElement, kind: DiffModelRow["kind"]): HTMLElement {
  const value = container.querySelector<HTMLElement>(`[data-row-kind="${kind}"]`);
  if (!value) throw new Error(`Missing ${kind} row`);
  return value;
}

describe("SplitDiffTable", () => {
  it("renders the seven declared columns, meaningful headers, and version caption", () => {
    const { container } = render(<SplitDiffTable fromLabel="v2" rows={ROWS} toLabel="v5" />);

    const table = screen.getByRole("table", { name: "Split diff" });
    const columnHeaders = within(table)
      .getAllByRole("columnheader")
      .filter((header) => header.getAttribute("scope") === "col");
    expect(columnHeaders.map((header) => header.textContent)).toEqual([
      "Line",
      "Δ",
      "Text",
      "Divider",
      "Line",
      "Δ",
      "Text",
    ]);
    expect(
      ["Old line", "Old change", "Old text", "New line", "New change", "New text"].map(
        (name) => within(table).getByRole("columnheader", { name }).textContent,
      ),
    ).toEqual(["Line", "Δ", "Text", "Line", "Δ", "Text"]);
    expect(
      columnHeaders
        .filter((header) => header.textContent !== "Divider")
        .every((header) => header.classList.contains("zhs-diff-table__column-heading")),
    ).toBe(true);
    expect(within(table).getByText("v2")).toBeTruthy();
    expect(within(table).getByText("v5")).toBeTruthy();

    const columns = Array.from(container.querySelectorAll("col"));
    expect(columns).toHaveLength(7);
    expect(columns.map((column) => column.className)).toEqual([
      "zhs-diff-table__col--gutter",
      "zhs-diff-table__col--sign",
      "",
      "zhs-diff-table__col--divider",
      "zhs-diff-table__col--gutter",
      "zhs-diff-table__col--sign",
      "",
    ]);
    expect(columns.every((column) => !(column as HTMLElement).hasAttribute("style"))).toBe(true);
  });

  it("renders context and changed pairs with side-specific glyphs and semantic marks", () => {
    const { container } = render(<SplitDiffTable fromLabel="v2" rows={ROWS} toLabel="v5" />);
    const context = row(container, "context");
    const pair = row(container, "changed-pair");

    expect(within(context).getAllByRole("cell")).toHaveLength(7);
    expect(within(pair).getAllByRole("cell")).toHaveLength(7);
    expect(context.querySelector('[data-column="old-change"]')?.textContent).toBe(" ");
    expect(context.querySelector('[data-column="new-change"]')?.textContent).toBe(" ");
    expect(within(context).getAllByLabelText("Unchanged line")).toHaveLength(2);
    expect(within(context).getByTestId("split-left-context").textContent).toBe("shared line");
    expect(within(context).getByTestId("split-right-context").textContent).toBe("shared line");

    expect(pair.querySelector('[data-column="old-change"]')?.textContent).toBe("−");
    expect(pair.querySelector('[data-column="new-change"]')?.textContent).toBe("+");
    const left = within(pair).getByTestId("split-left-removed");
    const right = within(pair).getByTestId("split-right-added");
    const removed = left.querySelector("del");
    const added = right.querySelector("ins");
    expect(left.className).toContain("zhs-diff-table__cell--removed");
    expect(right.className).toContain("zhs-diff-table__cell--added");
    expect(removed?.textContent).toBe("removed text: old end of change");
    expect(added?.textContent).toBe("added text: new end of change");
    expect(
      Array.from(removed?.querySelectorAll(".zhs-sr-only") ?? []).map((label) => label.textContent),
    ).toEqual(["removed text: ", " end of change"]);
    expect(
      Array.from(added?.querySelectorAll(".zhs-sr-only") ?? []).map((label) => label.textContent),
    ).toEqual(["added text: ", " end of change"]);
  });

  it("renders removed and added rows with labelled, hatched void sides", () => {
    const { container } = render(<SplitDiffTable fromLabel="v2" rows={ROWS} toLabel="v5" />);
    const removed = row(container, "removed");
    const added = row(container, "added");

    expect(within(removed).getAllByRole("cell")).toHaveLength(7);
    expect(within(added).getAllByRole("cell")).toHaveLength(7);
    expect(within(removed).getByTestId("split-left-removed").textContent).toBe("old only");
    const noNewLine = within(removed).getByLabelText("No new line");
    const removedVoidCells = Array.from(removed.querySelectorAll(".zhs-diff-table__cell--void"));
    expect(noNewLine.className).toContain("zhs-diff-table__cell--void");
    expect(removedVoidCells).toHaveLength(3);
    expect(
      removedVoidCells.every((cell) => cell.className.includes("zhs-diff-table__cell--void")),
    ).toBe(true);
    const noOldLine = within(added).getByLabelText("No old line");
    expect(noOldLine.className).toContain("zhs-diff-table__cell--void");
    expect(within(added).getByTestId("split-right-added").textContent).toBe("new only");
    expect(added.querySelectorAll(".zhs-diff-table__cell--void")).toHaveLength(3);
  });

  it("spans hunk, source-marker, and per-side no-newline rows across all columns", () => {
    const { container } = render(<SplitDiffTable fromLabel="v2" rows={ROWS} toLabel="v5" />);

    expect(row(container, "hunk").querySelector("th")?.getAttribute("colspan")).toBe("7");
    expect(row(container, "marker").querySelector("td")?.getAttribute("colspan")).toBe("7");
    expect(row(container, "marker").textContent).toBe("? source marker");

    const noNewlineRows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-row-kind="no-newline"]'),
    );
    expect(noNewlineRows).toHaveLength(2);
    expect(
      noNewlineRows.every((marker) => marker.querySelector("td")?.getAttribute("colspan") === "7"),
    ).toBe(true);
    expect(
      noNewlineRows.map(
        (marker) => marker.querySelector<HTMLElement>("[data-marker-side]")?.dataset.markerSide,
      ),
    ).toEqual(["old", "new"]);
    expect(noNewlineRows.map((marker) => marker.textContent)).toEqual([
      "\\ No newline at end of file",
      "\\ No newline at end of file",
    ]);
  });
});
