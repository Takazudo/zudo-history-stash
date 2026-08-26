import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";
import { Input } from "./input.js";
import { Notice } from "./notice.js";
import { Select } from "./select.js";
import { SrOnly } from "./sr-only.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js";
import { Textarea } from "./textarea.js";

describe("UI primitives", () => {
  it("renders namespaced, square-token-backed controls and table helpers", () => {
    render(
      <>
        <Button variant="primary" aria-pressed="true">
          Save
        </Button>
        <label>
          Name
          <Input />
        </label>
        <label>
          Body
          <Textarea />
        </label>
        <label>
          Scope
          <Select defaultValue="read">
            <option value="read">Read</option>
          </Select>
        </label>
        <Table>
          <TableCaption>Tokens</TableCaption>
          <TableHead>
            <TableRow>
              <TableHeader>ID</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>tok_1</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Notice variant="error">Unable to save</Notice>
        <SrOnly>Additional context</SrOnly>
      </>,
    );

    const save = screen.getByRole("button", { name: "Save" });
    expect(save.className).toContain("zhs-button");
    expect(save.className).toContain("zhs-button--primary");
    expect(save.getAttribute("type")).toBe("button");
    expect(save.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Name" }).className).toContain("zhs-input");
    expect(screen.getByRole("textbox", { name: "Body" }).className).toContain("zhs-textarea");
    expect(screen.getByRole("combobox", { name: "Scope" }).className).toContain("zhs-select");

    const table = screen.getByRole("table", { name: "Tokens" });
    expect(table.className).toContain("zhs-table");
    expect(within(table).getByRole("columnheader").className).toContain("zhs-table__header");
    expect(within(table).getByRole("cell").className).toContain("zhs-table__cell");
    expect(screen.getByRole("alert").className).toContain("zhs-notice--error");
    expect(screen.getByText("Additional context").className).toContain("zhs-sr-only");
  });
});

function DialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        aria-label="Settings"
      >
        <button>Inside</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("uses native modal semantics, closes on Escape only once, and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);

    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.className).toContain("zhs-dialog");
    expect(dialog.hasAttribute("open")).toBe(true);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("does not treat a backdrop-area click as a close request", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.click(dialog);

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(true);
  });
});
