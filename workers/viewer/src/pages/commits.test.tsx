import type {
  ClientResult,
  CommitListResponse,
  CommitRecord,
  CommitSummary,
  StashCommitsClient,
} from "@takazudo/zudo-history-stash";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerPage } from "./page-test-utils.js";
import CommitsPage from "./commits.js";

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    id: "cmt_1",
    stash: "notes",
    source: "viewer",
    sourceId: null,
    author: "Ada",
    message: "Atomic edit",
    meta: {},
    entryCount: 1,
    firstChangeId: 1,
    lastChangeId: 1,
    revertsCommitId: null,
    createdBy: "admin",
    createdAt: "2026-08-25T08:00:00.000Z",
    entries: [],
    ...overrides,
  };
}

function summary(overrides: Partial<CommitRecord> = {}): CommitSummary {
  const { entries: _entries, ...value } = commit(overrides);
  return value;
}

function clientWithCommits(
  overrides: Partial<StashCommitsClient> = {},
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
    commits: (stash) => ({ ...base.commits(stash), ...overrides }),
  });
}

describe("CommitsPage", () => {
  it("loads atomic commits, applies a path query, and appends keyset pages", async () => {
    const first = summary({ id: "cmt_1", message: "First commit" });
    const duplicate = summary({ id: "cmt_1", message: "Duplicate commit" });
    const second = summary({ id: "cmt_2", message: "Second commit" });
    const list = vi.fn(
      async (options?: {
        after?: string;
        path?: string;
      }): Promise<ClientResult<CommitListResponse>> =>
        options?.after
          ? { ok: true, value: { commits: [duplicate, second], nextAfter: null, total: 2 } }
          : { ok: true, value: { commits: [first], nextAfter: "cursor-1", total: 2 } },
    );
    const { router } = renderViewerPage(
      "/s/notes/commits",
      "/s/:stash/commits",
      <CommitsPage />,
      clientWithCommits({ list }),
      { liveAccess: "write" },
    );

    expect(await screen.findByText("First commit")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change sets" }).getAttribute("href")).toBe(
      "/s/notes/change-sets",
    );
    expect(screen.getByText("2 total")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second commit")).toBeTruthy();
    expect(screen.getAllByText(/commit$/u)).toHaveLength(2);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Filter by path" }),
      "docs/readme.txt",
    );
    await waitFor(() => expect(router.state.location.search).toBe("?path=docs%2Freadme.txt"));
    expect(list).toHaveBeenCalledWith({ path: "docs/readme.txt" });
  });

  it("shows loading and request errors with retry", async () => {
    const pending = new Promise<ClientResult<CommitListResponse>>(() => {
      // Intentionally pending.
    });
    const loading = renderViewerPage(
      "/s/notes/commits",
      "/s/:stash/commits",
      <CommitsPage />,
      clientWithCommits({ list: vi.fn(() => pending) }),
      { liveAccess: "write" },
    );
    expect(screen.getByText("Loading commits…")).toBeTruthy();
    loading.unmount();

    const list = vi.fn(async () => ({
      ok: false as const,
      error: { status: 503, code: "internal" as const, message: "History unavailable" },
    }));
    renderViewerPage(
      "/s/notes/commits",
      "/s/:stash/commits",
      <CommitsPage />,
      clientWithCommits({ list }),
      { liveAccess: "write" },
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("History unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("renders a missing-stash error without requesting data", () => {
    const list = vi.fn();
    renderViewerPage("/commits", "/commits", <CommitsPage />, clientWithCommits({ list }), {
      liveAccess: "write",
    });
    expect(screen.getByText("The stash name is missing from this URL.")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });
});
