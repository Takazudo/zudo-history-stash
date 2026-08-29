import type {
  ChangeSetDiffResult,
  ChangeSetRecord,
  ClientResult,
  CommitRecord,
  StashChangeSetsClient,
  StashCommitsClient,
} from "@takazudo/zudo-history-stash";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerPage } from "./page-test-utils.js";
import ChangeSetPage from "./change-set.js";
import CommitPage from "./commit.js";

type MeOverride = NonNullable<Parameters<typeof createFakeViewerClient>[0]>["me"];

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

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    id: "cmt_approved",
    stash: "notes",
    source: "change-set",
    sourceId: "chs_1",
    author: "Ada",
    message: "Approved change",
    meta: {},
    entryCount: 0,
    firstChangeId: 0,
    lastChangeId: 0,
    revertsCommitId: null,
    createdBy: "admin",
    createdAt: "2026-08-25T08:00:00.000Z",
    entries: [],
    ...overrides,
  };
}

function emptyDiff(): ClientResult<ChangeSetDiffResult> {
  return { ok: true, value: { entries: [], stale: false, status: "open", truncated: false } };
}

function clientWithReview(
  me: MeOverride,
  changeSetOverrides: Partial<StashChangeSetsClient> = {},
  commitOverrides: Partial<StashCommitsClient> = {},
) {
  const base = createFakeViewerClient({ me });
  return createFakeViewerClient({
    me: base.me,
    commits: (stash) => ({ ...base.commits(stash), ...commitOverrides }),
    changeSets: (stash) => ({ ...base.changeSets(stash), ...changeSetOverrides }),
  });
}

const admin = async () => ({ ok: true as const, value: { principal: "admin" as const } });
const reader = async () => ({
  ok: true as const,
  value: {
    principal: "stash" as const,
    stash: "notes",
    tokenId: "read",
    scope: "read" as const,
    expiresAt: null,
  },
});

