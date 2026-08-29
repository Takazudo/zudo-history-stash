import {
  createStashClient,
  type ClientResult,
  type FileListResponse,
  type FileSummary,
  type ListChangesResult,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  change,
  createFakeBackedViewerClient,
  createFakeViewerClient,
} from "../test/fake-viewer-client.js";
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
  it("refreshes files and changes from the shared live provider", async () => {
    const token = "viewer-stash-live";
    const fake = createFakeStash({ adminToken: token });
    fake.createStash("notes");
    const seed = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "fixture",
      fetch: fake.fetch,
    });
    const first = await seed
      .files("notes")
      .put("docs/first.txt", { body: "first", expectedVersion: null });
    if (!first.ok) throw new Error(first.error.message);
    renderViewerRoute("/s/notes", createFakeBackedViewerClient(fake, token, "viewer-live-tab"));

    const filesRegion = screen.getByRole("region", { name: "Files" });
    expect(await within(filesRegion).findByRole("link", { name: "docs/first.txt" })).toBeTruthy();
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));

    const peer = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "peer-tab",
      fetch: fake.fetch,
    });
    const second = await peer
      .files("notes")
      .put("docs/second.txt", { body: "second", expectedVersion: null });
    if (!second.ok) throw new Error(second.error.message);
    expect(await within(filesRegion).findByRole("link", { name: "docs/second.txt" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Recent changes").closest("section")?.textContent).toContain(
        "docs/second.txt",
      ),
    );
  });

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
    expect(deletedLink.closest("td")?.className).toContain("zhs-path-cell");
    expect(screen.getByText("deleted")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ includeDeleted: true });
    expect(within(filesRegion).queryByRole("link", { name: "folder/a.txt" })).toBeNull();
  });

  it("shows New file and Tokens entry points to an admin", async () => {
    renderViewerRoute("/s/notes", createFakeViewerClient());

    expect((await screen.findByRole("link", { name: "New file" })).getAttribute("href")).toBe(
      "/s/notes/new",
    );
    expect(screen.getByRole("link", { name: "Tokens" }).getAttribute("href")).toBe(
      "/s/notes/tokens",
    );
    expect(screen.getByRole("button", { name: "Delete stash" })).toBeTruthy();
  });

  it("links recent history surfaces and shows the authoritative open change-set count", async () => {
    const base = createFakeViewerClient();
    const client = createFakeViewerClient({
      changeSets: (stash) => ({
        ...base.changeSets(stash),
        list: async () => ({
          ok: true as const,
          value: { changeSets: [], nextAfter: null, total: 3 },
        }),
      }),
    });
    renderViewerRoute("/s/notes", client);

    await screen.findByText("This stash has no live files.");
    expect(screen.getByRole("link", { name: "Commits" }).getAttribute("href")).toBe(
      "/s/notes/commits",
    );
    expect(screen.getByRole("link", { name: "Change sets (3 open)" }).getAttribute("href")).toBe(
      "/s/notes/change-sets",
    );
  });

  it("shows only New file to a matching write principal", async () => {
    const remove = vi.fn(async () => ({
      ok: true as const,
      value: {
        name: "notes",
        deletedAt: "2026-08-27T00:00:00.000Z",
        revokedTokens: 1,
        restoreUntil: "2026-09-26T00:00:00.000Z",
      },
    }));
    const client = createFakeViewerClient({
      me: async () => ({
        ok: true,
        value: {
          principal: "stash",
          stash: "notes",
          tokenId: "tok_write",
          scope: "write",
          expiresAt: null,
        },
      }),
      stashes: { delete: remove },
    });
    renderViewerRoute("/s/notes", client);

    expect((await screen.findByRole("link", { name: "New file" })).getAttribute("href")).toBe(
      "/s/notes/new",
    );
    expect(screen.queryByRole("link", { name: "Tokens" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete stash" })).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps the server restore deadline visible until deletion is acknowledged", async () => {
    const remove = vi.fn(async () => ({
      ok: true as const,
      value: {
        name: "notes",
        deletedAt: "2026-08-27T00:00:00.000Z",
        revokedTokens: 2,
        restoreUntil: "2026-09-26T00:00:00.000Z",
      },
    }));
    const { router } = renderViewerRoute(
      "/s/notes",
      createFakeViewerClient({ stashes: { delete: remove } }),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Delete stash" }));
    const dialog = screen.getByRole("dialog", { name: /Delete/ });
    await user.click(within(dialog).getByRole("button", { name: "Delete stash" }));

    await waitFor(() => expect(dialog.textContent).toContain("2026-09-26T00:00:00.000Z"));
    expect(router.state.location.pathname).toBe("/s/notes");
    expect(dialog.textContent).toContain("cannot be reused after restore");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(remove).toHaveBeenCalledWith("notes");
  });
});
