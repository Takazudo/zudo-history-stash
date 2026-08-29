import {
  createStashClient,
  type ClientResult,
  type ListChangesResult,
  type StashClient,
  type StashEvent,
  type StashEventStream,
  type StashLiveStatus,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
  type ViewerStashClientFactoryOptions,
} from "./auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "./auth/token-store.js";
import {
  VIEWER_LIVE_POLL_INTERVAL_MS,
  ViewerLiveUpdatesProvider,
  useViewerLiveRefresh,
  useViewerLiveStatus,
  type ViewerLiveRefreshHandler,
} from "./live-updates.js";
import { ViewerStashUiProvider } from "./viewer-stash-ui-provider.js";
import { change, createFakeViewerClient } from "../test/fake-viewer-client.js";

const ADMIN_TOKEN = "viewer-live-admin";
const BASE_URL = "https://stash.test";

function viewerClient(
  fake: FakeStash,
  options: ViewerStashClientFactoryOptions,
): ViewerStashClient {
  const create = (signal?: AbortSignal): StashClient =>
    createStashClient({
      baseUrl: BASE_URL,
      token: options.token,
      clientId: options.clientId,
      fetch: (input, init) =>
        fake.fetch(input, signal && !init?.signal ? { ...init, signal } : init),
    });
  const client = create();
  return {
    ...client,
    me: ({ signal } = {}) => create(signal).me(),
    withSignal: (signal) => create(signal),
  };
}

function LiveListener({ onRefresh }: { onRefresh: ViewerLiveRefreshHandler }) {
  useViewerLiveRefresh(onRefresh);
  return null;
}

function LiveProbe({ onRefresh }: { onRefresh: ViewerLiveRefreshHandler | null }) {
  const live = useViewerLiveStatus();
  return (
    <>
      <output aria-label="Live status">{live.status}</output>
      {onRefresh === null ? null : <LiveListener onRefresh={onRefresh} />}
      <Outlet />
    </>
  );
}

function renderLiveRoute(
  clientFactory: ViewerStashClientFactory,
  onRefresh: ViewerLiveRefreshHandler | null,
  { strict = false }: { strict?: boolean } = {},
) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, ADMIN_TOKEN);
  let updateRefresh: ((next: ViewerLiveRefreshHandler | null) => void) | undefined;
  function RouteProbe() {
    const [currentRefresh, setCurrentRefresh] = useState<ViewerLiveRefreshHandler | null>(
      () => onRefresh,
    );
    updateRefresh = (next) => setCurrentRefresh(() => next);
    return <LiveProbe onRefresh={currentRefresh} />;
  }
  const router = createMemoryRouter(
    [
      {
        path: "/s/:stash",
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <ViewerStashUiProvider>
              <ViewerLiveUpdatesProvider>
                <RouteProbe />
              </ViewerLiveUpdatesProvider>
            </ViewerStashUiProvider>
          </StashClientProvider>
        ),
        children: [{ path: "*", element: <p>Route content</p> }],
      },
    ],
    { initialEntries: ["/s/notes/one"] },
  );
  const provider = <RouterProvider router={router} />;
  return {
    router,
    setRefresh(next: ViewerLiveRefreshHandler | null) {
      if (updateRefresh === undefined) throw new Error("The live route probe is not mounted");
      act(() => updateRefresh?.(next));
    },
    ...render(strict ? <StrictMode>{provider}</StrictMode> : provider),
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

interface ManualStream {
  stream: StashEventStream;
  emit(event: StashEvent): void;
  setStatus(status: StashLiveStatus, failureCount?: number): void;
}

function manualStream(): ManualStream {
  const listeners = new Set<(status: StashLiveStatus) => void>();
  const values: StashEvent[] = [];
  const waiters: Array<(result: IteratorResult<StashEvent>) => void> = [];
  let status: StashLiveStatus = "connecting";
  let failureCount = 0;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    status = "closed";
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    for (const listener of listeners) listener(status);
  };
  const stream: StashEventStream = {
    get status() {
      return status;
    },
    get failureCount() {
      return failureCount;
    },
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    close: finish,
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ done: false as const, value });
          if (closed) return Promise.resolve({ done: true as const, value: undefined });
          return new Promise<IteratorResult<StashEvent>>((resolve) => waiters.push(resolve));
        },
        return: async () => {
          finish();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  return {
    stream,
    emit(event) {
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(event);
      else waiter({ done: false, value: event });
    },
    setStatus(nextStatus, nextFailureCount = failureCount) {
      status = nextStatus;
      failureCount = nextFailureCount;
      for (const listener of listeners) listener(status);
    },
  };
}

