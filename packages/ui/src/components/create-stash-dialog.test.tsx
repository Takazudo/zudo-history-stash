import { createStashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useIsAdmin } from "../provider/hooks.js";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { CreateStashDialog } from "./create-stash-dialog.js";

interface Fixture {
  fake: FakeStash;
  fetch: ReturnType<typeof vi.fn<StashFetch>>;
  client: ReturnType<typeof createStashClient>;
}

function requestFor(call: Parameters<StashFetch>): Request {
  return new Request(call[0], call[1]);
}

function CapabilityProbe() {
  const { ready, isAdmin } = useIsAdmin();
  return (
    <output aria-label="capability">{ready ? (isAdmin ? "admin" : "denied") : "pending"}</output>
  );
}

async function adminFixture(fetchOverride?: StashFetch): Promise<Fixture> {
  const adminToken = "test-admin-token";
  const fake = createFakeStash({ adminToken });
  const fetch = vi.fn<StashFetch>(fetchOverride ?? fake.fetch);
  return {
    fake,
    fetch,
    client: createStashClient({ baseUrl: "https://fake.invalid", token: adminToken, fetch }),
  };
}

async function nonAdminFixture(): Promise<Fixture> {
  const fake = createFakeStash({ adminToken: "test-admin-token" });
  fake.createStash("notes");
  const token = await fake.mintToken("notes", "write");
  const fetch = vi.fn<StashFetch>(fake.fetch);
  return {
    fake,
    fetch,
    client: createStashClient({ baseUrl: "https://fake.invalid", token, fetch }),
  };
}

function renderDialog(
  fixture: Fixture,
  {
    open = true,
    onClose = vi.fn(),
    onCreated = vi.fn(),
  }: {
    open?: boolean;
    onClose?: () => void;
    onCreated?: (name: string) => void;
  } = {},
) {
  return {
    onClose,
    onCreated,
    ...render(
      <StashUiProvider client={fixture.client}>
        <CapabilityProbe />
        <CreateStashDialog open={open} onClose={onClose} onCreated={onCreated} />
      </StashUiProvider>,
    ),
  };
}

function ControlledDialog({ fixture }: { fixture: Fixture }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open create dialog</button>
      <StashUiProvider client={fixture.client}>
        <CreateStashDialog open={open} onClose={() => setOpen(false)} onCreated={() => undefined} />
      </StashUiProvider>
    </>
  );
}

describe("CreateStashDialog", () => {
  it("creates through the real client/fake boundary and reports the name exactly once", async () => {
    const fixture = await adminFixture();
    const onCreated = vi.fn();
    renderDialog(fixture, { onCreated });
    const user = userEvent.setup();

    const dialog = await screen.findByRole("dialog", { name: "Create stash" });
    expect(dialog.className).toContain("zhs-create-stash-dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "project-notes");
    await user.type(within(dialog).getByRole("textbox", { name: /Description/ }), "  Team notes  ");
    await user.click(within(dialog).getByRole("button", { name: "Create stash" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith("project-notes");
    expect(fixture.fake.state.stashes.get("project-notes")).toMatchObject({
      name: "project-notes",
      description: "Team notes",
    });
    expect(
      fixture.fetch.mock.calls.map(requestFor).filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  it("validates names live and never calls create for an invalid value", async () => {
    const fixture = await adminFixture();
    const onCreated = vi.fn();
    renderDialog(fixture, { onCreated });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Create stash" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });

    await user.type(name, "Bad Name");
    expect(within(dialog).getByRole("alert").textContent).toBe("Invalid stash name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(
      within(dialog).getByRole("button", { name: "Create stash" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.submit(within(dialog).getByRole("button", { name: "Create stash" }).closest("form")!);

    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(fixture.fake.state.stashes.has("Bad Name")).toBe(false);
  });

  it("shows an exists conflict inline, clears it on name change, and can then create", async () => {
    const fixture = await adminFixture();
    fixture.fake.createStash("already-exists");
    const onCreated = vi.fn();
    renderDialog(fixture, { onCreated });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Create stash" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });

    await user.type(name, "already-exists");
    await user.click(within(dialog).getByRole("button", { name: "Create stash" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "A stash with that name already exists.",
    );
    expect(onCreated).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, "available-name");
    expect(within(dialog).queryByText("A stash with that name already exists.")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Create stash" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("available-name"));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submissions while the create request is pending", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const base = await adminFixture();
    const gatedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/stashes") {
        await createGate;
      }
      return base.fake.fetch(input, init);
    };
    const fixture = await adminFixture(gatedFetch);
    fixture.fake = base.fake;
    const onCreated = vi.fn();
    renderDialog(fixture, { onCreated });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Create stash" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "one-request");
    const form = dialog.querySelector("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);

    await act(async () => releaseCreate());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(fixture.fake.state.stashes.has("one-request")).toBe(true);
  });

  it("renders no create surface before capability readiness or for a non-admin principal", async () => {
    const fixture = await nonAdminFixture();
    const onCreated = vi.fn();
    renderDialog(fixture, { onCreated });

    expect(screen.getByRole("status", { name: "capability" }).textContent).toBe("pending");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "capability" }).textContent).toBe("denied"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create stash" })).toBeNull();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(requestFor(fixture.fetch.mock.calls[0]!).method).toBe("GET");
    expect(new URL(requestFor(fixture.fetch.mock.calls[0]!).url).pathname).toBe("/v1/me");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps Cancel and Escape separate from creation", async () => {
    const fixture = await adminFixture();
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderDialog(fixture, { onClose, onCreated });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Create stash" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "not-created");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onCreated).not.toHaveBeenCalled();
    expect(fixture.fake.state.stashes.has("not-created")).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the form draft when onClose closes and later reopens the dialog", async () => {
    const fixture = await adminFixture();
    const user = userEvent.setup();
    render(<ControlledDialog fixture={fixture} />);
    let dialog = await screen.findByRole("dialog", { name: "Create stash" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "kept-draft");
    await user.type(within(dialog).getByRole("textbox", { name: /Description/ }), "Keep this");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Open create dialog" }));
    dialog = await screen.findByRole("dialog", { name: "Create stash" });

    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "kept-draft",
    );
    expect(
      (within(dialog).getByRole("textbox", { name: /Description/ }) as HTMLTextAreaElement).value,
    ).toBe("Keep this");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
});