describe("ChangeSetPage", () => {
  it("renders a read-only review and preserves its decision gate", async () => {
    const value = changeSet();
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(reader, {
        get: async () => ({ ok: true, value }),
        diff: async () => emptyDiff(),
      }),
      { liveAccess: "write" },
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Review this change" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "All change sets" }).getAttribute("href")).toBe(
      "/s/notes/change-sets",
    );
    expect(
      await screen.findByText("Write access is required to approve or reject this change set."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("lazy-loads every record path missing from a truncated read-only diff", async () => {
    const value = changeSet({
      entries: [
        { path: "inline.txt", op: "put", baseVersion: null, current: null, stale: false },
        { path: "lazy.txt", op: "delete", baseVersion: 1, current: null, stale: false },
      ],
    });
    const inline = {
      path: "inline.txt",
      op: "put" as const,
      base: null,
      candidate: null,
      current: null,
      stale: false,
      diff: { state: "same" as const },
    };
    const lazy = {
      path: "lazy.txt",
      op: "delete" as const,
      base: null,
      candidate: null,
      current: null,
      stale: false,
      diff: { state: "same" as const },
    };
    const diff = vi.fn(async (_id: string, options?: { path?: string }) => ({
      ok: true as const,
      value: {
        entries: options?.path === "lazy.txt" ? [lazy] : [inline],
        stale: false,
        status: "open" as const,
        truncated: options?.path === undefined,
      },
    }));
    const client = clientWithReview(reader, {
      get: async () => ({ ok: true, value }),
      diff,
    });
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      client,
      { liveAccess: "write" },
    );
    expect(await screen.findByText("inline.txt")).toBeTruthy();
    expect(await screen.findByText("lazy.txt")).toBeTruthy();
    expect(screen.getAllByText("Candidate deletes this path")).toHaveLength(2);
    expect(diff).toHaveBeenCalledWith("chs_1", { path: "lazy.txt" });
  });

  it("rejects a change set and renders the refreshed authoritative decision", async () => {
    const open = changeSet();
    const rejected = changeSet({
      status: "rejected",
      decidedAt: "2026-08-26T08:00:00.000Z",
      decidedBy: "admin",
      decisionReason: "Not ready",
    });
    let current = open;
    const client = clientWithReview(admin, {
      get: async () => ({ ok: true, value: current }),
      diff: async () => emptyDiff(),
      reject: async (_id, input) => {
        current = rejected;
        expect(input).toEqual({ reason: "Not ready" });
        return { ok: true, value: rejected };
      },
    });
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      client,
      { liveAccess: "write" },
    );

    await screen.findByRole("button", { name: "Reject" });
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject change set" });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason (optional)" }),
      "Not ready",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Decision: rejected")).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
  });

  it("routes an approved change set to its resulting commit with a flash", async () => {
    const open = changeSet();
    const approved = changeSet({
      status: "applied",
      decidedAt: "2026-08-26T08:00:00.000Z",
      decidedBy: "admin",
      commitId: "cmt_approved",
    });
    const resultingCommit = commit();
    let current = open;
    const client = clientWithReview(
      admin,
      {
        get: async () => ({ ok: true, value: current }),
        diff: async () => emptyDiff(),
        approve: async () => {
          current = approved;
          return { ok: true, value: { status: "applied", commit: resultingCommit } };
        },
      },
      {
        get: async () => ({ ok: true, value: resultingCommit }),
        diff: async () => ({ ok: true, value: { entries: [], truncated: false } }),
      },
    );
    const { router } = renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      client,
      { liveAccess: "write" },
      [{ path: "/s/:stash/commits/:id", element: <CommitPage /> }],
    );

    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve change set" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/s/notes/commits/cmt_approved"),
    );
    expect(
      (await screen.findByRole("status", { name: "Commit creation confirmation" })).textContent,
    ).toContain("Change set approved as commit cmt_approved.");
  });

  it("keeps an in-progress decision dialog mounted during a live refresh", async () => {
    const value = changeSet();
    let releaseRefresh!: (result: ClientResult<ChangeSetRecord>) => void;
    const pendingRefresh = new Promise<ClientResult<ChangeSetRecord>>((resolve) => {
      releaseRefresh = resolve;
    });
    let blockRefresh = false;
    const get = vi.fn(async () => (blockRefresh ? pendingRefresh : { ok: true as const, value }));
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(admin, {
        get,
        diff: async () => emptyDiff(),
      }),
      { liveAccess: "write" },
    );

    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve change set" });
    const author = within(dialog).getByRole("textbox", { name: "Author" });
    await userEvent.type(author, "Grace");

    const callsBeforeRefresh = get.mock.calls.length;
    blockRefresh = true;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));

    expect(screen.getByRole("dialog", { name: "Approve change set" })).toBe(dialog);
    expect((author as HTMLInputElement).value).toBe("Grace");
    expect(within(dialog).getByRole("button", { name: "Approve and apply" })).toBeTruthy();

    await act(async () => releaseRefresh({ ok: true, value }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Approve change set" })).toBe(dialog),
    );
  });

  it("adopts a relevant entry refresh and closes a now-stale decision dialog", async () => {
    const value = changeSet();
    const staleValue = changeSet({
      entries: [{ ...value.entries[0]!, stale: true }],
    });
    let releaseRefresh!: (result: ClientResult<ChangeSetRecord>) => void;
    let pendingRefresh: Promise<ClientResult<ChangeSetRecord>> | null = null;
    const get = vi.fn(async () => pendingRefresh ?? { ok: true as const, value });
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(admin, {
        get,
        diff: async () => emptyDiff(),
      }),
      { liveAccess: "write" },
    );

    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByRole("dialog", { name: "Approve change set" });

    pendingRefresh = new Promise<ClientResult<ChangeSetRecord>>((resolve) => {
      releaseRefresh = resolve;
    });
    const callsBeforeRefresh = get.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    pendingRefresh = null;
    await act(async () => releaseRefresh({ ok: true, value: staleValue }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Approve change set" })).toBeNull(),
    );
    expect(screen.getByText("This change set contains stale entries.")).toBeTruthy();
  });

  it("keeps an in-progress decision dialog mounted when a background refresh fails", async () => {
    const value = changeSet();
    let releaseRefresh!: (result: ClientResult<ChangeSetRecord>) => void;
    const pendingRefresh = new Promise<ClientResult<ChangeSetRecord>>((resolve) => {
      releaseRefresh = resolve;
    });
    let blockRefresh = false;
    const get = vi.fn(async () => (blockRefresh ? pendingRefresh : { ok: true as const, value }));
    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(admin, { get, diff: async () => emptyDiff() }),
      { liveAccess: "write" },
    );

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve change set" });
    const author = within(dialog).getByRole("textbox", { name: "Author" });
    await userEvent.type(author, "Grace");

    const callsBeforeRefresh = get.mock.calls.length;
    blockRefresh = true;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    await act(async () =>
      releaseRefresh({
        ok: false,
        error: { status: 503, code: "internal", message: "Refresh unavailable" },
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Refresh unavailable");
    expect(screen.getByRole("dialog", { name: "Approve change set" })).toBe(dialog);
    expect((author as HTMLInputElement).value).toBe("Grace");
  });

  it("shows loading and request errors, plus missing parameters", async () => {
    const pending = new Promise<ClientResult<ChangeSetRecord>>(() => {
      // Intentionally pending.
    });
    const loading = renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(reader, { get: async () => pending }),
      { liveAccess: "write" },
    );
    expect(screen.getByText("Loading change set…")).toBeTruthy();
    loading.unmount();

    renderViewerPage(
      "/s/notes/change-sets/chs_1",
      "/s/:stash/change-sets/:id",
      <ChangeSetPage />,
      clientWithReview(reader, {
        get: async () => ({
          ok: false as const,
          error: { status: 503, code: "internal" as const, message: "Review unavailable" },
        }),
      }),
      { liveAccess: "write" },
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Review unavailable");

    renderViewerPage("/change-set", "/change-set", <ChangeSetPage />, clientWithReview(reader), {
      liveAccess: "write",
    });
    expect(
      screen.getByText("The stash name or change-set id is missing from this URL."),
    ).toBeTruthy();
  });
});
