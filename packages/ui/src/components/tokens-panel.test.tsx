import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createStashClient,
  type CreateTokenResult,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { TokensPanel } from "./tokens-panel.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";
const STASH = "notes";

interface RecordedRequest {
  method: string;
  pathname: string;
}

interface Fixture {
  fake: FakeStash;
  seedClient: StashClient;
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  requests: RecordedRequest[];
}

function clientWithFetch(token: string, fetch: StashFetch): StashClient {
  return createStashClient({ baseUrl: BASE_URL, token, fetch });
}

function trackedClient(
  token: string,
  fetch: StashFetch,
  requests: RecordedRequest[],
  signal?: AbortSignal,
): StashClient {
  return clientWithFetch(token, async (input, init) => {
    const request = new Request(input, { ...init, ...(signal ? { signal } : {}) });
    requests.push({ method: request.method, pathname: new URL(request.url).pathname });
    return fetch(request);
  });
}

function makeFixture(): Fixture {
  let now = Date.UTC(2026, 7, 26, 9, 0, 0);
  const fake = createFakeStash({
    adminToken: ADMIN_TOKEN,
    now: () => {
      const current = now;
      now += 60_000;
      return current;
    },
  });
  fake.createStash(STASH);
  const requests: RecordedRequest[] = [];
  const seedClient = clientWithFetch(ADMIN_TOKEN, fake.fetch);
  return {
    fake,
    seedClient,
    client: trackedClient(ADMIN_TOKEN, fake.fetch, requests),
    clientForSignal: (signal) => trackedClient(ADMIN_TOKEN, fake.fetch, requests, signal),
    requests,
  };
}

