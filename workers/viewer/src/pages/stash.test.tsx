import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ClientResult,
  FileListResponse,
  FileSummary,
  ListChangesResult,
  StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { describe, expect, it, vi } from "vitest";
import { change, createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

function file(overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    path: "docs/readme.txt",
    headVersion: 2,
    hash: "sha256-abc",
    size: 120,
    deleted: false,
    updatedAt: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

function clientWithFiles(overrides: Partial<StashFilesClient>) {
  const defaults = createFakeViewerClient();
  return createFakeViewerClient({
    files: (stash) => ({ ...defaults.files(stash), ...overrides }),
  });
}

describe("StashPage", () => {
  it("shows the loading state", () => {
    const client = clientWithFiles({
      list: vi.fn(
        () =>
          new Promise<ClientResult<FileListResponse>>(() => {
            // Intentionally pending.
          }),
      ),
    });
    renderViewerRoute("/s/notes", client);
    expect(screen.getByText("Loading files…")).toBeTruthy();
  });

  it("shows the empty file and change states", async () => {
    renderViewerRoute("/s/notes", createFakeViewerClient());
    expect(await screen.findByText("This stash has no live files.")).toBeTruthy();
    expect(screen.getByText("No changes have been recorded.")).toBeTruthy();
  });

  it("shows a file-list error with retry", async () => {
    const client = clientWithFiles({
      list: async () => ({
        ok: false,
        error: { status: 503, code: "internal", message: "D1 unavailable" },
      }),
    });
    renderViewerRoute("/s/notes", client);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("D1 unavailable");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("preserves the stash deep link on a 401 redirect", async () => {
    const client = clientWithFiles({
      list: async () => ({
        ok: false,
        error: { status: 401, code: "unauthorized", message: "Expired" },
      }),
    });
    const { router } = renderViewerRoute("/s/notes?view=all", client);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Fs%2Fnotes%3Fview%3Dall");
  });

  it("appends keyset pages without duplicates and re-queries deleted files", async () => {
    const first = file({ path: "folder/a.txt", headVersion: 1 });
    const duplicate = file({ path: "folder/b.txt", headVersion: 2 });
    const third = file({ path: "folder/c.txt", headVersion: 3 });
    const deleted = file({
      path: "archive/very-long-segment-without-any-break-point-0123456789.txt",
      headVersion: 4,
      hash: null,
      size: 0,
      deleted: true,
    });
    const list = vi.fn(async (options): Promise<ClientResult<FileListResponse>> => {
      if (options?.includeDeleted) {
        return { ok: true, value: { files: [deleted], nextAfter: null } };
      }
      if (options?.after === "folder/b.txt") {
        return { ok: true, value: { files: [duplicate, third], nextAfter: null } };
      }
      return {
        ok: true,
        value: { files: [first, duplicate], nextAfter: "folder/b.txt" },
      };
    });
    const changes = vi.fn(async (): Promise<ClientResult<ListChangesResult>> => ({
      ok: true,
      value: {
        changes: [change({ changeId: 5, stash: "notes", path: third.path })],
        hasMore: false,
        nextBefore: null,
      },
    }));
    const client = clientWithFiles({ list, changes });
    renderViewerRoute("/s/notes", client);

    const filesRegion = screen.getByRole("region", { name: "Files" });
    await within(filesRegion).findByRole("link", { name: "folder/a.txt" });
    await userEvent.click(within(filesRegion).getByRole("button", { name: "Load more" }));
    await within(filesRegion).findByRole("link", { name: "folder/c.txt" });
    expect(within(filesRegion).getAllByRole("link", { name: "folder/b.txt" })).toHaveLength(1);
    expect(list).toHaveBeenCalledWith({ includeDeleted: false });
    expect(list).toHaveBeenCalledWith({ includeDeleted: false, after: "folder/b.txt" });

    await userEvent.click(screen.getByRole("checkbox", { name: "Include deleted" }));
    const deletedLink = await within(filesRegion).findByRole("link", { name: deleted.path });
    expect(deletedLink.closest("td")?.className).toContain("list-path-cell");
    expect(screen.getByText("deleted")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ includeDeleted: true });
    expect(within(filesRegion).queryByRole("link", { name: "folder/a.txt" })).toBeNull();
  });
});
