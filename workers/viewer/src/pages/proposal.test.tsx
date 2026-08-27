import {
  createStashClient,
  type ProposalRecord,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  PROPOSAL_CREATED_FLASH_MESSAGE,
  proposalCreatedLocationState,
} from "../app/proposal-routes.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { viewerRoutes } from "../app/router.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "viewer-admin";
const STASH = "notes";
const PATH = "docs/readme.txt";

interface ProposalFixture {
  fake: FakeStash;
  proposal: ProposalRecord;
}

function withSignal(fetch: StashFetch, signal: AbortSignal): StashFetch {
  return (input, init) => fetch(input, init?.signal ? init : { ...init, signal });
}

function viewerClient(fake: FakeStash, token: string): ViewerStashClient {
  const create = (signal?: AbortSignal): StashClient =>
    createStashClient({
      baseUrl: BASE_URL,
      token,
      fetch: signal === undefined ? fake.fetch : withSignal(fake.fetch, signal),
    });
  const client = create();
  return {
    ...client,
    me: (options) => (options?.signal ? create(options.signal) : client).me(),
    withSignal: (signal) => create(signal),
  };
}

async function createProposalFixture(): Promise<ProposalFixture> {
  const fake = createFakeStash({
    adminToken: ADMIN_TOKEN,
    now: () => Date.parse("2026-08-27T12:00:00.000Z"),
  });
  fake.createStash(STASH);
  const admin = viewerClient(fake, ADMIN_TOKEN);
  const head = await admin.files(STASH).put(PATH, {
    body: "base body\n",
    expectedVersion: null,
    author: "Fixture",
    message: "Base",
  });
  if (!head.ok) throw new Error(head.error.message);
  const created = await admin.proposals(STASH).create({
    path: PATH,
    body: "base body\ncandidate line\n",
    baseVersion: head.value.version,
    author: "Ada",
    message: "Please review",
  });
  if (!created.ok) throw new Error(created.error.message);
  return { fake, proposal: created.value };
}

describe("ProposalPage", () => {
  it("renders the immutable review for a read principal without write controls", async () => {
    const fixture = await createProposalFixture();
    const readToken = await fixture.fake.mintToken(STASH, "read");
    const client = viewerClient(fixture.fake, readToken);
    const me = vi.fn(client.me);
    client.me = me;
    renderViewerRoute(`/s/${STASH}/proposals/${fixture.proposal.id}`, client);

    expect(await screen.findByRole("heading", { level: 1, name: PATH })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("region", { name: PATH })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Base → candidate" })).toBeTruthy();
    expect(screen.getByText("candidate line")).toBeTruthy();
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();
  });

  it("leaves decision affordances to the package capability gate", async () => {
    const fixture = await createProposalFixture();
    renderViewerRoute(
      `/s/${STASH}/proposals/${fixture.proposal.id}`,
      viewerClient(fixture.fake, ADMIN_TOKEN),
    );

    expect(await screen.findByRole("button", { name: "Approve…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject…" })).toBeTruthy();
  });

  it("consumes the typed creation flash once under StrictMode and preserves unrelated state", async () => {
    const fixture = await createProposalFixture();
    const { router } = renderViewerRoute(
      {
        pathname: `/s/${STASH}/proposals/${fixture.proposal.id}`,
        state: { ...proposalCreatedLocationState(), returnTo: "proposal queue" },
      },
      viewerClient(fixture.fake, ADMIN_TOKEN),
      { strict: true },
    );

    const confirmation = await screen.findByRole("status", {
      name: "Proposal creation confirmation",
    });
    expect(confirmation.textContent).toContain(PROPOSAL_CREATED_FLASH_MESSAGE);
    expect(screen.getAllByRole("status", { name: "Proposal creation confirmation" })).toHaveLength(
      1,
    );
    await waitFor(() =>
      expect(router.state.location.state).toEqual({ returnTo: "proposal queue" }),
    );
    expect(
      screen.getByRole("status", { name: "Proposal creation confirmation" }).textContent,
    ).toContain(PROPOSAL_CREATED_FLASH_MESSAGE);

    await userEvent.click(within(confirmation).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status", { name: "Proposal creation confirmation" })).toBeNull();
  });

  it("never renders arbitrary location state as proposal confirmation copy", async () => {
    const fixture = await createProposalFixture();
    renderViewerRoute(
      {
        pathname: `/s/${STASH}/proposals/${fixture.proposal.id}`,
        state: { proposalFlash: "Previous principal private note" },
      },
      viewerClient(fixture.fake, ADMIN_TOKEN),
    );

    expect(await screen.findByRole("heading", { level: 1, name: PATH })).toBeTruthy();
    expect(screen.queryByText("Previous principal private note")).toBeNull();
    expect(screen.queryByRole("status", { name: "Proposal creation confirmation" })).toBeNull();
  });

  it("clears a rejected credential and preserves the proposal deep link", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          "http://localhost",
        );
        if (url.pathname.endsWith("/v1/me")) {
          return Response.json({
            principal: "stash",
            stash: STASH,
            tokenId: "tok_read",
            scope: "read",
            expiresAt: null,
          });
        }
        return Response.json(
          { error: { code: "unauthorized", message: "Expired" } },
          { status: 401 },
        );
      }),
    );
    const id = "prp_1787880000000abcdef12";
    const router = createMemoryRouter(viewerRoutes, {
      initialEntries: [`/s/${STASH}/proposals/${id}`],
    });
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent(`/s/${STASH}/proposals/${id}`)}`,
    );
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
