import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClientResult, MeResponse, StashClient } from "@takazudo/zudo-history-stash";
import { describe, expect, it, vi } from "vitest";
import { change, createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

function homeClient(overrides: Parameters<typeof createFakeViewerClient>[0] = {}) {
  const client = createFakeViewerClient(overrides);
  client.admin.gc.runs = async () => ({ ok: true, value: { runs: [] } });
  return client;
}

describe("HomePage", () => {
  it("shows a loading state while access is checked", () => {
    const client = homeClient({
      me: vi.fn(
        () =>
          new Promise<ClientResult<MeResponse>>(() => {
            // Intentionally pending.
          }),
      ),
    });
    renderViewerRoute("/", client);
    expect(screen.getByText("Checking access…")).toBeTruthy();
  });

  it("shows the empty stash and change states", async () => {
    renderViewerRoute("/", homeClient());
    expect(await screen.findByText("No stashes yet. Create the first one.")).toBeTruthy();
    expect(screen.getByText("No changes have been recorded.")).toBeTruthy();
  });

  it("shows a request error with a retry action", async () => {
    const client = homeClient({
      stashes: {
        list: async () => ({
          ok: false,
          error: { status: 503, code: "internal", message: "D1 unavailable" },
        }),
      },
    });
    renderViewerRoute("/", client);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("D1 unavailable");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("clears a rejected token and preserves the current page in the login redirect", async () => {
    const client = homeClient({
      stashes: {
        list: async () => ({
          ok: false,
          error: { status: 401, code: "unauthorized", message: "Expired" },
        }),
      },
    });
    const { router } = renderViewerRoute("/", client);

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2F");
  });

  it("redirects stash principals to their own file list", async () => {
    const client = homeClient({
      me: async () => ({
        ok: true,
        value: {
          principal: "stash",
          stash: "notes",
          tokenId: "tok_1",
          scope: "read",
          expiresAt: null,
        },
      }),
    });
    const { router } = renderViewerRoute("/", client);
    await waitFor(() => expect(router.state.location.pathname).toBe("/s/notes"));
  });

  it("renders file counts and sorts recent changes newest-first", async () => {
    const client = homeClient({
      stashes: {
        list: async () => ({
          ok: true,
          value: {
            stashes: [
              {
                name: "notes",
                description: "Team notes",
                fileCount: 2,
                deletedFileCount: 1,
                lastChangeId: 9,
                lastChangeAt: "2026-08-25T09:00:00.000Z",
                createdAt: "2026-08-20T09:00:00.000Z",
                deletedAt: null,
                restoreUntil: null,
                restorable: false,
              },
            ],
            nextAfter: null,
          },
        }),
      },
      changes: async () => ({
        ok: true,
        value: {
          changes: [
            change({ changeId: 3, path: "older.txt", version: 1 }),
            change({ changeId: 9, path: "newer.txt", version: 3 }),
          ],
          hasMore: false,
          nextBefore: null,
        },
      }),
    });
    renderViewerRoute("/", client);

    const stashRegion = await screen.findByRole("region", { name: "Stash directory" });
    const notesLink = await within(stashRegion).findByRole("link", { name: "notes" });
    const row = notesLink.closest("tr");
    expect(row?.textContent).toContain("2");
    expect(row?.textContent).toContain("+ 1 deleted");

    const changesRegion = screen.getByRole("region", { name: "Recent changes" });
    const changeRows = within(changesRegion).getAllByRole("listitem");
    expect(changeRows[0]?.getAttribute("data-change-id")).toBe("9");
    expect(changeRows[1]?.getAttribute("data-change-id")).toBe("3");
  });

  it("shows the exists conflict inline when creating a stash", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: { status: 409, code: "exists" as const, message: "Exists" },
    }));
    const client = homeClient({ stashes: { create } });
    renderViewerRoute("/", client);
    await screen.findByText("No stashes yet. Create the first one.");

    await userEvent.click(screen.getByRole("button", { name: "New stash" }));
    expect(screen.getByRole("dialog", { name: "Create stash" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Name"), "notes");
    await userEvent.click(screen.getByRole("button", { name: "Create stash" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "A stash with that name already exists.",
    );
    expect(create).toHaveBeenCalledWith({ name: "notes" });
  });

  it("shows deleted stashes on demand and restores only a server-restorable row", async () => {
    const live = {
      name: "live",
      description: "",
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    };
    const restorable = {
      ...live,
      name: "restorable",
      deletedAt: "2026-08-26T00:00:00.000Z",
      restoreUntil: "2026-09-25T00:00:00.000Z",
      restorable: true,
    };
    const expired = {
      ...live,
      name: "expired",
      deletedAt: "2026-07-01T00:00:00.000Z",
      restoreUntil: "2026-07-31T00:00:00.000Z",
      restorable: false,
    };
    const list = vi.fn<StashClient["stashes"]["list"]>(async (options = {}) => ({
      ok: true,
      value: {
        stashes: options.includeDeleted ? [expired, live, restorable] : [live],
        nextAfter: null,
      },
    }));
    const restore = vi.fn<StashClient["stashes"]["restore"]>(async () => ({
      ok: true,
      value: { ...restorable, deletedAt: null, restoreUntil: null, restorable: false, meta: {} },
    }));
    renderViewerRoute("/", homeClient({ stashes: { list, restore } }));

    const directory = await screen.findByRole("region", { name: "Stash directory" });
    expect(within(directory).queryByText("restorable")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show deleted" }));

    const restoreButton = await within(directory).findByRole("button", {
      name: "Restore restorable",
    });
    const deletedRow = within(directory).getByText("restorable").closest("tr");
    expect(deletedRow?.className).toContain("deleted-row");
    expect(within(directory).queryByRole("button", { name: "Restore expired" })).toBeNull();
    expect(within(directory).getByText("expired").closest("tr")?.className).toContain(
      "deleted-row",
    );

    await userEvent.click(restoreButton);
    await waitFor(() => expect(restore).toHaveBeenCalledWith("restorable"));
    expect(list).toHaveBeenCalledWith({ includeDeleted: false });
    expect(list).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it("renders the admin maintenance card", async () => {
    renderViewerRoute("/", homeClient());
    expect(await screen.findByRole("region", { name: "Maintenance" })).toBeTruthy();
  });
});
