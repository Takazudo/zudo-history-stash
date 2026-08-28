import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createStashClient,
  type ClientResult,
  type FileGetResult,
  type FileRecordWithEtag,
  type GetDiffResult,
  type HistoryPage,
  type ProposalListResponse,
  type StashClient,
  type StashFilesClient,
  type StashProposalsClient,
  type VersionRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { createMemoryRouter, type InitialEntry, Outlet, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { RequireToken } from "../app/auth/require-token.js";
import { ViewerLiveUpdatesProvider } from "../app/live-updates.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { ViewerStashUiProvider } from "../app/viewer-stash-ui-provider.js";
import {
  createFakeBackedViewerClient,
  createFakeViewerClient,
} from "../test/fake-viewer-client.js";
import FilePage from "./file.js";

function fileRecord(overrides: Partial<FileRecordWithEtag> = {}): FileRecordWithEtag {
  return {
    path: "docs/readme.txt",
    version: 4,
    hash: "sha256-1234567890abcdef",
    size: 18,
    kind: "put",
    author: "Ada",
    message: "Update readme",
    meta: {},
    createdAt: "2026-08-25T09:00:00.000Z",
    deleted: false,
    body: "hello\nworld\n",
    etag: '"v4-sha256-1234567890abcdef"',
    ...overrides,
  };
}

function version(overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: 4,
    kind: "put",
    hash: "sha256-1234567890abcdef",
    size: 18,
    rollbackOf: null,
    author: "Ada",
    message: "Update readme",
    meta: {},
    createdAt: "2026-08-25T09:00:00.000Z",
    ...overrides,
  };
}

function historyPage(overrides: Partial<HistoryPage> = {}): HistoryPage {
  return {
    path: "docs/readme.txt",
    headVersion: 4,
    deleted: false,
    total: 4,
    versions: [
      version(),
      version({ version: 3, hash: "sha256-3", size: 12 }),
      version({ version: 2, hash: "sha256-2", size: 8 }),
      version({ version: 1, hash: "sha256-1", size: 4 }),
    ],
    nextBefore: null,
    ...overrides,
  };
}

function diffResult(from: number, to: number): ClientResult<GetDiffResult> {
  return {
    ok: true,
    value: {
      state: "ready",
      unified: "",
      truncated: false,
      hunks: [],
      stats: { added: 2, removed: 1 },
      from: { version: from, hash: `sha256-${from}`, deleted: false },
      to: { version: to, hash: `sha256-${to}`, deleted: false },
    },
  };
}

function clientWithFiles(
  overrides: Partial<StashFilesClient> = {},
  proposalList?: StashProposalsClient["list"],
): ViewerStashClient {
  const base = createFakeViewerClient();
  const defaults: Pick<StashFilesClient, "get" | "history" | "diff"> = {
    get: async (): Promise<FileGetResult> => ({ ok: true, value: fileRecord() }),
    history: async (): Promise<ClientResult<HistoryPage>> => ({
      ok: true,
      value: historyPage(),
    }),
    diff: async (_path, options): Promise<ClientResult<GetDiffResult>> =>
      diffResult(options.from, typeof options.to === "number" ? options.to : 4),
  };
  return createFakeViewerClient({
    files: (stash) => ({ ...base.files(stash), ...defaults, ...overrides }),
    ...(proposalList === undefined
      ? {}
      : { proposals: (stash: string) => ({ ...base.proposals(stash), list: proposalList }) }),
  });
}

