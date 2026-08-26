import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiffModel } from "@takazudo/zudo-history-stash-core";
import { DiffPane } from "./diff-pane.js";
import type { DiffPaneProps } from "./diff-pane.js";

const MODEL: DiffModel = {
  rows: [],
  unified: [
    { kind: "hunk", header: "@@ -4,2 +7,2 @@" },
    {
      kind: "context",
      oldLine: 4,
      newLine: 7,
      segments: [{ kind: "same", text: "shared line" }],
    },
    {
      kind: "removed",
      oldLine: 5,
      newLine: null,
      segments: [
        { kind: "same", text: "hello " },
        { kind: "removed", text: "old" },
        { kind: "same", text: " world" },
      ],
    },
    {
      kind: "added",
      oldLine: null,
      newLine: 8,
      segments: [
        { kind: "same", text: "hello " },
        { kind: "added", text: "new" },
        { kind: "same", text: " world" },
      ],
    },
    { kind: "marker", text: "? source marker", side: "both" },
  ],
  stats: { added: 1, removed: 1 },
  crlf: { old: false, new: false },
  intralineSkipped: 0,
};

const DEFAULT_PROPS: DiffPaneProps = {
  model: MODEL,
  layout: "unified",
  marks: true,
  wrap: true,
  fromLabel: "Old version",
  toLabel: "New version",
};

function pane(props: Partial<DiffPaneProps> = {}) {
  return <DiffPane {...DEFAULT_PROPS} {...props} />;
}

describe("DiffPane", () => {
  it("renders the compatible four-column unified table and accessible line glyphs", () => {
    const { container } = render(pane());

    expect(screen.getByRole("table", { name: "Unified diff" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Old version",
      "New version",
      "Change",
      "Content",
    ]);

    const contextSign = screen.getByLabelText("Unchanged line");
    const removedSign = screen.getByLabelText("Removed line");
    const addedSign = screen.getByLabelText("Added line");
    expect(contextSign.textContent).toBe("\u00a0");
    expect(removedSign.textContent).toBe("−");
    expect(addedSign.textContent).toBe("+");

    const contextRow = contextSign.closest("tr");
    const removedRow = removedSign.closest("tr");
    const addedRow = addedSign.closest("tr");
    expect(contextRow?.getAttribute("data-line-type")).toBe("context");
    expect(removedRow?.getAttribute("data-line-type")).toBe("remove");
    expect(addedRow?.getAttribute("data-line-type")).toBe("add");
    expect(contextRow?.className).toContain("zhs-diff-table__row--context");
    expect(removedRow?.className).toContain("zhs-diff-table__row--remove");
    expect(addedRow?.className).toContain("zhs-diff-table__row--add");
    expect(removedRow?.querySelector('[aria-label="Old line 5"]')).toBeTruthy();
    expect(removedRow?.querySelector('[aria-label="No new line"]')).toBeTruthy();
    expect(addedRow?.querySelector('[aria-label="No old line"]')).toBeTruthy();
    expect(addedRow?.querySelector('[aria-label="New line 8"]')).toBeTruthy();

    const hunk = container.querySelector(".zhs-diff-table__hunk");
    expect(hunk?.getAttribute("data-hunk-index")).toBe("0");
    expect(hunk?.getAttribute("id")).toBe("diff-hunk-0");
    expect(hunk?.querySelector("th")?.getAttribute("colspan")).toBe("4");
  });

  it("renders added and removed segments with semantic marks and screen-reader boundaries", () => {
    const { container } = render(pane());

    const removed = container.querySelector("del.zhs-diff-mark.zhs-diff-mark--removed");
    const added = container.querySelector("ins.zhs-diff-mark.zhs-diff-mark--added");
    expect(removed).toBeTruthy();
    expect(added).toBeTruthy();
    expect(removed?.textContent).toBe("removed text: old end of change");
    expect(added?.textContent).toBe("added text: new end of change");
    expect(
      Array.from(removed?.querySelectorAll(".zhs-sr-only") ?? []).map((label) => label.textContent),
    ).toEqual(["removed text: ", " end of change"]);
    expect(
      Array.from(added?.querySelectorAll(".zhs-sr-only") ?? []).map((label) => label.textContent),
    ).toEqual(["added text: ", " end of change"]);

    const compatibleLineText = screen.getByText("hello new world");
    expect(compatibleLineText.getAttribute("aria-hidden")).toBe("true");
    expect(compatibleLineText.hasAttribute("hidden")).toBe(true);
  });

  it("turns marks off only through the pane class and preserves the rendered rows and marks", () => {
    const { container, rerender } = render(pane());
    const paneElement = container.querySelector(".zhs-diff-table-pane");
    const rowsBefore = Array.from(container.querySelectorAll("tbody tr"));
    const removedMarkBefore = container.querySelector("del.zhs-diff-mark--removed");
    const bodyBefore = container.querySelector("tbody")?.innerHTML;

    expect(paneElement?.className).not.toContain("zhs-diff-table-pane--no-marks");
    rerender(pane({ marks: false }));

    const rowsAfter = Array.from(container.querySelectorAll("tbody tr"));
    expect(paneElement?.className).toContain("zhs-diff-table-pane--no-marks");
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    expect(rowsAfter.every((row, index) => row === rowsBefore[index])).toBe(true);
    expect(container.querySelector("del.zhs-diff-mark--removed")).toBe(removedMarkBefore);
    expect(container.querySelector("tbody")?.innerHTML).toBe(bodyBefore);
  });

  it("renders no-newline flags as trailing marker rows and preserves source marker rows", () => {
    const model: DiffModel = {
      ...MODEL,
      unified: [
        { kind: "hunk", header: "@@ -1,1 +1,1 @@" },
        {
          kind: "removed",
          oldLine: 1,
          newLine: null,
          segments: [{ kind: "same", text: "before" }],
          noNewline: true,
        },
        {
          kind: "added",
          oldLine: null,
          newLine: 1,
          segments: [{ kind: "same", text: "after" }],
          noNewline: true,
        },
        { kind: "marker", text: "? source marker", side: "new" },
      ],
    };
    const { container } = render(pane({ model }));
    const markerRows = Array.from(container.querySelectorAll(".zhs-diff-table__marker"));

    expect(markerRows).toHaveLength(3);
    expect(markerRows.map((row) => row.textContent)).toEqual([
      "\\ No newline at end of file",
      "\\ No newline at end of file",
      "? source marker",
    ]);
    expect(
      markerRows.every((row) => row.querySelector("td")?.getAttribute("colspan") === "4"),
    ).toBe(true);
  });

  it("selects the semantic split table when split is requested", () => {
    const { container } = render(pane({ layout: "split", wrap: false }));

    const table = screen.getByRole("table", { name: "Split diff" });
    const paneElement = container.querySelector<HTMLElement>(".zhs-diff-table-pane");
    expect(table).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Unified diff" })).toBeNull();
    expect(screen.queryByText("split view not available yet")).toBeNull();
    expect(paneElement?.className).toContain("zhs-diff-table-pane--nowrap");
  });

  it("keeps wrap state on the pane without changing the unified rows", () => {
    const { container, rerender } = render(pane());
    const rowCount = container.querySelectorAll("tbody tr").length;

    rerender(pane({ wrap: false }));

    const paneElement = container.querySelector(".zhs-diff-table-pane");
    expect(paneElement?.className).toContain("zhs-diff-table-pane--nowrap");
    expect(paneElement?.getAttribute("data-wrap")).toBe("off");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(rowCount);
  });
});
