import type { DiffHunk } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { DiffTable } from "./diff-table.js";

const HUNKS: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [
      " shared",
      "-hello old world",
      "+hello new world",
      " tail",
      "\\ No newline at end of file",
    ],
  },
];

describe("package diff components", () => {
  it("renders namespaced unified rows, semantic marks, gutters, and markers", () => {
    const model = buildDiffModel(HUNKS);
    const { container } = render(
      <DiffPane
        fromLabel="v1"
        layout="unified"
        marks={true}
        model={model}
        toLabel="v2"
        wrap={true}
      />,
    );

    const table = screen.getByRole("table", { name: "Unified diff" });
    expect(table.className).toContain("zhs-diff-table--unified");
    expect(table.closest(".zhs-diff-table-pane")?.className).toContain("zhs-diff-table-pane--wrap");
    const removed = screen.getByLabelText("Removed line").closest("tr");
    const added = screen.getByLabelText("Added line").closest("tr");
    expect(removed?.getAttribute("data-line-type")).toBe("remove");
    expect(added?.getAttribute("data-line-type")).toBe("add");
    expect(removed?.querySelector('[data-column="old"]')?.textContent).toBe("2");
    expect(added?.querySelector('[data-column="new"]')?.textContent).toBe("2");
    expect(container.querySelector("del.zhs-diff-mark--removed")).toBeTruthy();
    expect(container.querySelector("ins.zhs-diff-mark--added")).toBeTruthy();
    expect(container.querySelectorAll(".zhs-diff-table__marker")).toHaveLength(1);
    expect(container.querySelector(".zhs-diff-table__hunk")?.getAttribute("colspan")).toBeNull();
    expect(container.querySelector(".zhs-diff-table__hunk th")?.getAttribute("colspan")).toBe("4");
  });

  it("renders a seven-cell split row and copy-safe void side without inline sizing", () => {
    const model = buildDiffModel([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 1,
        lines: [" shared", "-removed only"],
      },
    ]);
    const { container } = render(
      <DiffPane
        fromLabel="v1"
        layout="split"
        marks={true}
        model={model}
        toLabel="v2"
        wrap={false}
      />,
    );

    const table = screen.getByRole("table", { name: "Split diff" });
    expect(table.className).toContain("zhs-diff-table--split");
    const removed = container.querySelector('[data-row-kind="removed"]');
    expect(removed).toBeTruthy();
    expect(within(removed as HTMLElement).getAllByRole("cell")).toHaveLength(7);
    expect(removed?.querySelectorAll(".zhs-diff-table__cell--void")).toHaveLength(3);
    expect(table.querySelectorAll("col")).toHaveLength(7);
    expect(
      [...table.querySelectorAll("col")].every((column) => !column.hasAttribute("style")),
    ).toBe(true);
  });

  it("uses package buttons and preserves controlled view-preference semantics", async () => {
    const setPreferredLayout = vi.fn();
    const setMarks = vi.fn();
    const setWrap = vi.fn();
    render(
      <DiffControls
        isNarrow={false}
        marks={true}
        preferredLayout="unified"
        setMarks={setMarks}
        setPreferredLayout={setPreferredLayout}
        setWrap={setWrap}
        wrap={true}
      />,
    );

    const unified = screen.getByRole("button", { name: "Unified" });
    expect(unified.className).toContain("zhs-button");
    expect(unified.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Marks" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Wrap" }));
    expect(setPreferredLayout).toHaveBeenCalledWith("split");
    expect(setMarks).toHaveBeenCalledWith(false);
    expect(setWrap).toHaveBeenCalledWith(false);
  });

  it("keeps the legacy DiffTable convenience surface on the package implementation", () => {
    render(<DiffTable hunks={HUNKS} wrap={false} />);
    const table = screen.getByRole("table", { name: "Unified diff" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Old", "New", "Change", "Content"]);
    expect(table.closest(".zhs-diff-table-pane")?.className).toContain(
      "zhs-diff-table-pane--nowrap",
    );
  });
});
