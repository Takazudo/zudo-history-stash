import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClientResult, MeResponse } from "@takazudo/zudo-history-stash";
import { describe, expect, it, vi } from "vitest";
import { change, createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

describe("HomePage", () => {
  it("shows a loading state while access is checked", () => {
    const client = createFakeViewerClient({
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
    renderViewerRoute("/", createFakeViewerClient());
    expect(await screen.findByText("No stashes yet. Create the first one.")).toBeTruthy();
    expect(screen.getByText("No changes have been recorded.")).toBeTruthy();
  });

  it("shows a request error with a retry action", async () => {
    const client = createFakeViewerClient({
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
    const client = createFakeViewerClient({
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
    const client = createFakeViewerClient({
      me: async () => ({
        ok: true,
        value: { principal: "stash", stash: "notes", tokenId: "tok_1", scope: "read" },
      }),
    });
    const { router } = renderViewerRoute("/", client);
    await waitFor(() => expect(router.state.location.pathname).toBe("/s/notes"));
  });

  it("renders file counts and sorts recent changes newest-first", async () => {
    const client = createFakeViewerClient({
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
    const client = createFakeViewerClient({ stashes: { create } });
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
});
