import type {
  ClientResult,
  CommitDiffResult,
  CommitRecord,
  StashCommitsClient,
} from "@takazudo/zudo-history-stash";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerPage } from "./page-test-utils.js";
import CommitPage, { commitCreatedLocationState } from "./commit.js";

type MeOverride = NonNullable<Parameters<typeof createFakeViewerClient>[0]>["me"];

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    id: "cmt_1",
    stash: "notes",
    source: "viewer",
    sourceId: null,
    author: "Ada",
    message: "Atomic edit",
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

function clientWithCommits(me: MeOverride, overrides: Partial<StashCommitsClient> = {}) {
  const base = createFakeViewerClient({ me });
  return createFakeViewerClient({
    me: base.me,
    commits: (stash) => ({ ...base.commits(stash), ...overrides }),
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

function emptyDiff(): ClientResult<CommitDiffResult> {
  return { ok: true, value: { entries: [], truncated: false } };
}

describe("CommitPage", () => {
  it("loads commit metadata and hides revert controls from a read principal", async () => {
    const value = commit();
    const client = clientWithCommits(reader, {
      get: async () => ({ ok: true, value }),
      diff: async () => emptyDiff(),
    });
    renderViewerPage("/s/notes/commits/cmt_1", "/s/:stash/commits/:id", <CommitPage />, client, {
      liveAccess: "write",
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Atomic edit" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All commits" }).getAttribute("href")).toBe(
      "/s/notes/commits",
    );
    expect(screen.queryByRole("button", { name: "Revert commit" })).toBeNull();
  });

  it("shows a request error with a retry action", async () => {
    renderViewerPage(
      "/s/notes/commits/cmt_1",
      "/s/:stash/commits/:id",
      <CommitPage />,
      clientWithCommits(reader, {
        get: async () => ({
          ok: false as const,
          error: { status: 404, code: "not-found" as const, message: "Commit is gone" },
        }),
      }),
      { liveAccess: "write" },
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Commit is gone");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reverts with write access and routes to the resulting commit with a flash", async () => {
    const original = commit();
    const reverted = commit({
      id: "cmt_reverted",
      message: "Revert: Atomic edit",
      revertsCommitId: original.id,
    });
    let current = original;
    const base = createFakeViewerClient({ me: admin });
    const client = createFakeViewerClient({
      me: base.me,
      commits: (stash) => ({
        ...base.commits(stash),
        get: async (id) => ({ ok: true, value: id === reverted.id ? reverted : current }),
        diff: async () => emptyDiff(),
        revert: async () => {
          current = reverted;
          return { ok: true, value: reverted };
        },
      }),
    });
    const { router } = renderViewerPage(
      "/s/notes/commits/cmt_1",
      "/s/:stash/commits/:id",
      <CommitPage />,
      client,
      { liveAccess: "write" },
    );

    expect(await screen.findByRole("button", { name: "Revert commit" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Revert commit" }));
    const dialog = await screen.findByRole("dialog", { name: "Revert commit" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Revert commit" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert commit" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/s/notes/commits/cmt_reverted"),
    );
    expect(
      (await screen.findByRole("status", { name: "Commit creation confirmation" })).textContent,
    ).toContain("Revert complete. Created commit cmt_reverted.");
    expect(screen.getByRole("heading", { level: 2, name: "Revert: Atomic edit" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Revert commit" })).toBeNull();
  });

  it("consumes approval flash while preserving unrelated location state", async () => {
    const value = commit({ id: "cmt_approved" });
    const { router } = renderViewerPage(
      {
        pathname: "/s/notes/commits/cmt_approved",
        state: { ...commitCreatedLocationState(value.id, "approval"), tab: "diff" },
      },
      "/s/:stash/commits/:id",
      <CommitPage />,
      clientWithCommits(reader, {
        get: async () => ({ ok: true, value }),
        diff: async () => emptyDiff(),
      }),
      { liveAccess: "write" },
    );
    expect(
      (await screen.findByRole("status", { name: "Commit creation confirmation" })).textContent,
    ).toContain("Change set approved as commit cmt_approved.");
    await waitFor(() => expect(router.state.location.state).toEqual({ tab: "diff" }));
    expect(screen.getByRole("status", { name: "Commit creation confirmation" })).toBeTruthy();
  });

  it("reports missing route parameters", () => {
    renderViewerPage("/commit", "/commit", <CommitPage />, clientWithCommits(reader), {
      liveAccess: "write",
    });
    expect(screen.getByText("The stash name or commit id is missing from this URL.")).toBeTruthy();
  });
});