describe("ViewerLiveUpdatesProvider", () => {
  it("retains a ready reconciliation until the page listener registers", async () => {
    const source = manualStream();
    const changes = vi.fn(async (): Promise<ClientResult<ListChangesResult>> => ({
      ok: true,
      value: {
        changes: [change({ changeId: 4, path: "docs/readme.txt", version: 3 })],
        hasMore: false,
        nextSince: null,
      },
    }));
    const base = createFakeViewerClient();
    const client = createFakeViewerClient({
      files: (stash) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      }),
    });
    client.withSignal = () => client;
    const rendered = renderLiveRoute(() => client, null);

    source.emit({ type: "ready", head: 4, checkpoint: 4 });
    source.setStatus("live");
    await flushMicrotasks(16);
    expect(changes).not.toHaveBeenCalled();

    const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
    rendered.setRefresh(onRefresh);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(changes).toHaveBeenCalledWith({ since: 0, limit: 200 });
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "ready",
        full: true,
        changes: [expect.objectContaining({ path: "docs/readme.txt", version: 3 })],
      }),
    );
    rendered.unmount();
  });

  it("aborts a blocked same-stash listener and reconciles its replacement immediately", async () => {
    const source = manualStream();
    const changes = vi.fn(async (): Promise<ClientResult<ListChangesResult>> => ({
      ok: true,
      value: {
        changes: [change({ changeId: 1, path: "docs/readme.txt" })],
        hasMore: false,
        nextSince: null,
      },
    }));
    const base = createFakeViewerClient();
    const client = createFakeViewerClient({
      files: (stash) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      }),
    });
    client.withSignal = () => client;
    let blockedSignal: AbortSignal | null = null;
    const never = new Promise<void>(() => undefined);
    const first = vi.fn<ViewerLiveRefreshHandler>((batch) => {
      blockedSignal = batch.signal;
      return never;
    });
    const rendered = renderLiveRoute(() => client, first);

    source.emit({ type: "ready", head: 1, checkpoint: 1 });
    source.setStatus("live");
    await waitFor(() => expect(blockedSignal).not.toBeNull());

    const replacement = vi.fn<ViewerLiveRefreshHandler>();
    rendered.setRefresh(replacement);
    expect((blockedSignal as AbortSignal | null)?.aborted).toBe(true);
    await waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));
    expect(replacement).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "listener", full: true }),
    );
    expect(changes).toHaveBeenCalledTimes(2);
    rendered.unmount();
  });

  it("owns one subscription across page navigation and fans ready/change/change-set refreshes", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash("notes");
    fake.createStash("archive");
    const seed = createStashClient({
      baseUrl: BASE_URL,
      token: ADMIN_TOKEN,
      clientId: "fixture",
      fetch: fake.fetch,
    });
    const seeded = await seed
      .files("notes")
      .put("docs/readme.txt", { body: "one", expectedVersion: null });
    if (!seeded.ok) throw new Error(seeded.error.message);
    if ("unchanged" in seeded.value) throw new Error("Seed unexpectedly returned unchanged");

    let tabClientId = "";
    const clientFactory: ViewerStashClientFactory = (options) => {
      tabClientId = options.clientId;
      return viewerClient(fake, options);
    };
    const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
    const rendered = renderLiveRoute(clientFactory, onRefresh, { strict: true });

    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
    await waitFor(() => expect(screen.getByLabelText("Live status").textContent).toBe("live"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(onRefresh.mock.calls[0]?.[0]).toMatchObject({
      reason: "ready",
      full: true,
      checkpoint: null,
      changes: [{ changeId: seeded.value.changeId, path: "docs/readme.txt" }],
    });

    const ownCallCount = onRefresh.mock.calls.length;
    act(() => {
      fake.events.emit({
        type: "change",
        changeId: 999,
        commitId: "legacy:999",
        stash: "notes",
        path: "docs/own.txt",
        version: 1,
        kind: "put",
        origin: tabClientId,
        createdAt: "2026-08-28T00:00:00.000Z",
      });
    });
    await flushMicrotasks();
    expect(onRefresh).toHaveBeenCalledTimes(ownCallCount);

    const peer = createStashClient({
      baseUrl: BASE_URL,
      token: ADMIN_TOKEN,
      clientId: "peer-tab",
      fetch: fake.fetch,
    });
    const changed = await peer.files("notes").put("docs/peer.txt", {
      body: "peer",
      expectedVersion: null,
    });
    if (!changed.ok) throw new Error(changed.error.message);
    if ("unchanged" in changed.value) throw new Error("Peer write unexpectedly returned unchanged");
    await waitFor(() =>
      expect(onRefresh.mock.calls.some(([batch]) => batch.reason === "change")).toBe(true),
    );
    const changeBatch = onRefresh.mock.calls.find(([batch]) => batch.reason === "change")?.[0];
    expect(changeBatch?.changes).toEqual([
      expect.objectContaining({ changeId: changed.value.changeId, path: "docs/peer.txt" }),
    ]);

    act(() => {
      fake.events.emit({
        type: "change-set",
        changeSetId: "cst_1787875200000deadbeef",
        stash: "notes",
        paths: ["docs/candidate.txt"],
        status: "open",
        origin: "peer-tab",
      });
    });
    await waitFor(() =>
      expect(onRefresh.mock.calls.some(([batch]) => batch.reason === "change-set")).toBe(true),
    );

    await act(async () => rendered.router.navigate("/s/notes/two"));
    expect(fake.events.subscriberCount("notes")).toBe(1);
    await act(async () => rendered.router.navigate("/s/archive/one"));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));
    await waitFor(() => expect(fake.events.subscriberCount("archive")).toBe(1));

    rendered.unmount();
    expect(fake.events.subscriberCount("archive")).toBe(0);
  });

  it("reconciles commit frames across the whole stash and preserves every change-set path hint", async () => {
    const source = manualStream();
    const rows = [
      change({ changeId: 1, path: "docs/one.txt" }),
      change({ changeId: 2, path: "docs/two.txt" }),
    ];
    const changes = vi.fn(
      async (options?: { since?: number }): Promise<ClientResult<ListChangesResult>> => ({
        ok: true,
        value: {
          changes: rows.filter((row) => row.changeId > (options?.since ?? 0)),
          hasMore: false,
          nextSince: null,
        },
      }),
    );
    const base = createFakeViewerClient();
    const client = createFakeViewerClient({
      files: (stash) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      }),
    });
    client.withSignal = () => client;
    const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
    const rendered = renderLiveRoute(() => client, onRefresh);

    source.emit({ type: "ready", head: 2, checkpoint: 1 });
    source.setStatus("live");
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    onRefresh.mockClear();

    source.emit({
      type: "commit",
      commitId: "cmt_2",
      stash: "notes",
      entryCount: 1,
      firstChangeId: 2,
      lastChangeId: 2,
      origin: "peer-tab",
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    const commitBatch = onRefresh.mock.calls[0]?.[0];
    expect(commitBatch?.reason).toBe("commit");
    expect(commitBatch && "hintedPath" in commitBatch).toBe(false);
    expect(commitBatch?.changes).toEqual([rows[1]]);

    onRefresh.mockClear();
    source.emit({
      type: "change-set",
      changeSetId: "chs_2",
      stash: "notes",
      paths: ["docs/one.txt", "docs/two.txt"],
      status: "open",
      origin: "peer-tab",
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(onRefresh.mock.calls.map(([batch]) => batch.hintedPath)).toEqual([
      "docs/one.txt",
      "docs/two.txt",
    ]);
    rendered.unmount();
  });

  it("uses one exported polling timer and the same authoritative fanout path", async () => {
    vi.useFakeTimers();
    try {
      const base = createFakeViewerClient();
      const changes = vi.fn(async (): Promise<ClientResult<ListChangesResult>> => ({
        ok: true,
        value: { changes: [], hasMore: false, nextSince: null },
      }));
      const files = (stash: string) => ({
        ...base.files(stash),
        changes,
        events: () => {
          throw new TypeError("unsupported event transport");
        },
      });
      const client = createFakeViewerClient({ files });
      client.withSignal = () => client;
      const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
      const rendered = renderLiveRoute(() => client, onRefresh);

      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByLabelText("Live status").textContent).toBe("polling");
      expect(changes).toHaveBeenCalledTimes(1);
      expect(onRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "polling", full: true }),
      );

      await act(async () => vi.advanceTimersByTimeAsync(VIEWER_LIVE_POLL_INTERVAL_MS));
      expect(changes).toHaveBeenCalledTimes(2);
      rendered.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(VIEWER_LIVE_POLL_INTERVAL_MS));
      expect(changes).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes focus recovery behind an in-flight polling refresh", async () => {
    vi.useFakeTimers();
    try {
      const base = createFakeViewerClient();
      let releaseFirst!: (result: ClientResult<ListChangesResult>) => void;
      const first = new Promise<ClientResult<ListChangesResult>>((resolve) => {
        releaseFirst = resolve;
      });
      let callCount = 0;
      const changes = vi.fn(() => {
        callCount += 1;
        return callCount === 1
          ? first
          : Promise.resolve({
              ok: true as const,
              value: { changes: [], hasMore: false, nextSince: null },
            });
      });
      const files = (stash: string) => ({
        ...base.files(stash),
        changes,
        events: () => {
          throw new TypeError("unsupported event transport");
        },
      });
      const client = createFakeViewerClient({ files });
      client.withSignal = () => client;
      const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
      const rendered = renderLiveRoute(() => client, onRefresh);

      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(changes).toHaveBeenCalledTimes(1);
      act(() => window.dispatchEvent(new Event("focus")));
      await flushMicrotasks();
      await act(async () => vi.advanceTimersByTimeAsync(VIEWER_LIVE_POLL_INTERVAL_MS));
      expect(changes).toHaveBeenCalledTimes(1);

      releaseFirst({
        ok: true,
        value: { changes: [], hasMore: false, nextSince: null },
      });
      await flushMicrotasks(16);
      expect(changes).toHaveBeenCalledTimes(2);
      expect(onRefresh.mock.calls.map(([batch]) => batch.reason)).toEqual(["polling", "focus"]);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a rejected ready interval through a full polling reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const source = manualStream();
      const feed = [
        change({ changeId: 1, path: "docs/readme.txt", version: 1 }),
        change({ changeId: 5, path: "docs/readme.txt", version: 2 }),
      ];
      let serverHead = 1;
      const changes = vi.fn(
        async (options?: { since?: number }): Promise<ClientResult<ListChangesResult>> => ({
          ok: true,
          value: {
            changes: feed.filter(
              (item) => item.changeId > (options?.since ?? 0) && item.changeId <= serverHead,
            ),
            hasMore: false,
            nextSince: null,
          },
        }),
      );
      const base = createFakeViewerClient();
      const files = (stash: string) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      });
      const client = createFakeViewerClient({ files });
      client.withSignal = () => client;
      let rejectNextReady = false;
      const onRefresh = vi.fn<ViewerLiveRefreshHandler>(async (batch) => {
        if (batch.reason === "ready" && rejectNextReady) {
          rejectNextReady = false;
          throw new Error("visible consumer failed");
        }
      });
      const rendered = renderLiveRoute(() => client, onRefresh);

      source.emit({ type: "ready", head: 1, checkpoint: 1 });
      source.setStatus("live");
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      expect(changes).toHaveBeenLastCalledWith({ since: 0, limit: 200 });

      rejectNextReady = true;
      serverHead = 5;
      source.emit({ type: "ready", head: 5, checkpoint: 5 });
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
      expect(changes).toHaveBeenLastCalledWith({ since: 1, limit: 200 });

      source.setStatus("reconnecting", 3);
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await vi.waitFor(() =>
        expect(
          onRefresh.mock.calls.some(
            ([batch]) =>
              batch.reason === "polling" &&
              batch.full &&
              batch.changes.some((item) => item.changeId === 5),
          ),
        ).toBe(true),
      );
      expect(changes).toHaveBeenLastCalledWith({ since: 0, limit: 200 });

      source.setStatus("live", 0);
      await flushMicrotasks();
      expect(screen.getByLabelText("Live status").textContent).toBe("live");
      expect(vi.getTimerCount()).toBe(0);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains every authoritative change page before acknowledging a late-page update", async () => {
    const source = manualStream();
    const changes = vi.fn(
      async (options?: { since?: number }): Promise<ClientResult<ListChangesResult>> => {
        if ((options?.since ?? 0) === 0) {
          return {
            ok: true,
            value: {
              changes: [change({ changeId: 1, path: "docs/seed.txt" })],
              hasMore: false,
              nextSince: null,
            },
          };
        }
        if (options?.since === 1) {
          return {
            ok: true,
            value: {
              changes: [change({ changeId: 2, path: "docs/early-page.txt" })],
              hasMore: true,
              nextSince: 2,
            },
          };
        }
        return {
          ok: true,
          value: {
            changes: [change({ changeId: 3, path: "docs/visible-late-page.txt" })],
            hasMore: false,
            nextSince: null,
          },
        };
      },
    );
    const base = createFakeViewerClient();
    const client = createFakeViewerClient({
      files: (stash) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      }),
    });
    client.withSignal = () => client;
    let visiblePath = "";
    const onRefresh = vi.fn<ViewerLiveRefreshHandler>(async (batch) => {
      const visible = batch.changes.find((item) => item.path === "docs/visible-late-page.txt");
      if (visible !== undefined) visiblePath = visible.path;
    });
    const rendered = renderLiveRoute(() => client, onRefresh);

    source.emit({ type: "ready", head: 1, checkpoint: 1 });
    source.setStatus("live");
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    changes.mockClear();

    source.emit({ type: "ready", head: 3, checkpoint: 3 });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));

    expect(changes.mock.calls).toEqual([[{ since: 1, limit: 200 }], [{ since: 2, limit: 200 }]]);
    expect(onRefresh.mock.calls[1]?.[0].changes.map((item) => item.changeId)).toEqual([2, 3]);
    expect(visiblePath).toBe("docs/visible-late-page.txt");
    rendered.unmount();
  });

  it("treats an event path as a hint when the authoritative feed names another path", async () => {
    const source = manualStream();
    const base = createFakeViewerClient();
    let serverHead = 1;
    const changes = vi.fn(
      async (options?: { since?: number }): Promise<ClientResult<ListChangesResult>> => ({
        ok: true,
        value: {
          changes:
            (options?.since ?? 0) < 2 && serverHead >= 2
              ? [change({ changeId: 2, path: "docs/authoritative.txt" })]
              : [],
          hasMore: false,
          nextSince: null,
        },
      }),
    );
    const client = createFakeViewerClient({
      files: (stash) => ({
        ...base.files(stash),
        changes,
        events: () => source.stream,
      }),
    });
    client.withSignal = () => client;
    const onRefresh = vi.fn<ViewerLiveRefreshHandler>();
    const rendered = renderLiveRoute(() => client, onRefresh);

    source.emit({ type: "ready", head: 1, checkpoint: 1 });
    source.setStatus("live");
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    changes.mockClear();

    serverHead = 2;
    source.emit({
      type: "change",
      changeId: 2,
      commitId: "legacy:2",
      stash: "notes",
      path: "docs/misleading-hint.txt",
      version: 1,
      kind: "put",
      origin: "peer-tab",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));

    expect(changes).toHaveBeenCalledWith({ since: 1, limit: 200 });
    expect(onRefresh.mock.calls[1]?.[0]).toMatchObject({
      hintedPath: "docs/misleading-hint.txt",
      changes: [{ changeId: 2, path: "docs/authoritative.txt" }],
    });
    rendered.unmount();
  });

  it("aborts blocked old fanout and starts a new stash queue immediately", async () => {
    const notes = manualStream();
    const archive = manualStream();
    const changes = vi.fn(async (stash: string): Promise<ClientResult<ListChangesResult>> => ({
      ok: true,
      value: {
        changes: [change({ stash, path: `${stash}.txt` })],
        hasMore: false,
        nextSince: null,
      },
    }));
    const base = createFakeViewerClient();
    const files = (stash: string) => ({
      ...base.files(stash),
      changes: () => changes(stash),
      events: () => (stash === "notes" ? notes.stream : archive.stream),
    });
    const client = createFakeViewerClient({ files });
    client.withSignal = () => client;
    let oldSignal: AbortSignal | null = null;
    const never = new Promise<void>(() => {});
    const onRefresh = vi.fn<ViewerLiveRefreshHandler>((batch) => {
      if (batch.changes.some((item) => item.path === "notes.txt")) {
        oldSignal = batch.signal;
        return never;
      }
    });
    const rendered = renderLiveRoute(() => client, onRefresh);

    notes.emit({ type: "ready", head: 1, checkpoint: 1 });
    notes.setStatus("live");
    await waitFor(() => expect(oldSignal).not.toBeNull());

    await act(async () => rendered.router.navigate("/s/archive/one"));
    expect((oldSignal as AbortSignal | null)?.aborted).toBe(true);
    archive.emit({ type: "ready", head: 1, checkpoint: 1 });
    archive.setStatus("live");
    await waitFor(() =>
      expect(
        onRefresh.mock.calls.some(([batch]) =>
          batch.changes.some((item) => item.path === "archive.txt"),
        ),
      ).toBe(true),
    );
    expect(changes.mock.calls.map(([stash]) => stash)).toEqual(["notes", "archive"]);
    rendered.unmount();
  });

  it("closes and restores exactly one subscription across visibility and focus", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash("notes");
    const rendered = renderLiveRoute(
      (options) => viewerClient(fake, options),
      vi.fn<ViewerLiveRefreshHandler>(),
      { strict: true },
    );

    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
    act(() => window.dispatchEvent(new Event("focus")));
    await flushMicrotasks();
    expect(fake.events.subscriberCount("notes")).toBe(1);

    rendered.unmount();
    expect(fake.events.subscriberCount("notes")).toBe(0);
  });
});
