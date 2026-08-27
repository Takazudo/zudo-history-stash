import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveIndicator } from "./live-indicator.js";

describe("LiveIndicator", () => {
  it.each([
    ["live", "Live"],
    ["reconnecting", "Reconnecting"],
    ["polling", "Polling"],
    ["off", "Off"],
  ] as const)("renders an accessible SVG-backed %s state", (status, label) => {
    const rendered = render(<LiveIndicator status={status} />);

    const indicator = screen.getByRole("status", {
      name: `Live updates: ${label.toLowerCase()}`,
    });
    expect(indicator.className).toContain(`zhs-live-indicator--${status}`);
    expect(indicator.textContent).toBe(label);
    expect(indicator.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(rendered.container.querySelector("svg")?.textContent).toBe("");
  });

  it("preserves a host class without replacing its namespaced state classes", () => {
    render(<LiveIndicator className="app-header__live" status="live" />);
    const indicator = screen.getByRole("status", { name: "Live updates: live" });
    expect(indicator.className.split(" ")).toEqual([
      "zhs-live-indicator",
      "zhs-live-indicator--live",
      "app-header__live",
    ]);
  });
});
