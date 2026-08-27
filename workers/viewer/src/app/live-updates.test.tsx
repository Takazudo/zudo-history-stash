import {
  createStashClient,
  type ClientResult,
  type ListChangesResult,
  type StashClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { createFakeViewerClient } from "../test/fake-viewer-client.js";

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

function LiveProbe({ onRefresh }: { onRefresh: ViewerLiveRefreshHandler }) {
  const live = useViewerLiveStatus();
  useViewerLiveRefresh(onRefresh);
  return (
    <>
      <output aria-label="Live status">{live.status}</output>
      <Outlet />
    </>
  );
}

function renderLiveRoute(
  clientFactory: ViewerStashClientFactory,
  onRefresh: ViewerLiveRefreshHandler,
) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, ADMIN_TOKEN);
  const router = createMemoryRouter(
    [
      {
        path: "/s/:stash",
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <ViewerStashUiProvider>
              <ViewerLiveUpdatesProvider>
                <LiveProbe onRefresh={onRefresh} />
              </ViewerLiveUpdatesProvider>
            </ViewerStashUiProvider>
          </StashClientProvider>
        ),
        children: [{ path: "*", element: <p>Route content</p> }],
      },
    ],
    { initialEntries: ["/s/notes/one"] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

describe("ViewerLiveUpdatesProvider", () => {
  it("owns one subscription across page navigation and fans ready/change/proposal refreshes", async () => {
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
    const rendered = renderLiveRoute(clientFactory, onRefresh);

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
        type: "proposal",
        proposalId: "prp_1787875200000deadbeef",
        stash: "notes",
        path: "docs/proposed.txt",
        status: "open",
        origin: "peer-tab",
      });
    });
    await waitFor(() =>
      expect(onRefresh.mock.calls.some(([batch]) => batch.reason === "proposal")).toBe(true),
    );

    await act(async () => rendered.router.navigate("/s/notes/two"));
    expect(fake.events.subscriberCount("notes")).toBe(1);
    await act(async () => rendered.router.navigate("/s/archive/one"));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));
    await waitFor(() => expect(fake.events.subscriberCount("archive")).toBe(1));

    rendered.unmount();
    expect(fake.events.subscriberCount("archive")).toBe(0);
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
});
