import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiffControls, type DiffControlsProps } from "./diff-controls.js";

const DEFAULT_PROPS: DiffControlsProps = {
  preferredLayout: "unified",
  isNarrow: false,
  marks: true,
  wrap: true,
  setPreferredLayout: vi.fn(),
  setMarks: vi.fn(),
  setWrap: vi.fn(),
};

describe("DiffControls", () => {
  it("sets pressed state from the preferred layout", () => {
    const { rerender } = render(<DiffControls {...DEFAULT_PROPS} />);

    expect(screen.getByRole("group", { name: "Display" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unified" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Split" }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    rerender(<DiffControls {...DEFAULT_PROPS} preferredLayout="split" />);
    expect(screen.getByRole("button", { name: "Unified" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Split" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("disables Split when narrow and exposes its description", () => {
    render(<DiffControls {...DEFAULT_PROPS} isNarrow />);
    const split = screen.getByRole("button", { name: "Split" }) as HTMLButtonElement;
    const descriptionId = split.getAttribute("aria-describedby");

    expect(split.disabled).toBe(true);
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Split view needs a window wider than 56rem",
    );
  });

  it("uses native Enter and Space activation for buttons and checkboxes", async () => {
    const user = userEvent.setup();

    function ControlsHarness() {
      const [preferredLayout, setPreferredLayout] = useState<"unified" | "split">("unified");
      const [marks, setMarks] = useState(true);
      const [wrap, setWrap] = useState(true);
      return (
        <DiffControls
          isNarrow={false}
          marks={marks}
          preferredLayout={preferredLayout}
          setMarks={setMarks}
          setPreferredLayout={setPreferredLayout}
          setWrap={setWrap}
          wrap={wrap}
        />
      );
    }

    render(<ControlsHarness />);
    const unified = screen.getByRole("button", { name: "Unified" });
    const split = screen.getByRole("button", { name: "Split" });
    const marks = screen.getByRole("checkbox", { name: "Marks" }) as HTMLInputElement;
    const wrap = screen.getByRole("checkbox", { name: "Wrap" }) as HTMLInputElement;

    expect(split.tagName).toBe("BUTTON");
    split.focus();
    await user.keyboard("{Enter}");
    expect(split.getAttribute("aria-pressed")).toBe("true");
    unified.focus();
    await user.keyboard("{Enter}");
    expect(unified.getAttribute("aria-pressed")).toBe("true");

    expect(marks.tagName).toBe("INPUT");
    marks.focus();
    await user.keyboard(" ");
    expect(marks.checked).toBe(false);
    wrap.focus();
    await user.keyboard(" ");
    expect(wrap.checked).toBe(false);
  });
});
