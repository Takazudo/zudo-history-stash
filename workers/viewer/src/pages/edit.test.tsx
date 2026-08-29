import { createStashClient, type StashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "@takazudo/zudo-history-stash-ui";
import {
  StashClientProvider,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { ViewerLiveUpdatesProvider } from "../app/live-updates.js";
import { ViewerStashUiProvider } from "../app/viewer-stash-ui-provider.js";
import { createFakeBackedViewerClient } from "../test/fake-viewer-client.js";
import EditPage from "./edit.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "viewer-admin";
const STASH = "notes";
const PATH = "docs/readme.txt";

interface Fixture {
  fake: FakeStash;
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  remoteClient: StashClient;
  requests: Request[];
}

function withSignal(fetch: StashFetch, signal: AbortSignal): StashFetch {
  return (input, init) => fetch(input, init?.signal ? init : { ...init, signal });
}

async function createFixture(token = ADMIN_TOKEN): Promise<Fixture> {
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
  fake.createStash(STASH);
  const seedClient = createStashClient({
    baseUrl: BASE_URL,
    token: ADMIN_TOKEN,
    fetch: fake.fetch,
  });
  const first = await seedClient.files(STASH).put(PATH, {
    body: "first body\n",
    expectedVersion: null,
    author: "Fixture",
    message: "First",
  });
  if (!first.ok) throw new Error(first.error.message);
  const second = await seedClient.files(STASH).put(PATH, {
    body: "head body\n",
    expectedVersion: first.value.version,
    author: "Fixture",
    message: "Head",
  });
  if (!second.ok) throw new Error(second.error.message);

  const requests: Request[] = [];
  const fetch = vi.fn<StashFetch>(async (input, init) => {
    requests.push(new Request(input, init));
    return fake.fetch(input, init);
  });
  return {
    fake,
    client: createStashClient({ baseUrl: BASE_URL, token, fetch }),
    clientForSignal: (signal) =>
      createStashClient({ baseUrl: BASE_URL, token, fetch: withSignal(fetch, signal) }),
    remoteClient: seedClient,
    requests,
  };
}

function FileDestination() {
  const location = useLocation();
  const state = location.state as { flash?: string } | null;
  return (
    <div>
      <p>File destination</p>
      <output aria-label="destination path">{location.pathname}</output>
      <output aria-label="destination flash">{state?.flash ?? ""}</output>
    </div>
  );
}

function renderEditRoute(initialEntry: string, fixture: Fixture) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
            <Outlet />
          </StashUiProvider>
        ),
        children: [
          { path: "/s/:stash/edit/*", element: <EditPage /> },
          { path: "/s/:stash/f/*", element: <FileDestination /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function renderLiveEditRoute(
  initialEntry: string,
  fixture: Fixture,
  suppliedFactory?: ViewerStashClientFactory,
) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, ADMIN_TOKEN);
  let clientId = "";
  const clientFactory: ViewerStashClientFactory = (options) => {
    clientId = options.clientId;
    return (
      suppliedFactory?.(options) ??
      createFakeBackedViewerClient(fixture.fake, ADMIN_TOKEN, options.clientId)
    );
  };
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <ViewerStashUiProvider>
              <ViewerLiveUpdatesProvider>
                <Outlet />
              </ViewerLiveUpdatesProvider>
            </ViewerStashUiProvider>
          </StashClientProvider>
        ),
        children: [{ path: "/s/:stash/edit/*", element: <EditPage /> }],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { clientId: () => clientId, router, ...render(<RouterProvider router={router} />) };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function mockWideViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockWideViewport();
});