async function seedToken(
  client: StashClient,
  stash: string,
  label: string,
  scope: "read" | "write",
): Promise<CreateTokenResult> {
  const result = await client.stashes.tokens(stash).create({ label, scope });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function renderPanel(fixture: Fixture, stash = STASH) {
  return render(
    <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
      <TokensPanel stash={stash} />
    </StashUiProvider>,
  );
}

describe("TokensPanel", () => {
  it("waits for the admin capability to resolve before listing tokens", async () => {
    const fixture = makeFixture();
    let releaseMe = () => {};
    const meGate = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    let notifyMeStarted = () => {};
    const meStarted = new Promise<void>((resolve) => {
      notifyMeStarted = resolve;
    });
    fixture.requests.length = 0;
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      fixture.requests.push({ method: request.method, pathname });
      const response = fixture.fake.fetch(request);
      if (pathname === "/v1/me") {
        notifyMeStarted();
        await meGate;
      }
      return response;
    };
    fixture.client = clientWithFetch(ADMIN_TOKEN, delayedFetch);
    fixture.clientForSignal = (signal) =>
      clientWithFetch(ADMIN_TOKEN, (input, init) => delayedFetch(input, { ...init, signal }));

    renderPanel(fixture);
    await meStarted;
    await act(async () => Promise.resolve());
    expect(fixture.requests).toEqual([{ method: "GET", pathname: "/v1/me" }]);

    await act(async () => {
      releaseMe();
      await meGate;
    });
    expect(await screen.findByText("No tokens have been minted for this stash.")).toBeTruthy();
    expect(fixture.requests).toContainEqual({
      method: "GET",
      pathname: `/v1/stashes/${STASH}/tokens`,
    });
  });

  it("lists deterministic newest-first public records including usage and revoked state", async () => {
    const fixture = makeFixture();
    const older = await seedToken(fixture.seedClient, STASH, "older reader", "read");
    const newer = await seedToken(fixture.seedClient, STASH, "newer writer", "write");
    const olderClient = clientWithFetch(older.token, fixture.fake.fetch);
    const authenticated = await olderClient.me();
    if (!authenticated.ok) throw new Error(authenticated.error.message);
    const revoked = await fixture.seedClient.stashes.tokens(STASH).revoke(older.id);
    if (!revoked.ok) throw new Error(revoked.error.message);

    renderPanel(fixture);

    const table = await screen.findByRole("table", { name: `Tokens for ${STASH}` });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-token-id")).toBe(newer.id);
    expect(rows[0]?.textContent).toContain("newer writer");
    expect(rows[0]?.textContent).toContain("write");
    expect(rows[0]?.textContent).toContain("Never");
    expect(rows[0]?.textContent).toContain("Active");
    expect(rows[1]?.getAttribute("data-token-id")).toBe(older.id);
    expect(rows[1]?.textContent).toContain("older reader");
    expect(rows[1]?.textContent).toContain("Revoked");
    expect(within(rows[1] as HTMLElement).getAllByRole("time")).toHaveLength(3);
    expect(table.textContent).not.toContain(older.token);
    expect(table.textContent).not.toContain(newer.token);
    expect(fixture.fake.state.tokens.get(older.id)).not.toHaveProperty("token");
    expect(fixture.fake.state.tokens.get(newer.id)).not.toHaveProperty("token");
  });

  it("shows one ephemeral minted secret, warns for write scope, and reports copy failure", async () => {
    const fixture = makeFixture();
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log");
    renderPanel(fixture);
    await screen.findByText("No tokens have been minted for this stash.");

    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "deploy bot");
    await user.selectOptions(screen.getByRole("combobox", { name: "Scope" }), "write");
    expect(
      screen.getByText(/Do not expose a write token in a public browser application/),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Mint token" }));
    const secretInput = (await screen.findByRole("textbox", {
      name: "New token secret",
    })) as HTMLInputElement;
    const secret = secretInput.value;
    expect(secret).toMatch(/^zhs_/);
    expect(screen.getByText("Shown once — store it now")).toBeTruthy();
    expect(
      screen.getByText(
        "If this response was lost before you copied it, the secret is unrecoverable: revoke this token and mint a new one",
      ),
    ).toBeTruthy();

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard denied"));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(secret);
    const copyFailure = await screen.findByText(
      "Copy failed. Select the secret above and copy it manually.",
    );
    expect(copyFailure.getAttribute("role")).toBe("alert");

    const table = await screen.findByRole("table", { name: `Tokens for ${STASH}` });
    expect(within(table).getByText("deploy bot")).toBeTruthy();
    expect(table.textContent).not.toContain(secret);
    expect(setItem).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "I stored it" }));
    expect(screen.queryByRole("textbox", { name: "New token secret" })).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(secret);
  });

  it("requires an explicit revoke confirmation and refreshes the authoritative revoked row", async () => {
    const fixture = makeFixture();
    const token = await seedToken(fixture.seedClient, STASH, "release bot", "write");
    const user = userEvent.setup();
    renderPanel(fixture);

    await user.click(await screen.findByRole("button", { name: "Revoke release bot" }));
    let dialog = screen.getByRole("dialog", { name: "Revoke token" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revoke token" })).toBeNull());
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${token.id}`),
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Revoke release bot" }));
    dialog = screen.getByRole("dialog", { name: "Revoke token" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));

    const table = await screen.findByRole("table", { name: `Tokens for ${STASH}` });
    await waitFor(() => {
      const row = table.querySelector(`[data-token-id="${token.id}"]`);
      expect(row?.textContent).toContain("Revoked");
    });
    expect(screen.queryByRole("button", { name: "Revoke release bot" })).toBeNull();
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${token.id}`),
      ),
    ).toHaveLength(1);
    expect(
      fixture.requests.filter(
        (request) => request.method === "GET" && request.pathname.endsWith("/tokens"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders not available for a stash principal and records only the me request", async () => {
    const fixture = makeFixture();
    const stashToken = await fixture.fake.mintToken(STASH, "write");
    fixture.requests.length = 0;
    fixture.client = trackedClient(stashToken, fixture.fake.fetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(stashToken, fixture.fake.fetch, fixture.requests, signal);

    renderPanel(fixture);

    expect(await screen.findByText("Token administration is not available")).toBeTruthy();
    await act(async () => Promise.resolve());
    expect(fixture.requests).toEqual([{ method: "GET", pathname: "/v1/me" }]);
  });

  it("ignores a stale list result when a fallback signal client cannot cancel transport", async () => {
    const fixture = makeFixture();
    const otherStash = "archive";
    fixture.fake.createStash(otherStash);
    await seedToken(fixture.seedClient, STASH, "notes token", "read");
    await seedToken(fixture.seedClient, otherStash, "archive token", "read");

    let releaseNotes = () => {};
    const notesGate = new Promise<void>((resolve) => {
      releaseNotes = resolve;
    });
    let notifyNotesStarted = () => {};
    const notesStarted = new Promise<void>((resolve) => {
      notifyNotesStarted = resolve;
    });
    fixture.requests.length = 0;
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      fixture.requests.push({ method: request.method, pathname });
      const response = fixture.fake.fetch(request);
      if (request.method === "GET" && pathname === `/v1/stashes/${STASH}/tokens`) {
        notifyNotesStarted();
        await notesGate;
      }
      return response;
    };
    fixture.client = clientWithFetch(ADMIN_TOKEN, delayedFetch);
    const signals: AbortSignal[] = [];
    fixture.clientForSignal = (signal) => {
      signals.push(signal);
      return fixture.client;
    };

    const rendered = renderPanel(fixture);
    await notesStarted;
    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={otherStash} />
      </StashUiProvider>,
    );

    expect(await screen.findByText("archive token")).toBeTruthy();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      releaseNotes();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText("notes token")).toBeNull());
    expect(screen.getByText("archive token")).toBeTruthy();
  });
});
