import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createStashClient,
  type CreateTokenResult,
  type StashClient,
  type StashFetch,
  type TokenRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { RevokeTokenDialog } from "./revoke-token-dialog.js";
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

function deferred() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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

function tokenRecord(id: string, label: string): TokenRecord {
  return {
    id,
    label,
    scope: "read",
    createdAt: "2026-08-26T09:00:00.000Z",
    expiresAt: null,
    rotatedFrom: null,
    rotatedTo: null,
    lastUsedAt: null,
    revokedAt: null,
  };
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

  it("keeps a gated mint exclusive across a new client and exposes its exact origin secret", async () => {
    const fixture = makeFixture();
    const archive = "archive";
    fixture.fake.createStash(archive);
    const postStarted = deferred();
    const postGate = deferred();
    const postFinished = deferred();
    let mintedSecret = "";
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      const isNotesMint = request.method === "POST" && pathname === `/v1/stashes/${STASH}/tokens`;
      if (isNotesMint) {
        postStarted.resolve();
        await postGate.promise;
      }
      const response = await fixture.fake.fetch(request);
      if (isNotesMint) {
        const body = (await response.clone().json()) as CreateTokenResult;
        mintedSecret = body.token;
        postFinished.resolve();
      }
      return response;
    };
    fixture.requests.length = 0;
    fixture.client = trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests, signal);
    const user = userEvent.setup();
    const rendered = renderPanel(fixture);
    await screen.findByText("No tokens have been minted for this stash.");

    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "first token");
    await user.click(screen.getByRole("button", { name: "Mint token" }));
    await postStarted.promise;

    const archiveClient = trackedClient(ADMIN_TOKEN, fixture.fake.fetch, fixture.requests);
    const archiveClientForSignal = (signal: AbortSignal) =>
      trackedClient(ADMIN_TOKEN, fixture.fake.fetch, fixture.requests, signal);
    rendered.rerender(
      <StashUiProvider client={archiveClient} clientForSignal={archiveClientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    const archiveMint = (await screen.findByRole("button", {
      name: "Mint token",
    })) as HTMLButtonElement;
    expect(archiveMint.disabled).toBe(true);
    const archiveForm = archiveMint.closest("form");
    if (archiveForm === null) throw new Error("Expected the mint button to be inside a form");
    fireEvent.submit(archiveForm);
    await act(async () => Promise.resolve());
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.pathname.endsWith("/tokens"),
      ),
    ).toHaveLength(1);
    const archiveListPath = `/v1/stashes/${archive}/tokens`;
    const archiveListsBeforeSettle = fixture.requests.filter(
      (request) => request.method === "GET" && request.pathname === archiveListPath,
    ).length;

    await act(async () => {
      postGate.resolve();
      await postFinished.promise;
    });
    const visibleSecret = (await screen.findByRole("textbox", {
      name: "New token secret",
    })) as HTMLInputElement;
    expect(mintedSecret).toMatch(/^zhs_/);
    expect(visibleSecret.value).toBe(mintedSecret);
    const secretPanel = visibleSecret.closest<HTMLElement>(".zhs-tokens-secret");
    if (secretPanel === null) throw new Error("Expected the one-time secret panel");
    expect(secretPanel.textContent).toContain("Origin stash: notes");
    expect(within(secretPanel).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(
      fixture.requests.filter(
        (request) => request.method === "GET" && request.pathname === archiveListPath,
      ),
    ).toHaveLength(archiveListsBeforeSettle);
    expect((screen.getByRole("button", { name: "Mint token" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "I stored it" }));
    expect((screen.getByRole("button", { name: "Mint token" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "second token");
    await user.click(screen.getByRole("button", { name: "Mint token" }));
    const secondSecret = (await screen.findByRole("textbox", {
      name: "New token secret",
    })) as HTMLInputElement;
    expect(secondSecret.value).not.toBe(mintedSecret);
    const secondSecretPanel = secondSecret.closest(".zhs-tokens-secret");
    if (secondSecretPanel === null) throw new Error("Expected the second one-time secret panel");
    expect(secondSecretPanel.textContent).toContain("Origin stash: archive");
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.pathname.endsWith("/tokens"),
      ),
    ).toHaveLength(2);
  });

  it("unlocks a new client after an old mint rejects without bleeding its error", async () => {
    const fixture = makeFixture();
    const archive = "archive";
    fixture.fake.createStash(archive);
    const postStarted = deferred();
    const postGate = deferred();
    const postRejected = deferred();
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (request.method === "POST" && pathname === `/v1/stashes/${STASH}/tokens`) {
        postStarted.resolve();
        await postGate.promise;
        postRejected.resolve();
        throw new Error("old notes mint failed");
      }
      return fixture.fake.fetch(request);
    };
    fixture.requests.length = 0;
    fixture.client = trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests, signal);
    const user = userEvent.setup();
    const rendered = renderPanel(fixture);
    await screen.findByText("No tokens have been minted for this stash.");

    await user.click(screen.getByRole("button", { name: "Mint token" }));
    await postStarted.promise;
    const archiveClient = trackedClient(ADMIN_TOKEN, fixture.fake.fetch, fixture.requests);
    const archiveClientForSignal = (signal: AbortSignal) =>
      trackedClient(ADMIN_TOKEN, fixture.fake.fetch, fixture.requests, signal);
    rendered.rerender(
      <StashUiProvider client={archiveClient} clientForSignal={archiveClientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    const archiveMint = (await screen.findByRole("button", {
      name: "Mint token",
    })) as HTMLButtonElement;
    expect(archiveMint.disabled).toBe(true);

    await act(async () => {
      postGate.resolve();
      await postRejected.promise;
    });
    await waitFor(() => expect(archiveMint.disabled).toBe(false));
    expect(screen.queryByText("Could not mint the token")).toBeNull();
    expect(screen.queryByText("old notes mint failed")).toBeNull();
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.pathname.endsWith("/tokens"),
      ),
    ).toHaveLength(1);

    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "archive token");
    await user.click(archiveMint);
    const archiveSecret = await screen.findByRole("textbox", { name: "New token secret" });
    const secretPanel = archiveSecret.closest(".zhs-tokens-secret");
    if (secretPanel === null) throw new Error("Expected the archive one-time secret panel");
    expect(secretPanel.textContent).toContain("Origin stash: archive");
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.pathname.endsWith("/tokens"),
      ),
    ).toHaveLength(2);
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

  it("keeps a pending revoke dialog atomic when Escape requests close", async () => {
    const user = userEvent.setup();
    const request = deferred();
    const onClose = vi.fn();
    render(
      <RevokeTokenDialog
        open={true}
        operationKey={{ stash: "notes", token: "token-a" }}
        token={tokenRecord("token-a", "release bot")}
        onClose={onClose}
        onConfirm={() => request.promise}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Revoke token" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));
    expect(
      (within(dialog).getByRole("button", { name: "Revoking…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Revoke token" })).toBeTruthy();

    await act(async () => {
      request.resolve();
      await request.promise;
    });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a returned semantic target pending and refreshes it after revoke succeeds", async () => {
    const fixture = makeFixture();
    const archive = "archive";
    fixture.fake.createStash(archive);
    const token = await seedToken(fixture.seedClient, STASH, "notes bot", "write");
    const deleteStarted = deferred();
    const deleteGate = deferred();
    const deleteFinished = deferred();
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      const isNotesDelete = request.method === "DELETE" && pathname.endsWith(`/tokens/${token.id}`);
      if (isNotesDelete) {
        deleteStarted.resolve();
        await deleteGate.promise;
      }
      const response = await fixture.fake.fetch(request);
      if (isNotesDelete) deleteFinished.resolve();
      return response;
    };
    fixture.requests.length = 0;
    fixture.client = trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests, signal);
    const user = userEvent.setup();
    const rendered = renderPanel(fixture);

    await user.click(await screen.findByRole("button", { name: "Revoke notes bot" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await deleteStarted.promise;
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${token.id}`),
      ),
    ).toHaveLength(1);

    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    await screen.findByText("No tokens have been minted for this stash.");
    expect(screen.queryByRole("dialog", { name: "Revoke token" })).toBeNull();

    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={STASH} />
      </StashUiProvider>,
    );
    const returnedDialog = await screen.findByRole("dialog", { name: "Revoke token" });
    const pendingButton = within(returnedDialog).getByRole("button", {
      name: "Revoking…",
    }) as HTMLButtonElement;
    expect(pendingButton.disabled).toBe(true);
    fireEvent.click(pendingButton);
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${token.id}`),
      ),
    ).toHaveLength(1);
    const notesListPath = `/v1/stashes/${STASH}/tokens`;
    await screen.findByRole("table", { name: `Tokens for ${STASH}` });
    const listsBeforeSettle = fixture.requests.filter(
      (request) => request.method === "GET" && request.pathname === notesListPath,
    ).length;

    await act(async () => {
      deleteGate.resolve();
      await deleteFinished.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revoke token" })).toBeNull());
    const table = await screen.findByRole("table", { name: `Tokens for ${STASH}` });
    await waitFor(() => {
      expect(table.querySelector(`[data-token-id="${token.id}"]`)?.textContent).toContain(
        "Revoked",
      );
    });
    expect(
      fixture.requests.filter(
        (request) => request.method === "GET" && request.pathname === notesListPath,
      ).length,
    ).toBeGreaterThan(listsBeforeSettle);
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${token.id}`),
      ),
    ).toHaveLength(1);
  });

  it("restores a gated revoke failure only to its exact returned operation", async () => {
    const fixture = makeFixture();
    const archive = "archive";
    fixture.fake.createStash(archive);
    const notesToken = await seedToken(fixture.seedClient, STASH, "notes bot", "write");
    await seedToken(fixture.seedClient, archive, "archive bot", "write");
    const deleteStarted = deferred();
    const deleteGate = deferred();
    const deleteRejected = deferred();
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (request.method === "DELETE" && pathname.endsWith(`/tokens/${notesToken.id}`)) {
        deleteStarted.resolve();
        await deleteGate.promise;
        deleteRejected.resolve();
        throw new Error("notes revoke failed");
      }
      return fixture.fake.fetch(request);
    };
    fixture.requests.length = 0;
    fixture.client = trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests, signal);
    const user = userEvent.setup();
    const rendered = renderPanel(fixture);

    await user.click(await screen.findByRole("button", { name: "Revoke notes bot" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await deleteStarted.promise;
    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    await screen.findByRole("button", { name: "Revoke archive bot" });
    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={STASH} />
      </StashUiProvider>,
    );
    const returnedDialog = await screen.findByRole("dialog", { name: "Revoke token" });
    expect(
      (
        within(returnedDialog).getByRole("button", {
          name: "Revoking…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      deleteGate.resolve();
      await deleteRejected.promise;
    });
    expect(await within(returnedDialog).findByText("notes revoke failed")).toBeTruthy();
    expect(
      (within(returnedDialog).getByRole("button", { name: "Confirm revoke" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      fixture.requests.filter(
        (request) => request.method === "DELETE" && request.pathname.endsWith(`/${notesToken.id}`),
      ),
    ).toHaveLength(1);

    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Revoke archive bot" }));
    const archiveDialog = screen.getByRole("dialog", { name: "Revoke token" });
    expect(within(archiveDialog).queryByText("notes revoke failed")).toBeNull();
    expect(within(archiveDialog).getByText("archive bot")).toBeTruthy();
  });

  it("binds revoke errors to the exact target and token operation", async () => {
    const user = userEvent.setup();
    const oldRequest = deferred();
    const oldOperation = { stash: "notes", token: "token-shared" };
    const newOperation = { stash: "archive", token: "token-shared" };
    const newConfirm = vi.fn(async () => {
      throw new Error("new selection failed");
    });
    const rendered = render(
      <RevokeTokenDialog
        open={true}
        operationKey={oldOperation}
        token={tokenRecord("token-shared", "notes bot")}
        onClose={() => undefined}
        onConfirm={() => oldRequest.promise}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    rendered.rerender(
      <RevokeTokenDialog
        open={true}
        operationKey={newOperation}
        token={tokenRecord("token-shared", "archive bot")}
        onClose={() => undefined}
        onConfirm={newConfirm}
      />,
    );
    expect(screen.getByText("archive bot")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm revoke" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await act(async () => {
      oldRequest.reject(new Error("old selection failed"));
      await oldRequest.promise.catch(() => undefined);
    });
    expect(screen.queryByText("old selection failed")).toBeNull();
    expect(screen.getByText("archive bot")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByText("new selection failed")).toBeTruthy();
    expect(newConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not let an old revoke completion clear a newer target selection", async () => {
    const fixture = makeFixture();
    const archive = "archive";
    fixture.fake.createStash(archive);
    await seedToken(fixture.seedClient, STASH, "notes bot", "write");
    await seedToken(fixture.seedClient, archive, "archive bot", "write");
    const oldDeleteStarted = deferred();
    const oldDeleteGate = deferred();
    const oldDeleteFinished = deferred();
    const delayedFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      const isOldDelete =
        request.method === "DELETE" && pathname.includes(`/stashes/${STASH}/tokens/`);
      if (isOldDelete) {
        oldDeleteStarted.resolve();
        await oldDeleteGate.promise;
      }
      const response = await fixture.fake.fetch(request);
      if (isOldDelete) oldDeleteFinished.resolve();
      return response;
    };
    fixture.requests.length = 0;
    fixture.client = trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests);
    fixture.clientForSignal = (signal) =>
      trackedClient(ADMIN_TOKEN, delayedFetch, fixture.requests, signal);
    const user = userEvent.setup();
    const rendered = renderPanel(fixture);

    await user.click(await screen.findByRole("button", { name: "Revoke notes bot" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await oldDeleteStarted.promise;
    rendered.rerender(
      <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
        <TokensPanel stash={archive} />
      </StashUiProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Revoke archive bot" }));
    let archiveDialog = screen.getByRole("dialog", { name: "Revoke token" });
    expect(within(archiveDialog).getByText("archive bot")).toBeTruthy();

    await act(async () => {
      oldDeleteGate.resolve();
      await oldDeleteFinished.promise;
    });
    await waitFor(() => {
      archiveDialog = screen.getByRole("dialog", { name: "Revoke token" });
      expect(within(archiveDialog).getByText("archive bot")).toBeTruthy();
    });
    expect(
      (
        within(archiveDialog).getByRole("button", {
          name: "Confirm revoke",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
