import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiffHunk } from "@takazudo/zudo-history-stash";
import { DiffTable } from "./diff-table.js";

const HUNKS: DiffHunk[] = [
  {
    oldStart: 3,
    oldLines: 2,
    newStart: 8,
    newLines: 2,
    lines: [
      " shared line",
      "-old line",
      "+new line",
      "\\ No newline at end of file",
      "? source marker",
    ],
  },
];

describe("DiffTable compatibility wrapper", () => {
  it("preserves the previous unified row, class, column, glyph, and marker contract", () => {
    const { container } = render(<DiffTable hunks={HUNKS} wrap={true} />);
    const table = screen.getByRole("table", { name: "Unified diff" });

    expect(table).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Old",
      "New",
      "Change",
      "Content",
    ]);

    const rows = Array.from(container.querySelectorAll("tr[data-line-type]"));
    expect(rows.map((row) => row.getAttribute("data-line-type"))).toEqual([
      "context",
      "remove",
      "add",
    ]);
    expect(rows.map((row) => row.className)).toEqual([
      "zhs-table__row zhs-diff-table__row zhs-diff-table__row--context",
      "zhs-table__row zhs-diff-table__row zhs-diff-table__row--remove",
      "zhs-table__row zhs-diff-table__row zhs-diff-table__row--add",
    ]);
    expect(rows.every((row) => row.children.length === 4)).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.querySelector('[data-column="old"]') !== null &&
          row.querySelector('[data-column="new"]') !== null &&
          row.querySelector('[data-column="sign"]') !== null &&
          row.querySelector('[data-column="content"]') !== null,
      ),
    ).toBe(true);
    expect(screen.getByLabelText("Unchanged line").textContent).toBe("\u00a0");
    expect(screen.getByLabelText("Removed line").textContent).toBe("−");
    expect(screen.getByLabelText("Added line").textContent).toBe("+");

    const hunk = container.querySelector(".zhs-diff-table__hunk");
    expect(hunk?.getAttribute("data-hunk-index")).toBe("0");
    expect(hunk?.getAttribute("id")).toBe("diff-hunk-0");
    expect(hunk?.textContent).toBe("@@ -3,2 +8,2 @@");
    expect(container.querySelector(".zhs-diff-table-pane")?.className).toContain(
      "zhs-diff-table-pane--wrap",
    );
    expect(
      Array.from(container.querySelectorAll(".zhs-diff-table__marker"), (row) => row.textContent),
    ).toEqual(["\\ No newline at end of file", "? source marker"]);
  });
});
