import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createStashClient,
  type ClientResult,
  type ListProposalsOptions,
  type ProposalListResponse,
  type ProposalRecord,
  type StashClient,
  type StashProposalsClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { describe, expect, it, vi } from "vitest";
import { proposalListHref, proposalListStatusFrom } from "../app/proposal-routes.js";
import {
  createFakeBackedViewerClient,
  createFakeViewerClient,
} from "../test/fake-viewer-client.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

function proposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  const id = overrides.id ?? "prp_1787880000000abcdef12";
  return {
    id,
    stash: "notes",
    path: "docs/readme.txt",
    baseVersion: 2,
    author: "Ada",
    message: "Please review",
    meta: { proposalId: id },
    size: 20,
    hash: `sha256-${"c".repeat(64)}`,
    createdAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-09-10T12:00:00.000Z",
    status: "open",
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    appliedVersion: null,
    appliedChangeId: null,
    ...overrides,
  };
}

function clientWithProposalList(list: StashProposalsClient["list"]) {
  const base = createFakeViewerClient();
  return createFakeViewerClient({
    proposals: (stash) => ({ ...base.proposals(stash), list }),
  });
}

describe("proposal list routes", () => {
  it("refreshes live-only proposal state through the shared provider", async () => {
    const token = "viewer-proposals-live";
    const fake = createFakeStash({ adminToken: token });
    fake.createStash("notes");
    renderViewerRoute(
      "/s/notes/proposals",
      createFakeBackedViewerClient(fake, token, "viewer-live-tab"),
    );
    expect(await screen.findByText("No proposals match this filter.")).toBeTruthy();
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));

    const peer = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "peer-tab",
      fetch: fake.fetch,
    });
    const created = await peer.proposals("notes").create({
      path: "docs/live.txt",
      body: "candidate",
      baseVersion: null,
      author: "Peer",
      message: "Live proposal",
    });
    if (!created.ok) throw new Error(created.error.message);

    expect(await screen.findByRole("link", { name: "docs/live.txt" })).toBeTruthy();
    expect(screen.getByText("1 open proposal, newest first.")).toBeTruthy();
  });

  it("serializes canonical collection URLs and parses only the supported views", () => {
    expect(proposalListHref("team / docs")).toBe("/s/team%20%2F%20docs/proposals");
    expect(
      proposalListHref("team / docs", {
        status: "all",
        path: "folder/a file?#.txt",
      }),
    ).toBe("/s/team%20%2F%20docs/proposals?status=all&path=folder%2Fa+file%3F%23.txt");
    expect(proposalListHref("notes", { status: "open", path: "" })).toBe("/s/notes/proposals");
    expect(proposalListStatusFrom(new URLSearchParams("status=all"))).toBe("all");
    expect(proposalListStatusFrom(new URLSearchParams("status=closed"))).toBe("open");
  });

  it("renders the server total and detail href for the default open view", async () => {
    const record = proposal();
    const list = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [record], nextAfter: null, total: 7 },
    }));
    renderViewerRoute("/s/notes/proposals", clientWithProposalList(list));

    expect(screen.getByRole("heading", { level: 1, name: "Proposals" })).toBeTruthy();
    expect(await screen.findByText("7 open proposals, newest first.")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ status: "open" });
    expect(screen.getByRole("link", { name: record.path }).getAttribute("href")).toBe(
      `/s/notes/proposals/${record.id}`,
    );
    expect(screen.getByRole("navigation", { name: "Proposal status filter" })).toBeTruthy();
  });

  it("treats an empty optional path query as no path filter", async () => {
    const list = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 0 },
    }));
    renderViewerRoute("/s/notes/proposals?path=", clientWithProposalList(list));

    expect(await screen.findByText("No proposals match this filter.")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ status: "open" });
    expect(screen.queryByRole("status", { name: "Active proposal path filter" })).toBeNull();
  });

  it("preserves and clears the exact path while toggling open and all", async () => {
    const path = "docs/a file?#.txt";
    const list = vi.fn(
      async (options?: ListProposalsOptions): Promise<ClientResult<ProposalListResponse>> => ({
        ok: true,
        value: {
          proposals: [proposal({ path, status: options?.status === "all" ? "rejected" : "open" })],
          nextAfter: null,
          total: options?.status === "all" ? 4 : 1,
        },
      }),
    );
    const { router } = renderViewerRoute(
      `/s/notes/proposals?path=${encodeURIComponent(path)}`,
      clientWithProposalList(list),
    );
    const user = userEvent.setup();

    const filter = await screen.findByRole("status", { name: "Active proposal path filter" });
    expect(filter.textContent).toContain(path);
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "All" }).getAttribute("href")).toBe(
      "/s/notes/proposals?status=all&path=docs%2Fa+file%3F%23.txt",
    );

    await user.click(screen.getByRole("link", { name: "All" }));
    await waitFor(() => expect(router.state.location.search).toContain("status=all"));
    expect(
      await screen.findByText("4 proposals for docs/a file?#.txt, newest first."),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ status: "all", path });
    expect(
      within(filter).getByRole("link", { name: "Clear path filter" }).getAttribute("href"),
    ).toBe("/s/notes/proposals?status=all");

    await user.click(within(filter).getByRole("link", { name: "Clear path filter" }));
    await waitFor(() => expect(router.state.location.search).toBe("?status=all"));
    expect(screen.queryByRole("status", { name: "Active proposal path filter" })).toBeNull();
    expect(list).toHaveBeenCalledWith({ status: "all" });
  });

  it("shows a retryable list error", async () => {
    const list = vi
      .fn<StashProposalsClient["list"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { status: 503, code: "internal", message: "Proposal index unavailable" },
      })
      .mockResolvedValue({
        ok: true,
        value: { proposals: [], nextAfter: null, total: 0 },
      });
    renderViewerRoute("/s/notes/proposals", clientWithProposalList(list));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Proposal index unavailable");
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No proposals match this filter.")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("aborts the old view and ignores a transport that resolves it late", async () => {
    let resolveOpen!: (result: ClientResult<ProposalListResponse>) => void;
    const openResult = new Promise<ClientResult<ProposalListResponse>>((resolve) => {
      resolveOpen = resolve;
    });
    const openSignal: { current: AbortSignal | null } = { current: null };
    const client = createFakeViewerClient();
    client.withSignal = (signal): StashClient => ({
      ...client,
      proposals: (stash) => ({
        ...client.proposals(stash),
        list: async (options) => {
          if (options?.status === "all") {
            return {
              ok: true,
              value: {
                proposals: [proposal({ id: "prp_1787880000001abcdef13", status: "rejected" })],
                nextAfter: null,
                total: 1,
              },
            };
          }
          openSignal.current = signal;
          return openResult;
        },
      }),
    });
    const { router } = renderViewerRoute("/s/notes/proposals", client);

    await waitFor(() => expect(openSignal.current).not.toBeNull());
    await userEvent.click(screen.getByRole("link", { name: "All" }));
    expect(await screen.findByText("1 proposal, newest first.")).toBeTruthy();
    expect(openSignal.current?.aborted).toBe(true);

    await act(async () => {
      resolveOpen({
        ok: true,
        value: {
          proposals: [proposal({ author: "Late open author" })],
          nextAfter: null,
          total: 99,
        },
      });
      await openResult;
    });
    expect(router.state.location.search).toBe("?status=all");
    expect(screen.getByText("1 proposal, newest first.")).toBeTruthy();
    expect(screen.queryByText("Late open author")).toBeNull();
  });
});
