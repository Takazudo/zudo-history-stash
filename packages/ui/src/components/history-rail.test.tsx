import type { VersionKind, VersionRecord } from "@takazudo/zudo-history-stash";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HistoryRail } from "./history-rail.js";

function version(
  number: number,
  kind: VersionKind = "put",
  rollbackOf: number | null = null,
): VersionRecord {
  return {
    version: number,
    kind,
    hash: kind === "delete" ? null : `sha256-${number}`,
    size: number,
    rollbackOf,
    author: `Author ${number}`,
    message: `Message ${number}`,
    meta: {},
    createdAt: `2026-08-2${number}T10:00:00.000Z`,
  };
}

function renderRail(overrides: Partial<React.ComponentProps<typeof HistoryRail>> = {}) {
  const props: React.ComponentProps<typeof HistoryRail> = {
    versions: [version(1), version(3, "rollback", 1), version(2, "delete")],
    source: { version: 2 },
    comparison: "head",
    head: { version: 3 },
    onLoadSource: vi.fn(),
    onSetComparison: vi.fn(),
    onEditFrom: vi.fn(),
    ...overrides,
  };
  return { ...render(<HistoryRail {...props} />), props };
}

describe("HistoryRail", () => {
  it("renders newest-first kind/rollback metadata, head marker, and pressed A/B slots", () => {
    const { container } = renderRail();
    const rows = Array.from(container.querySelectorAll("[data-history-version]"));
    expect(rows.map((row) => row.getAttribute("data-history-version"))).toEqual(["3", "2", "1"]);

    const headRow = within(rows[0] as HTMLElement);
    expect(headRow.getByText("head")).toBeTruthy();
    expect(headRow.getByText("rollback")).toBeTruthy();
    expect(headRow.getByText("→ v1")).toBeTruthy();
    expect(
      headRow.getByRole("button", { name: "Use v3 as comparison B" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Use v2 as source A" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("dispatches A, B, head-following B, and Edit from through separate callbacks", async () => {
    const { props } = renderRail({ comparison: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Use v1 as source A" }));
    await userEvent.click(screen.getByRole("button", { name: "Use v1 as comparison B" }));
    await userEvent.click(screen.getByRole("button", { name: "Use v3 as comparison B" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit from v2" }));

    expect(props.onLoadSource).toHaveBeenCalledWith(1);
    expect(props.onSetComparison).toHaveBeenNthCalledWith(1, 1);
    expect(props.onSetComparison).toHaveBeenNthCalledWith(2, "head");
    expect(props.onEditFrom).toHaveBeenCalledWith(2);
  });

  it("collapses from the seam tab and supports controlled open state", async () => {
    const uncontrolled = renderRail();
    const rail = screen.getByRole("complementary", { name: "Version history" });
    const collapse = screen.getByRole("button", { name: "Collapse version history" });
    expect(rail.getAttribute("data-rail")).toBe("open");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(collapse);
    expect(rail.getAttribute("data-rail")).toBe("closed");
    expect(screen.getByRole("button", { name: "Expand version history" })).toBeTruthy();
    expect(
      uncontrolled.container.querySelector(".zhs-history-rail__panel")?.hasAttribute("hidden"),
    ).toBe(true);

    uncontrolled.unmount();
    const onOpenChange = vi.fn();
    renderRail({ open: false, onOpenChange });
    await userEvent.click(screen.getByRole("button", { name: "Expand version history" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("complementary").getAttribute("data-rail")).toBe("closed");
  });

  it("moves focus within an A/B slot column and activates controls from the keyboard", async () => {
    const { props } = renderRail();
    const firstB = screen.getByRole("button", { name: "Use v3 as comparison B" });
    const secondB = screen.getByRole("button", { name: "Use v2 as comparison B" });
    const lastB = screen.getByRole("button", { name: "Use v1 as comparison B" });
    firstB.focus();
    fireEvent.keyDown(firstB, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondB);
    fireEvent.keyDown(secondB, { key: "End" });
    expect(document.activeElement).toBe(lastB);
    fireEvent.keyDown(lastB, { key: "Home" });
    expect(document.activeElement).toBe(firstB);
    fireEvent.keyDown(firstB, { key: "ArrowUp" });
    expect(document.activeElement).toBe(firstB);

    await userEvent.keyboard("{Enter}");
    expect(props.onSetComparison).toHaveBeenCalledWith("head");
  });

  it("keeps the leaf stylesheet namespaced, token-driven, and uses a CSS chevron", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/history-rail.css"), "utf8");
    const classNames = [...css.matchAll(/\.([_a-zA-Z][-_a-zA-Z0-9]*)/gu)].map((match) => match[1]);
    expect(classNames.length).toBeGreaterThan(0);
    expect(classNames.every((className) => className?.startsWith("zhs-history-rail"))).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}|\brgb\(|\boklch\(|:\s*transparent\b/iu);
    expect(css).not.toMatch(/\dpx\b/u);
    expect(css).toContain(".zhs-history-rail__chevron");
    expect(css).toContain("border-block-start:");
    expect(css).toContain("data-rail");
    const hoverCapabilityStart = css.indexOf("@media (hover: hover)");
    expect(hoverCapabilityStart).toBeGreaterThan(-1);
    expect(css.slice(0, hoverCapabilityStart)).not.toContain(":hover");
    expect(css.slice(hoverCapabilityStart).match(/:hover/gu)).toHaveLength(3);
    expect(css.slice(hoverCapabilityStart)).toContain(".zhs-history-rail__row:hover");
    expect(css.slice(hoverCapabilityStart)).toContain(".zhs-history-rail__slot:hover");
    expect(css.slice(hoverCapabilityStart)).toContain(".zhs-history-rail__toggle:hover");
  });
});
