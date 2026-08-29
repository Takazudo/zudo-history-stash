import type {
  ChangeSetListResponse,
  ChangeSetRecord,
  ClientResult,
  StashChangeSetsClient,
} from "@takazudo/zudo-history-stash";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerPage } from "./page-test-utils.js";
import ChangeSetsPage from "./change-sets.js";

function changeSet(overrides: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: "chs_1",
    stash: "notes",
    status: "open",
    author: "Ada",
    message: "Review this change",
    meta: {},
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdBy: "admin",
    createdAt: "2026-08-25T08:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    commitId: null,
    entries: [
      { path: "docs/readme.txt", op: "put", baseVersion: null, current: null, stale: false },
    ],
    ...overrides,
  };
}

function clientWithChangeSets(
  overrides: Partial<StashChangeSetsClient> = {},
): ReturnType<typeof createFakeViewerClient> {
  const base = createFakeViewerClient({
    me: async () => ({
      ok: true as const,
      value: {
        principal: "stash" as const,
        stash: "notes",
        tokenId: "read",
        scope: "read" as const,
        expiresAt: null,
      },
    }),
  });
  return createFakeViewerClient({
    me: base.me,
    changeSets: (stash) => ({ ...base.changeSets(stash), ...overrides }),
  });
}

describe("ChangeSetsPage", () => {
  it("loads change sets and persists status and path filters in the URL", async () => {
    const open = changeSet({ id: "chs_open", message: "Open review" });
    const list = vi.fn(
      async (options?: {
        status?: string;
        path?: string;
      }): Promise<ClientResult<ChangeSetListResponse>> => ({
        ok: true,
        value: {
          changeSets: options?.status === "applied" ? [] : [open],
          nextAfter: null,
          total: options?.status === "applied" ? 0 : 1,
        },
      }),
    );
    const { router } = renderViewerPage(
      "/s/notes/change-sets",
      "/s/:stash/change-sets",
      <ChangeSetsPage />,
      clientWithChangeSets({ list }),
      { liveAccess: "write" },
    );

    expect(await screen.findByText("Open review")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Commits" }).getAttribute("href")).toBe(
      "/s/notes/commits",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Change set status" }),
      "applied",
    );
    await waitFor(() => expect(router.state.location.search).toBe("?status=applied"));
    expect(list).toHaveBeenLastCalledWith({ status: "applied" });

    fireEvent.change(screen.getByRole("textbox", { name: "Filter by path" }), {
      target: { value: "docs/readme.txt" },
    });
    await waitFor(() =>
      expect(router.state.location.search).toBe("?status=applied&path=docs%2Freadme.txt"),
    );
    expect(list).toHaveBeenLastCalledWith({ status: "applied", path: "docs/readme.txt" });
  });

  it("appends pages without duplicate change sets and shows request errors", async () => {
    const first = changeSet({ id: "chs_1", message: "First review" });
    const duplicate = changeSet({ id: "chs_1", message: "Duplicate review" });
    const second = changeSet({ id: "chs_2", message: "Second review" });
    const list = vi.fn(
      async (options?: { after?: string }): Promise<ClientResult<ChangeSetListResponse>> =>
        options?.after
          ? { ok: true, value: { changeSets: [duplicate, second], nextAfter: null, total: 2 } }
          : { ok: true, value: { changeSets: [first], nextAfter: "cursor-1", total: 2 } },
    );
    renderViewerPage(
      "/s/notes/change-sets",
      "/s/:stash/change-sets",
      <ChangeSetsPage />,
      clientWithChangeSets({ list }),
      { liveAccess: "write" },
    );

    expect(await screen.findByText("First review")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second review")).toBeTruthy();
    expect(screen.getAllByText(/review$/u)).toHaveLength(2);
  });

  it("hides the previous filter while a new filter is loading", async () => {
    let releaseApplied!: (result: ClientResult<ChangeSetListResponse>) => void;
    const applied = new Promise<ClientResult<ChangeSetListResponse>>((resolve) => {
      releaseApplied = resolve;
    });
    const list = vi.fn(
      async (options?: { status?: string }): Promise<ClientResult<ChangeSetListResponse>> =>
        options?.status === "applied"
          ? applied
          : {
              ok: true,
              value: {
                changeSets: [changeSet({ message: "Open review" })],
                nextAfter: null,
                total: 1,
              },
            },
    );
    renderViewerPage(
      "/s/notes/change-sets",
      "/s/:stash/change-sets",
      <ChangeSetsPage />,
      clientWithChangeSets({ list }),
      { liveAccess: "write" },
    );

    expect(await screen.findByText("Open review")).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Change set status" }),
      "applied",
    );
    expect(await screen.findByText("Loading change sets…")).toBeTruthy();
    expect(screen.queryByText("Open review")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Change sets" })).toBeNull();

    releaseApplied({ ok: true, value: { changeSets: [], nextAfter: null, total: 0 } });
    expect(await screen.findByText("No change sets found.")).toBeTruthy();
  });

  it("shows loading and server errors", async () => {
    const pending = new Promise<ClientResult<ChangeSetListResponse>>(() => {
      // Intentionally pending.
    });
    const loading = renderViewerPage(
      "/s/notes/change-sets",
      "/s/:stash/change-sets",
      <ChangeSetsPage />,
      clientWithChangeSets({ list: vi.fn(() => pending) }),
      { liveAccess: "write" },
    );
    expect(screen.getByText("Loading change sets…")).toBeTruthy();
    loading.unmount();

    renderViewerPage(
      "/s/notes/change-sets",
      "/s/:stash/change-sets",
      <ChangeSetsPage />,
      clientWithChangeSets({
        list: async () => ({
          ok: false as const,
          error: { status: 503, code: "internal" as const, message: "Review service unavailable" },
        }),
      }),
      { liveAccess: "write" },
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Review service unavailable");
  });
});