function renderFileRoute(initialEntry: InitialEntry, client: ViewerStashClient) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
  const clientFactory: ViewerStashClientFactory = () => client;
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <Outlet />
          </StashClientProvider>
        ),
        children: [
          { path: "/login", element: <p>Login destination</p> },
          {
            element: (
              <RequireToken>
                <ViewerStashUiProvider>
                  <ViewerLiveUpdatesProvider>
                    <Outlet />
                  </ViewerLiveUpdatesProvider>
                </ViewerStashUiProvider>
              </RequireToken>
            ),
            children: [
              { path: "/s/:stash/f/*", element: <FilePage /> },
              { path: "/s/:stash/diff/*", element: <p>Diff destination</p> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("FilePage", () => {
  it("refreshes the current head, history, and proposal count from shared live events", async () => {
    const token = "viewer-file-live";
    const fake = createFakeStash({ adminToken: token });
    fake.createStash("notes");
    const seed = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "fixture",
      fetch: fake.fetch,
    });
    const first = await seed.files("notes").put("docs/readme.txt", {
      body: "first body",
      expectedVersion: null,
      author: "Fixture",
      message: "First",
    });
    if (!first.ok) throw new Error(first.error.message);
    renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      createFakeBackedViewerClient(fake, token, "viewer-live-tab"),
    );
    expect(await screen.findByText("first body")).toBeTruthy();
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));

    const peer = createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId: "peer-tab",
      fetch: fake.fetch,
    });
    const second = await peer.files("notes").put("docs/readme.txt", {
      body: "peer body",
      expectedVersion: first.value.version,
      author: "Peer",
      message: "Peer update",
    });
    if (!second.ok) throw new Error(second.error.message);
    expect(await screen.findByText("peer body")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "History" }).textContent).toContain("Peer update"),
    );

    const proposal = await peer.proposals("notes").create({
      path: "docs/readme.txt",
      body: "candidate",
      baseVersion: second.value.version,
    });
    if (!proposal.ok) throw new Error(proposal.error.message);
    expect(
      await screen.findByRole(
        "link",
        { name: "1 open proposal for docs/readme.txt" },
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
  });

  it("shows loading states for the representation and history", () => {
    const pendingFile = new Promise<FileGetResult>(() => {
      // Intentionally pending.
    });
    const pendingHistory = new Promise<ClientResult<HistoryPage>>(() => {
      // Intentionally pending.
    });
    renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({
        get: vi.fn(() => pendingFile),
        history: vi.fn(() => pendingHistory),
      }),
    );

    expect(screen.getByText("Loading file…")).toBeTruthy();
    expect(screen.getByText("Loading history…")).toBeTruthy();
  });

  it("shows an empty history and toggles long-line wrapping for a live body", async () => {
    renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({
        get: async () => ({
          ok: true,
          value: fileRecord({ body: "https://example.test/one/verylongsegmentwithoutbreaks" }),
        }),
        history: async () => ({
          ok: true,
          value: historyPage({ total: 0, versions: [] }),
        }),
      }),
    );

    const body = await screen.findByText("https://example.test/one/verylongsegmentwithoutbreaks");
    expect(body.tagName).toBe("PRE");
    expect(body.getAttribute("data-wrap-long-lines")).toBe("false");
    expect(screen.getByText("No versions have been recorded for this file.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
    expect((await screen.findByRole("link", { name: "Edit" })).getAttribute("href")).toBe(
      "/s/notes/edit/docs/readme.txt",
    );
    expect(screen.getByRole("button", { name: "Delete…" })).toBeTruthy();

    await userEvent.click(screen.getByRole("checkbox", { name: "Wrap long lines" }));
    expect(body.getAttribute("data-wrap-long-lines")).toBe("true");
    expect(body.className).toContain("file-body-pane--wrap");
  });

  it("links a nonzero exact-path open count and hides a zero count", async () => {
    const path = "folder/a file?#.txt";
    const list = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 2 },
    }));
    const { unmount } = renderFileRoute(
      "/s/notes/f/folder/a%20file%3F%23.txt",
      clientWithFiles(
        {
          get: async () => ({ ok: true, value: fileRecord({ path }) }),
          history: async () => ({ ok: true, value: historyPage({ path }) }),
        },
        list,
      ),
    );

    const badge = await screen.findByRole("link", { name: `2 open proposals for ${path}` });
    expect(badge.getAttribute("href")).toBe("/s/notes/proposals?path=folder%2Fa+file%3F%23.txt");
    expect(list).toHaveBeenCalledWith({ status: "open", path, limit: 1 });

    unmount();
    const zeroList = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 0 },
    }));
    renderFileRoute("/s/notes/f/docs/readme.txt", clientWithFiles({}, zeroList));
    await waitFor(() => expect(zeroList).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /open proposals? for/u })).toBeNull();
  });

  it("keeps proposal count failures independent and skips the count for invalid input", async () => {
    const failedList = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: false,
      error: { status: 503, code: "internal", message: "Proposal count unavailable" },
    }));
    const rendered = renderFileRoute("/s/notes/f/docs/readme.txt", clientWithFiles({}, failedList));

    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === "PRE" && element.textContent === "hello\nworld\n",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Proposal count unavailable")).toBeNull();
    rendered.unmount();

    const invalidList = vi.fn<StashProposalsClient["list"]>();
    renderFileRoute("/s/notes/f/docs/readme.txt?version=zero", clientWithFiles({}, invalidList));
    expect(await screen.findByText("The version query must be a positive integer.")).toBeTruthy();
    expect(invalidList).not.toHaveBeenCalled();
  });

  it("copies the full hash while presenting a shortened value", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderFileRoute("/s/notes/f/docs/readme.txt", clientWithFiles());

    const shortened = await screen.findByTitle("sha256-1234567890abcdef");
    expect(shortened.textContent).toBe("sha256-1234567890ab…");
    await userEvent.click(screen.getByRole("button", { name: "Copy hash" }));
    expect(writeText).toHaveBeenCalledWith("sha256-1234567890abcdef");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it.each(["Saved v5.", "No write was needed; the file already matches v4."])(
    "renders and consumes the edit destination flash: %s",
    async (flash) => {
      const { router } = renderFileRoute(
        { pathname: "/s/notes/f/docs/readme.txt", state: { flash } },
        clientWithFiles(),
      );

      const confirmation = await screen.findByRole("status", { name: "Save confirmation" });
      expect(confirmation.textContent).toContain(flash);
      await waitFor(() => expect(router.state.location.state).toBeNull());
      expect(screen.getByRole("status", { name: "Save confirmation" }).textContent).toContain(
        flash,
      );

      await userEvent.click(within(confirmation).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("status", { name: "Save confirmation" })).toBeNull();
    },
  );

  it("shows request errors with a retry action", async () => {
    renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({
        get: async () => ({
          ok: false,
          error: { status: 503, code: "internal", message: "D1 unavailable" },
        }),
      }),
    );

    const alert = await screen.findByRole("alert", { name: "" });
    expect(alert.textContent).toContain("D1 unavailable");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("clears a rejected token and preserves the file deep link on a 401", async () => {
    const { router } = renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({
        get: async () => ({
          ok: false,
          error: { status: 401, code: "unauthorized", message: "Expired" },
        }),
      }),
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Fs%2Fnotes%2Ff%2Fdocs%2Freadme.txt");
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("recovers tombstone metadata from the explicit head and links the last live version", async () => {
    const get = vi.fn(async (_path: string, options): Promise<FileGetResult> =>
      options?.version === 4
        ? {
            ok: true,
            value: fileRecord({
              version: 4,
              hash: null,
              size: 0,
              kind: "delete",
              message: "Remove old guide",
              deleted: true,
              body: null,
              etag: '"v4-deleted"',
            }),
          }
        : {
            ok: false,
            error: { status: 404, code: "file-deleted", message: "File deleted" },
            current: {
              version: 4,
              hash: null,
              deleted: true,
              kind: "delete",
              author: "Ada",
              createdAt: "2026-08-25T09:00:00.000Z",
            },
          },
    );
    renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({
        get,
        history: async () => ({
          ok: true,
          value: historyPage({
            deleted: true,
            versions: [
              version({ version: 4, kind: "delete", hash: null, size: 0 }),
              version({ version: 3, kind: "put", hash: "sha256-live" }),
            ],
          }),
        }),
      }),
    );

    const tombstone = await screen.findByRole("status");
    expect(tombstone.textContent).toContain("Deleted at v4 by Ada");
    expect(screen.getByText("This version is a tombstone; it has no body.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View last live version v3" }).getAttribute("href"),
    ).toBe("/s/notes/f/docs/readme.txt?version=3");
    expect(await screen.findByRole("button", { name: "Restore v3…" })).toBeTruthy();
    expect(get).toHaveBeenNthCalledWith(1, "docs/readme.txt");
    expect(get).toHaveBeenNthCalledWith(2, "docs/readme.txt", { version: 4 });
  });

  it("loads an explicit version, shows the head banner, and exposes stable history actions", async () => {
    const get = vi.fn(async (_path: string, options): Promise<FileGetResult> => ({
      ok: true,
      value: fileRecord({
        version: options?.version ?? 4,
        hash: "sha256-version-2",
        body: "older body",
      }),
    }));
    const { router } = renderFileRoute(
      "/s/notes/f/docs/readme.txt?version=2",
      clientWithFiles({
        get,
        history: async () => ({
          ok: true,
          value: historyPage({
            versions: [
              version({ version: 4, kind: "rollback", rollbackOf: 2 }),
              version({ version: 3 }),
              version({ version: 2 }),
            ],
          }),
        }),
      }),
    );

    expect(await screen.findByText("Viewing v2 — head is v4.")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("docs/readme.txt", { version: 2 });
    expect(screen.getByRole("link", { name: "Return to head" }).getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt",
    );
    expect(
      (await screen.findByRole("link", { name: "Edit from this version" })).getAttribute("href"),
    ).toBe("/s/notes/edit/docs/readme.txt?from=2");
    expect(screen.getByText("→ v2")).toBeTruthy();

    const versionThree = document.querySelector('[data-history-version="3"]');
    expect(versionThree).toBeTruthy();
    const row = within(versionThree as HTMLElement);
    expect(row.getByRole("link", { name: "View this version" }).getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt?version=3",
    );
    expect(row.getByRole("link", { name: "Diff vs head" }).getAttribute("href")).toBe(
      "/s/notes/diff/docs/readme.txt?from=3&to=head",
    );
    await waitFor(() =>
      expect(row.getByRole("link", { name: "Edit from v3" }).getAttribute("href")).toBe(
        "/s/notes/edit/docs/readme.txt?from=3",
      ),
    );
    const rollback = row.getByRole("button", { name: "Rollback to v3" });
    await waitFor(() => {
      expect(rollback.hasAttribute("disabled")).toBe(false);
      expect(rollback.getAttribute("title")).toBeNull();
    });

    await userEvent.click(screen.getByRole("radio", { name: "Use v2 as from version" }));
    await userEvent.click(screen.getByRole("radio", { name: "Use v3 as to version" }));
    await userEvent.click(screen.getByRole("link", { name: "Compare" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/s/notes/diff/docs/readme.txt"),
    );
    expect(router.state.location.search).toBe("?from=2&to=3");
  });

  it("refreshes the head representation after a successful rollback", async () => {
    const get = vi
      .fn<StashFilesClient["get"]>()
      .mockResolvedValueOnce({ ok: true, value: fileRecord({ body: "current body" }) })
      .mockResolvedValueOnce({ ok: true, value: fileRecord({ body: "current body" }) })
      .mockResolvedValue({
        ok: true,
        value: fileRecord({
          version: 5,
          hash: "sha256-2",
          body: "rolled back body",
          kind: "rollback",
        }),
      });
    const rollback = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: 5,
        hash: "sha256-2",
        rollbackOf: 2,
        identicalToHead: false,
        changeId: 9,
        createdAt: "2026-08-25T10:00:00.000Z",
      },
    }));
    const { router } = renderFileRoute(
      "/s/notes/f/docs/readme.txt",
      clientWithFiles({ get, rollback }),
    );

    expect(await screen.findByText("current body")).toBeTruthy();
    expect(router.state.historyAction).toBe("POP");
    await userEvent.click(screen.getByRole("button", { name: "Rollback to v2" }));
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    const callsBeforeRollback = get.mock.calls.length;
    await userEvent.click(confirm);

    expect(await screen.findByText("rolled back body")).toBeTruthy();
    expect(screen.getByText("Rollback complete. Created v5 as rollback to v2.")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(callsBeforeRollback + 1);
    expect(router.state.location.pathname).toBe("/s/notes/f/docs/readme.txt");
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("POP");
  });

  it("replaces a historical URL with the head after a successful rollback", async () => {
    const get = vi.fn(async (_path: string, options): Promise<FileGetResult> => ({
      ok: true,
      value:
        options?.version === 2
          ? fileRecord({ version: 2, hash: "sha256-2", body: "historical body" })
          : fileRecord({
              version: 5,
              hash: "sha256-2",
              body: "rolled back head",
              kind: "rollback",
            }),
    }));
    const rollback = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: 5,
        hash: "sha256-2",
        rollbackOf: 2,
        identicalToHead: false,
        changeId: 9,
        createdAt: "2026-08-25T10:00:00.000Z",
      },
    }));
    const { router } = renderFileRoute(
      "/s/notes/f/docs/readme.txt?version=2",
      clientWithFiles({ get, rollback }),
    );

    expect(await screen.findByText("historical body")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Rollback to v2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));

    expect(await screen.findByText("rolled back head")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/s/notes/f/docs/readme.txt");
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(get).toHaveBeenCalledWith("docs/readme.txt", { version: 2 });
    expect(get).toHaveBeenCalledWith("docs/readme.txt");
  });

  it("appends history pages newest-first without duplicate versions", async () => {
    const history = vi.fn(async (path: string, options): Promise<ClientResult<HistoryPage>> => {
      if (options?.before === 2) {
        return {
          ok: true,
          value: historyPage({
            versions: [version({ version: 2 }), version({ version: 1 })],
            nextBefore: null,
          }),
        };
      }
      return {
        ok: true,
        value: historyPage({
          versions: [version({ version: 4 }), version({ version: 3 }), version({ version: 2 })],
          nextBefore: 2,
        }),
      };
    });
    renderFileRoute("/s/notes/f/docs/readme.txt", clientWithFiles({ history }));

    await screen.findByRole("button", { name: "Load more" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(document.querySelector('[data-history-version="1"]')).toBeTruthy());
    expect(document.querySelectorAll('[data-history-version="2"]')).toHaveLength(1);
    expect(history).toHaveBeenNthCalledWith(1, "docs/readme.txt", undefined);
    expect(history).toHaveBeenNthCalledWith(2, "docs/readme.txt", { before: 2 });
  });

  it("keeps a confirmed rollback when a later history page resolves", async () => {
    const history = vi.fn(async (_path: string, options): Promise<ClientResult<HistoryPage>> => {
      if (options?.before === 2) {
        return {
          ok: true,
          value: historyPage({
            headVersion: 5,
            total: 5,
            versions: [
              version({
                version: 5,
                kind: "rollback",
                rollbackOf: 2,
                hash: "sha256-2",
                author: "Server",
                message: "Server-confirmed rollback",
              }),
              version({ version: 2 }),
              version({ version: 1 }),
            ],
            nextBefore: null,
          }),
        };
      }
      return {
        ok: true,
        value: historyPage({
          versions: [version({ version: 4 }), version({ version: 3 }), version({ version: 2 })],
          nextBefore: 2,
        }),
      };
    });
    const rollback = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: 5,
        hash: "sha256-2",
        rollbackOf: 2,
        identicalToHead: false,
        changeId: 9,
        createdAt: "2026-08-25T10:00:00.000Z",
      },
    }));
    renderFileRoute("/s/notes/f/docs/readme.txt", clientWithFiles({ history, rollback }));

    await screen.findByRole("button", { name: "Load more" });
    await userEvent.click(screen.getByRole("button", { name: "Rollback to v2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));
    const toast = await screen.findByText("Rollback complete. Created v5 as rollback to v2.");

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(document.querySelector('[data-history-version="1"]')).toBeTruthy());

    const rows = [...document.querySelectorAll<HTMLElement>("[data-history-version]")];
    expect(rows.map((row) => Number(row.dataset.historyVersion))).toEqual([5, 4, 3, 2, 1]);
    expect(document.querySelectorAll('[data-history-version="5"]')).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("Server-confirmed rollback")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Server")).toBeTruthy();
    expect(toast.isConnected).toBe(true);
    expect(screen.getByText("5 versions, newest first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Compare" }).getAttribute("href")).toBe(
      "/s/notes/diff/docs/readme.txt?from=2&to=5",
    );
    expect(history).toHaveBeenNthCalledWith(1, "docs/readme.txt", undefined);
    expect(history).toHaveBeenNthCalledWith(2, "docs/readme.txt", { before: 2 });
  });

  it("requests stats only for intersecting rows and aborts on scroll-out and unmount", async () => {
    const observers: FakeIntersectionObserver[] = [];
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      readonly targets = new Set<Element>();

      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }

      observe(target: Element) {
        this.targets.add(target);
      }

      unobserve(target: Element) {
        this.targets.delete(target);
      }

      disconnect() {
        this.targets.clear();
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      trigger(target: Element, isIntersecting: boolean) {
        this.callback(
          [
            {
              target,
              isIntersecting,
              intersectionRatio: isIntersecting ? 1 : 0,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const pendingDiff = new Promise<ClientResult<GetDiffResult>>(() => {
      // Intentionally pending so cancellation stays observable.
    });
    const diff = vi.fn(() => pendingDiff);
    const client = clientWithFiles({
      diff,
      history: async () => ({
        ok: true,
        value: historyPage({ versions: [version({ version: 3 }), version({ version: 2 })] }),
      }),
    });
    const diffSignals: AbortSignal[] = [];
    const directFiles = client.files.bind(client);
    client.withSignal = (signal): StashClient => ({
      ...client,
      files: (stash) => {
        const files = directFiles(stash);
        return {
          ...files,
          diff: (...args) => {
            diffSignals.push(signal);
            return files.diff(...args);
          },
        };
      },
    });

    const rendered = renderFileRoute("/s/notes/f/docs/readme.txt", client);
    const statsThree = await screen.findByLabelText("Change stats for v3: Not requested");
    const statsTwo = screen.getByLabelText("Change stats for v2: Not requested");
    const observerThree = observers.find((observer) => observer.targets.has(statsThree));
    const observerTwo = observers.find((observer) => observer.targets.has(statsTwo));
    expect(observerThree).toBeTruthy();
    expect(observerTwo).toBeTruthy();

    act(() => observerThree?.trigger(statsThree, true));
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1));
    expect(diff).toHaveBeenCalledWith("docs/readme.txt", { from: 2, to: 3 });
    expect(diffSignals[0]?.aborted).toBe(false);

    act(() => observerThree?.trigger(statsThree, false));
    await waitFor(() => expect(diffSignals[0]?.aborted).toBe(true));

    act(() => observerTwo?.trigger(statsTwo, true));
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    expect(diff).toHaveBeenLastCalledWith("docs/readme.txt", { from: 1, to: 2 });
    expect(diffSignals[1]?.aborted).toBe(false);

    rendered.unmount();
    expect(diffSignals[1]?.aborted).toBe(true);
  });
});