describe("EditPage", () => {
  it("marks only an authoritative foreign same-path live change stale without replacing the draft", async () => {
    const fixture = await createFixture();
    const rendered = renderLiveEditRoute("/s/notes/edit/docs/readme.txt", fixture);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "keep my dirty draft\n" } });
    await waitFor(() => expect(fixture.fake.events.subscriberCount(STASH)).toBe(1));
    await flushMicrotasks();

    const unrelated = await fixture.remoteClient.files(STASH).put("docs/other.txt", {
      body: "unrelated",
      expectedVersion: null,
      author: "Peer",
      message: "Unrelated",
    });
    if (!unrelated.ok) throw new Error(unrelated.error.message);
    await flushMicrotasks();
    expect(screen.queryByText(/Head moved to v/u)).toBeNull();
    expect(editor.value).toBe("keep my dirty draft\n");

    const ownClient = createStashClient({
      baseUrl: BASE_URL,
      token: ADMIN_TOKEN,
      clientId: rendered.clientId(),
      fetch: fixture.fake.fetch,
    });
    const own = await ownClient.files(STASH).put(PATH, {
      body: "own tab write\n",
      expectedVersion: 2,
      author: "Me",
      message: "Own origin",
    });
    if (!own.ok) throw new Error(own.error.message);
    await flushMicrotasks();
    expect(screen.queryByText(/Head moved to v/u)).toBeNull();
    expect(editor.value).toBe("keep my dirty draft\n");

    const foreign = await fixture.remoteClient.files(STASH).put(PATH, {
      body: "foreign write\n",
      expectedVersion: own.value.version,
      author: "Peer",
      message: "Foreign same path",
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    expect(await screen.findByText(`Head moved to v${foreign.value.version} by Peer`)).toBeTruthy();
    expect(editor.value).toBe("keep my dirty draft\n");
    expect(screen.getByText(/remains fenced to v2/u)).toBeTruthy();
  });

  it("retains a ready refresh until the edit workbench registers during its initial load", async () => {
    const fixture = await createFixture();
    let releaseInitialHead!: () => void;
    let markInitialHeadStarted!: () => void;
    const initialHeadGate = new Promise<void>((resolve) => {
      releaseInitialHead = resolve;
    });
    const initialHeadStarted = new Promise<void>((resolve) => {
      markInitialHeadStarted = resolve;
    });
    let initialHeadCaptured = false;
    let changesFeedCalls = 0;

    const factory: ViewerStashClientFactory = ({ token, clientId }) => {
      const create = (signal?: AbortSignal): StashClient =>
        createStashClient({
          baseUrl: BASE_URL,
          token,
          clientId,
          fetch: async (input, init) => {
            const requestInit = signal && !init?.signal ? { ...init, signal } : init;
            const request = new Request(input, requestInit);
            const url = new URL(request.url);
            if (url.pathname === "/v1/stashes/notes/changes") changesFeedCalls += 1;
            if (
              !initialHeadCaptured &&
              request.method === "GET" &&
              url.pathname === "/v1/stashes/notes/files/docs/readme.txt" &&
              !url.searchParams.has("version")
            ) {
              initialHeadCaptured = true;
              const response = await fixture.fake.fetch(input, requestInit);
              markInitialHeadStarted();
              await initialHeadGate;
              return response;
            }
            return fixture.fake.fetch(input, requestInit);
          },
        });
      const client = create();
      return {
        ...client,
        me: ({ signal } = {}) => create(signal).me(),
        withSignal: (signal) => create(signal),
      };
    };

    renderLiveEditRoute("/s/notes/edit/docs/readme.txt", fixture, factory);
    await initialHeadStarted;
    await waitFor(() => expect(changesFeedCalls).toBeGreaterThan(0));

    const foreign = await fixture.remoteClient.files(STASH).put(PATH, {
      body: "foreign during workbench gate\n",
      expectedVersion: 2,
      author: "Peer",
      message: "Ready gap",
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    await flushMicrotasks(32);
    releaseInitialHead();

    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    expect(editor.value).toBe("head body\n");
    expect(await screen.findByText(`Head moved to v${foreign.value.version} by Peer`)).toBeTruthy();
    expect(editor.value).toBe("head body\n");
    expect(screen.getByText(/remains fenced to v2/u)).toBeTruthy();
  });

  it("aborts a blocked old edit refresh so navigation can reconcile the new stash", async () => {
    const fixture = await createFixture();
    fixture.fake.createStash("archive");
    const archived = await fixture.remoteClient.files("archive").put(PATH, {
      body: "archived body\n",
      expectedVersion: null,
      author: "Fixture",
      message: "Archive",
    });
    if (!archived.ok) throw new Error(archived.error.message);

    let blockNotesHead = false;
    let blockedSignal: AbortSignal | undefined;
    let markBlocked!: () => void;
    let markArchiveFeed!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const archiveFeed = new Promise<void>((resolve) => {
      markArchiveFeed = resolve;
    });
    const never = new Promise<Response>(() => undefined);

    const factory: ViewerStashClientFactory = ({ token, clientId }) => {
      const create = (signal?: AbortSignal): StashClient =>
        createStashClient({
          baseUrl: BASE_URL,
          token,
          clientId,
          fetch: async (input, init) => {
            const requestInit = signal && !init?.signal ? { ...init, signal } : init;
            const request = new Request(input, requestInit);
            const url = new URL(request.url);
            if (
              blockNotesHead &&
              request.method === "GET" &&
              url.pathname === "/v1/stashes/notes/files/docs/readme.txt" &&
              !url.searchParams.has("version")
            ) {
              blockedSignal = requestInit?.signal ?? request.signal;
              markBlocked();
              return never;
            }
            if (url.pathname === "/v1/stashes/archive/changes") markArchiveFeed();
            return fixture.fake.fetch(input, requestInit);
          },
        });
      const client = create();
      return {
        ...client,
        me: ({ signal } = {}) => create(signal).me(),
        withSignal: (signal) => create(signal),
      };
    };

    const rendered = renderLiveEditRoute("/s/notes/edit/docs/readme.txt", fixture, factory);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "keep the blocked draft\n" } });
    await waitFor(() => expect(fixture.fake.events.subscriberCount(STASH)).toBe(1));

    blockNotesHead = true;
    const foreign = await fixture.remoteClient.files(STASH).put(PATH, {
      body: "foreign while blocked\n",
      expectedVersion: 2,
      author: "Peer",
      message: "Block reconciliation",
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    await blocked;

    await act(async () => {
      await rendered.router.navigate("/s/archive/edit/docs/readme.txt");
    });
    await archiveFeed;

    await waitFor(() => expect(blockedSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value,
      ).toBe("archived body\n"),
    );
    await waitFor(() => {
      expect(fixture.fake.events.subscriberCount(STASH)).toBe(0);
      expect(fixture.fake.events.subscriberCount("archive")).toBe(1);
    });
  });

  it("aborts a blocked edit verification when the path changes within the same stash", async () => {
    const fixture = await createFixture();
    const otherPath = "docs/other.txt";
    const other = await fixture.remoteClient.files(STASH).put(otherPath, {
      body: "other body\n",
      expectedVersion: null,
      author: "Fixture",
      message: "Other path",
    });
    if (!other.ok) throw new Error(other.error.message);

    let blockOldHead = false;
    let blockedSignal: AbortSignal | undefined;
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const never = new Promise<Response>(() => undefined);
    let notesFeedCalls = 0;

    const factory: ViewerStashClientFactory = ({ token, clientId }) => {
      const create = (signal?: AbortSignal): StashClient =>
        createStashClient({
          baseUrl: BASE_URL,
          token,
          clientId,
          fetch: async (input, init) => {
            const requestInit = signal && !init?.signal ? { ...init, signal } : init;
            const request = new Request(input, requestInit);
            const url = new URL(request.url);
            if (url.pathname === "/v1/stashes/notes/changes") notesFeedCalls += 1;
            if (
              blockOldHead &&
              request.method === "GET" &&
              url.pathname === "/v1/stashes/notes/files/docs/readme.txt" &&
              !url.searchParams.has("version")
            ) {
              blockedSignal = requestInit?.signal ?? request.signal;
              markBlocked();
              return never;
            }
            return fixture.fake.fetch(input, requestInit);
          },
        });
      const client = create();
      return {
        ...client,
        me: ({ signal } = {}) => create(signal).me(),
        withSignal: (signal) => create(signal),
      };
    };

    const rendered = renderLiveEditRoute("/s/notes/edit/docs/readme.txt", fixture, factory);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "keep the abandoned draft\n" } });
    await waitFor(() => expect(fixture.fake.events.subscriberCount(STASH)).toBe(1));
    await waitFor(() => expect(notesFeedCalls).toBeGreaterThan(0));

    blockOldHead = true;
    const foreign = await fixture.remoteClient.files(STASH).put(PATH, {
      body: "foreign while path A is blocked\n",
      expectedVersion: 2,
      author: "Peer",
      message: "Block old path",
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    await blocked;
    const feedCallsBeforeNavigation = notesFeedCalls;

    await act(async () => {
      await rendered.router.navigate(`/s/notes/edit/${otherPath}`);
    });

    await waitFor(() => expect(blockedSignal?.aborted).toBe(true));
    await waitFor(() => expect(notesFeedCalls).toBeGreaterThan(feedCallsBeforeNavigation));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Draft body" }) as HTMLTextAreaElement).value,
      ).toBe("other body\n"),
    );
    expect(fixture.fake.events.subscriberCount(STASH)).toBe(1);
  });

  it("reads stash, wildcard path, and from=N into the package workbench", async () => {
    const fixture = await createFixture();
    renderEditRoute("/s/notes/edit/docs/readme.txt?from=1", fixture);

    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    expect(editor.value).toBe("first body\n");
    expect(screen.getByRole("heading", { level: 1, name: PATH })).toBeTruthy();
    expect(screen.getByText("Edit · notes")).toBeTruthy();
    expect(screen.getByText("Editing from v1")).toBeTruthy();
  });

  it("renders denied direct navigation after only the principal request", async () => {
    const admin = await createFixture();
    const readToken = await admin.fake.mintToken(STASH, "read");
    const requests: Request[] = [];
    const fetch = vi.fn<StashFetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return admin.fake.fetch(input, init);
    });
    const fixture: Fixture = {
      fake: admin.fake,
      client: createStashClient({ baseUrl: BASE_URL, token: readToken, fetch }),
      clientForSignal: (signal) =>
        createStashClient({
          baseUrl: BASE_URL,
          token: readToken,
          fetch: withSignal(fetch, signal),
        }),
      remoteClient: admin.remoteClient,
      requests,
    };
    renderEditRoute("/s/notes/edit/docs/readme.txt", fixture);

    expect(await screen.findByText("Editing is not available")).toBeTruthy();
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    expect(request?.method).toBe("GET");
    expect(new URL(request?.url ?? BASE_URL).pathname).toBe("/v1/me");
    expect(fixture.requests.some((entry) => entry.url.includes("/files/"))).toBe(false);
  });

  it("does not start workbench reads while the capability request is pending", async () => {
    const fixture = await createFixture();
    let releaseMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    const requests: Request[] = [];
    const gatedFetch = vi.fn<StashFetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname === "/v1/me") await meGate;
      return fixture.fake.fetch(input, init);
    });
    const gated: Fixture = {
      ...fixture,
      client: createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: gatedFetch }),
      clientForSignal: (signal) =>
        createStashClient({
          baseUrl: BASE_URL,
          token: ADMIN_TOKEN,
          fetch: withSignal(gatedFetch, signal),
        }),
      requests,
    };
    renderEditRoute("/s/notes/edit/docs/readme.txt", gated);

    expect(screen.getByText("Checking write access…")).toBeTruthy();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? BASE_URL).pathname).toBe("/v1/me");
    releaseMe();
    expect(await screen.findByRole("textbox", { name: "Draft body" })).toBeTruthy();
  });

  it("rejects an invalid from query without mounting the data workbench", async () => {
    const fixture = await createFixture();
    renderEditRoute("/s/notes/edit/docs/readme.txt?from=zero", fixture);

    expect(await screen.findByText("The from query must be a positive integer.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
    expect(fixture.requests).toHaveLength(1);
    expect(new URL(fixture.requests[0]?.url ?? BASE_URL).pathname).toBe("/v1/me");
  });

  it("navigates to the canonical file URL with a save flash after the internal refresh", async () => {
    const fixture = await createFixture();
    const { router } = renderEditRoute("/s/notes/edit/docs/readme.txt", fixture);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "saved from viewer\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save v3" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await userEvent.click(save);

    await waitFor(() => expect(router.state.location.pathname).toBe("/s/notes/f/docs/readme.txt"));
    expect(await screen.findByText("File destination")).toBeTruthy();
    expect(screen.getByLabelText("destination path").textContent).toBe(
      "/s/notes/f/docs/readme.txt",
    );
    expect(screen.getByLabelText("destination flash").textContent).toBe("Saved v3.");
  });
});
