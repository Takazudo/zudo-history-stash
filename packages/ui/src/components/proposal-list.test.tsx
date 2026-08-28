import { createStashClient, type ProposalRecord } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { ProposalList } from "./proposal-list.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const BASE_URL = "https://proposal-list.test";

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function createProposal(
  client: ReturnType<typeof createStashClient>,
  input: {
    path: string;
    body: string;
    baseVersion: number | null;
    author: string;
    message: string;
  },
): Promise<ProposalRecord> {
  const result = await client.proposals(STASH).create(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("ProposalList", () => {
  it("refetches live-only proposal state when the host advances its refresh revision", async () => {
    const adminToken = "proposal-list-live-admin";
    const fake = createFakeStash({ adminToken });
    fake.createStash(STASH);
    const client = createStashClient({ baseUrl: BASE_URL, token: adminToken, fetch: fake.fetch });
    const view = (refreshRevision: number) => (
      <StashUiProvider client={client}>
        <ProposalList refreshRevision={refreshRevision} stash={STASH} />
      </StashUiProvider>
    );
    const rendered = render(view(0));
    expect(await screen.findByText("No proposals match this filter.")).toBeTruthy();

    await createProposal(client, {
      path: PATH,
      body: "live candidate\n",
      baseVersion: null,
      author: "Peer",
      message: "Live refresh",
    });
    rendered.rerender(view(1));

    expect(await screen.findByText("Live refresh")).toBeTruthy();
    expect(screen.getByText("1 open proposal, newest first.")).toBeTruthy();
  });

  it("renders the server-filtered total and proposal rows through host routing", async () => {
    const adminToken = "proposal-list-admin";
    const fake = createFakeStash({
      adminToken,
      now: () => Date.parse("2026-08-28T00:00:00.000Z"),
    });
    fake.createStash(STASH);
    const client = createStashClient({ baseUrl: BASE_URL, token: adminToken, fetch: fake.fetch });
    const seeded = await client.files(STASH).put(PATH, {
      body: "base\n",
      expectedVersion: null,
      author: "Fixture",
      message: "Seed",
    });
    if (!seeded.ok) throw new Error(seeded.error.message);

    const first = await createProposal(client, {
      path: PATH,
      body: "first candidate\n",
      baseVersion: 1,
      author: "Ada",
      message: "First proposal",
    });
    await createProposal(client, {
      path: "docs/other.txt",
      body: "other candidate\n",
      baseVersion: null,
      author: "Other",
      message: "Filtered out",
    });
    const second = await createProposal(client, {
      path: PATH,
      body: "second candidate\n",
      baseVersion: 1,
      author: "Grace",
      message: "Second proposal",
    });
    const applied = await client.proposals(STASH).approve(first.id);
    if (!applied.ok) throw new Error(applied.error.message);

    const clientForSignal = vi.fn(() => client);
    render(
      <StashUiProvider client={client} clientForSignal={clientForSignal}>
        <ProposalList limit={1} path={PATH} stash={STASH} status="all" />
      </StashUiProvider>,
    );

    expect(await screen.findByText(`2 proposals for ${PATH}, newest first.`)).toBeTruthy();
    expect(clientForSignal).toHaveBeenCalled();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Grace")).toBeTruthy();
    expect(within(table).getByText("Second proposal")).toBeTruthy();
    expect(within(table).getByLabelText("Proposal status: open")).toBeTruthy();
    const link = within(table).getByRole("link", { name: PATH });
    expect(link.getAttribute("href")).toBe(`/s/${STASH}/proposals/${second.id}`);
    expect(table.querySelector("time")?.getAttribute("dateTime")).toBe("2026-08-28T00:00:00.000Z");

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(table).getAllByRole("link", { name: PATH })).toHaveLength(2));
    expect(within(table).getByText("Ada")).toBeTruthy();
    expect(within(table).getByText("First proposal")).toBeTruthy();
    expect(within(table).getByLabelText("Proposal status: applied")).toBeTruthy();
  });

  it("aborts a superseded pagination owner and ignores its forced late result", async () => {
    const adminToken = "proposal-list-pagination-admin";
    const fake = createFakeStash({ adminToken });
    fake.createStash(STASH);
    const client = createStashClient({ baseUrl: BASE_URL, token: adminToken, fetch: fake.fetch });
    await createProposal(client, {
      path: PATH,
      body: "older candidate\n",
      baseVersion: null,
      author: "Ada",
      message: "Older proposal",
    });
    await createProposal(client, {
      path: PATH,
      body: "newer candidate\n",
      baseVersion: null,
      author: "Grace",
      message: "Newer proposal",
    });
    const nextPath = "docs/next.txt";
    await createProposal(client, {
      path: nextPath,
      body: "next candidate\n",
      baseVersion: null,
      author: "Lin",
      message: "Next target",
    });

    const pageStarted = deferred<void>();
    const pageRelease = deferred<void>();
    const pageFinished = deferred<void>();
    const pageSignal: { current: AbortSignal | null } = { current: null };
    let delayed = false;
    const clientForSignal = (signal: AbortSignal) =>
      createStashClient({
        baseUrl: BASE_URL,
        token: adminToken,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (!delayed && url.searchParams.has("after") && url.searchParams.get("path") === PATH) {
            delayed = true;
            pageSignal.current = signal;
            pageStarted.resolve();
            await pageRelease.promise;
            const response = await fake.fetch(input, init);
            pageFinished.resolve();
            return response;
          }
          return fake.fetch(input, init);
        },
      });
    const view = (path: string) => (
      <StashUiProvider client={client} clientForSignal={clientForSignal}>
        <ProposalList limit={1} path={path} stash={STASH} status="all" />
      </StashUiProvider>
    );
    const rendered = render(view(PATH));
    expect(await screen.findByText(`2 proposals for ${PATH}, newest first.`)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await pageStarted.promise;

    rendered.rerender(view(nextPath));
    expect(await screen.findByText(`1 proposal for ${nextPath}, newest first.`)).toBeTruthy();
    expect(pageSignal.current?.aborted).toBe(true);
    await act(async () => {
      pageRelease.resolve();
      await pageFinished.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Lin")).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.queryByText("Grace")).toBeNull();
  });

  it("commits a blocked live refresh before a queued same-target retry can fail", async () => {
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    let calls = 0;
    let commandCalls = 0;
    let gateCommands = false;
    let active = 0;
    let maxActive = 0;
    const client = createStashClient({
      baseUrl: BASE_URL,
      token: "proposal-list-command",
      fetch: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (gateCommands) commandCalls += 1;
          if (commandCalls === 1) await firstRelease.promise;
          if (commandCalls === 2) await secondRelease.promise;
          if (commandCalls === 2) {
            return Response.json(
              { error: { code: "internal", message: "proposal refresh failed" } },
              { status: 503 },
            );
          }
          if (commandCalls === 1) {
            return Response.json({ proposals: [], nextAfter: null, total: 7 });
          }
          return Response.json({ proposals: [], nextAfter: null, total: 0 });
        } finally {
          active -= 1;
        }
      },
    });
    let refresh: ((signal: AbortSignal) => Promise<void>) | null = null;
    render(
      <StashUiProvider client={client} clientForSignal={() => client}>
        <ProposalList
          registerLiveRefresh={(registered) => {
            refresh = registered;
            return () => {
              if (refresh === registered) refresh = null;
            };
          }}
          stash={STASH}
        />
      </StashUiProvider>,
    );
    expect(await screen.findByText("No proposals match this filter.")).toBeTruthy();
    if (refresh === null) throw new Error("Proposal refresh did not register");
    const initialCalls = calls;
    gateCommands = true;

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = refresh?.(new AbortController().signal) ?? Promise.resolve();
      second = refresh?.(new AbortController().signal) ?? Promise.resolve();
    });
    const secondFailure = second.catch((error: unknown) => error);
    await waitFor(() => expect(calls).toBe(initialCalls + 1));

    await act(async () => firstRelease.resolve());
    await first;
    expect(screen.getByText("7 open proposals, newest first.")).toBeTruthy();
    await waitFor(() => expect(calls).toBe(initialCalls + 2));
    await act(async () => secondRelease.resolve());
    const failure = await secondFailure;

    expect(failure).toBeTruthy();
    expect(maxActive).toBe(1);
    expect((await screen.findByRole("alert")).textContent).toContain("proposal refresh failed");
  });
});
