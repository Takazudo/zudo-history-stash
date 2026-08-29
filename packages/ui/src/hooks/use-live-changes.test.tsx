import {
  createStashClient,
  type StashChangeEvent,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import {
  useLiveChanges,
  type LiveRefreshRequest,
  type UseLiveChangesOptions,
} from "./use-live-changes.js";

interface Fixture {
  fake: FakeStash;
  client: StashClient;
}

function fixture(clientId = "tab-a", fetch?: StashFetch): Fixture {
  const adminToken = "live-ui-admin";
  const fake = createFakeStash({ adminToken });
  fake.createStash("notes");
  fake.createStash("archive");
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    clientId,
    fetch: fetch ?? fake.fetch,
  });
  return { fake, client };
}

function providerFor(client: StashClient) {
  return function Provider({ children }: PropsWithChildren) {
    return <StashUiProvider client={client}>{children}</StashUiProvider>;
  };
}

function change(
  changeId: number,
  origin: string | null,
  path = "docs/readme.txt",
): StashChangeEvent {
  return {
    type: "change",
    changeId,
    commitId: `legacy:${changeId}`,
    stash: "notes",
    path,
    version: changeId,
    kind: "put",
    origin,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

describe("useLiveChanges", () => {
  it("refreshes exactly once for ready and advances only from validated ready checkpoints", async () => {
    const { fake, client } = fixture("tab A!~");
    const seeded = await client
      .files("notes")
      .put(
        "docs/readme.txt",
        { body: "one", expectedVersion: null },
        { idempotencyKey: "seed-live-hook" },
      );
    expect(seeded.ok).toBe(true);
    const refresh = vi.fn<(request: LiveRefreshRequest) => void>();
    const rendered = renderHook(
      () => useLiveChanges("notes", { enabled: true, clientId: "tab A!~", refresh }),
      { wrapper: providerFor(client) },
    );

    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(rendered.result.current.checkpoint).toBe(1);
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({
      reason: "ready",
      checkpoint: null,
    });

    refresh.mockClear();
    act(() => fake.events.emit(change(99, "tab-b")));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({
      reason: "change",
      checkpoint: 1,
      path: "docs/readme.txt",
    });
    expect(rendered.result.current.checkpoint).toBe(1);

    refresh.mockClear();
    act(() => fake.events.emit(change(100, "tab A!~")));
    await flushMicrotasks();
    expect(refresh).not.toHaveBeenCalled();

    act(() =>
      fake.events.emit({
        type: "change-set",
        changeSetId: "cst_1787875200000deadbeef",
        stash: "notes",
        paths: ["docs/candidate.txt", "docs/second.txt"],
        status: "open",
        origin: "tab-b",
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({
      reason: "change-set",
      checkpoint: 1,
      path: "docs/candidate.txt",
    });
    expect(refresh.mock.calls[1]?.[0]).toMatchObject({
      reason: "change-set",
      checkpoint: 1,
      path: "docs/second.txt",
    });

    await flushMicrotasks();
    refresh.mockClear();
    const peer = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "live-ui-admin",
      clientId: "tab-b",
      fetch: fake.fetch,
    });
    const updated = await peer
      .files("notes")
      .put(
        "docs/readme.txt",
        { body: "two", expectedVersion: 1 },
        { idempotencyKey: "peer-live-update" },
      );
    expect(updated.ok).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({ reason: "change", checkpoint: 1 });

    await flushMicrotasks();
    refresh.mockClear();
    act(() => fake.events.rotate("notes", "lifetime"));
    await waitFor(() => expect(rendered.result.current.checkpoint).toBe(2));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({ reason: "ready", checkpoint: 1 });
  });

  it("retains the reconciled cursor when a newer ready refresh rejects", async () => {
    const { fake, client } = fixture();
    const seeded = await client
      .files("notes")
      .put(
        "docs/readme.txt",
        { body: "one", expectedVersion: null },
        { idempotencyKey: "seed-rejected-ready" },
      );
    expect(seeded.ok).toBe(true);
    const requests: LiveRefreshRequest[] = [];
    let rejectNextReady = false;
    const refresh = (request: LiveRefreshRequest): void | Promise<void> => {
      requests.push(request);
      if (rejectNextReady && request.reason === "ready") {
        rejectNextReady = false;
        return Promise.reject(new Error("authoritative refresh failed"));
      }
    };
    const rendered = renderHook(() => useLiveChanges("notes", { enabled: true, refresh }), {
      wrapper: providerFor(client),
    });

    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ reason: "ready", checkpoint: null });
    await flushMicrotasks();

    requests.length = 0;
    rejectNextReady = true;
    act(() => fake.events.emit("notes", { type: "ready", head: 5, checkpoint: 5 }));
    await waitFor(() => expect(rendered.result.current.checkpoint).toBe(5));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ reason: "ready", checkpoint: 1 });
    await flushMicrotasks();

    requests.length = 0;
    act(() => fake.events.emit(change(6, "peer", "docs/peer.txt")));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ reason: "change", checkpoint: 1 });
    await flushMicrotasks();

    requests.length = 0;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ reason: "focus", checkpoint: 1 });
    expect(rendered.result.current.checkpoint).toBe(5);
  });

  it("coalesces a live burst to one in-flight and the newest trailing refresh", async () => {
    const { fake, client } = fixture();
    const requests: LiveRefreshRequest[] = [];
    let blocked: ReturnType<typeof deferred> | null = null;
    const refresh = (request: LiveRefreshRequest) => {
      requests.push(request);
      return blocked?.promise;
    };
    renderHook(() => useLiveChanges("notes", { enabled: true, refresh }), {
      wrapper: providerFor(client),
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    requests.length = 0;
    blocked = deferred();

    act(() => {
      fake.events.emit(change(1, "peer", "one.txt"));
      fake.events.emit(change(2, "peer", "two.txt"));
      fake.events.emit(change(3, "peer", "three.txt"));
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ reason: "change", path: "one.txt" });
    blocked.resolve();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ reason: "change", path: "three.txt" });
  });

  it("unsubscribes while hidden and refreshes on visibility and focus recovery", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { fake, client } = fixture();
    const refresh = vi.fn<(request: LiveRefreshRequest) => void>();
    const rendered = renderHook(({ enabled }) => useLiveChanges("notes", { enabled, refresh }), {
      initialProps: { enabled: true },
      wrapper: providerFor(client),
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(rendered.result.current.status).toBe("off"));
    expect(fake.events.subscriberCount("notes")).toBe(0);

    refresh.mockClear();
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    await waitFor(() =>
      expect(refresh.mock.calls.some(([request]) => request.reason === "visibility")).toBe(true),
    );
    refresh.mockClear();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(refresh.mock.calls[0]?.[0].reason).toBe("focus");

    rendered.rerender({ enabled: false });
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));
    expect(rendered.result.current.status).toBe("off");
  });

  it("treats lifetime rotations as healthy reconnects", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fake, client } = fixture();
    const rendered = renderHook(() => useLiveChanges("notes", { enabled: true }), {
      wrapper: providerFor(client),
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("live"));

    act(() => fake.events.rotate("notes", "lifetime"));
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    expect(rendered.result.current.status).not.toBe("polling");
  });

  it("reports polling after three network failures and recovers through the same stream", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const adminToken = "live-ui-admin";
      const fake = createFakeStash({ adminToken });
      fake.createStash("notes");
      let rejectedReconnects = 0;
      const fetch: StashFetch = (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/events") && rejectedReconnects > 0) {
          rejectedReconnects -= 1;
          return Promise.reject(new TypeError("offline"));
        }
        return fake.fetch(input, init);
      };
      const client = createStashClient({
        baseUrl: "https://fake.invalid",
        token: adminToken,
        fetch,
      });
      const rendered = renderHook(() => useLiveChanges("notes", { enabled: true }), {
        wrapper: providerFor(client),
      });
      await flushMicrotasks();
      expect(rendered.result.current.status).toBe("live");

      rejectedReconnects = 2;
      act(() => fake.events.error("notes"));
      await flushMicrotasks();
      expect(rendered.result.current.status).toBe("reconnecting");
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      await flushMicrotasks();
      expect(rendered.result.current.status).toBe("reconnecting");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      await flushMicrotasks();

      expect(rendered.result.current.status).toBe("polling");
      expect(fake.events.subscriberCount("notes")).toBe(0);

      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      await flushMicrotasks();
      expect(rendered.result.current.status).toBe("live");
      expect(fake.events.subscriberCount("notes")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts stale refreshes and streams across stash changes and unmount", async () => {
    const { fake, client } = fixture();
    const requests: LiveRefreshRequest[] = [];
    const blocked = deferred();
    let blockChanges = false;
    const refresh = (request: LiveRefreshRequest) => {
      requests.push(request);
      return blockChanges && request.reason === "change" ? blocked.promise : undefined;
    };
    const rendered = renderHook(
      ({ stash }: { stash: string }) => useLiveChanges(stash, { enabled: true, refresh }),
      { initialProps: { stash: "notes" }, wrapper: providerFor(client) },
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("live"));
    blockChanges = true;
    act(() => fake.events.emit(change(1, "peer")));
    await waitFor(() => expect(requests.some(({ reason }) => reason === "change")).toBe(true));
    const stale = requests.find(({ reason }) => reason === "change");
    if (stale === undefined) throw new Error("Expected a change refresh");
    expect(stale.signal.aborted).toBe(false);

    rendered.rerender({ stash: "archive" });
    await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));
    await waitFor(() => expect(fake.events.subscriberCount("archive")).toBe(1));
    expect(stale.signal.aborted).toBe(true);
    expect(rendered.result.current.checkpoint).toBeNull();
    blocked.resolve();

    await waitFor(() =>
      expect(requests.some((request) => request !== stale && !request.signal.aborted)).toBe(true),
    );
    const archiveRequest = requests.find((request) => request !== stale && !request.signal.aborted);
    rendered.unmount();
    expect(fake.events.subscriberCount("archive")).toBe(0);
    expect(archiveRequest?.signal.aborted).toBe(true);
  });

  it("replaces the stream and abort boundary when the provider client changes", async () => {
    const first = fixture("tab-a");
    const second = fixture("tab-b");
    let activeClient = first.client;
    function Provider({ children }: PropsWithChildren) {
      return <StashUiProvider client={activeClient}>{children}</StashUiProvider>;
    }
    const requests: LiveRefreshRequest[] = [];
    const rendered = renderHook(
      ({ revision: _revision }: { revision: number }) =>
        useLiveChanges("notes", {
          enabled: true,
          refresh(request) {
            requests.push(request);
          },
        }),
      { initialProps: { revision: 0 }, wrapper: Provider },
    );
    await waitFor(() => expect(first.fake.events.subscriberCount("notes")).toBe(1));
    await waitFor(() => expect(requests).toHaveLength(1));
    const firstRequest = requests[0];
    if (firstRequest === undefined) throw new Error("Expected the first client refresh");

    activeClient = second.client;
    rendered.rerender({ revision: 1 });
    await waitFor(() => expect(first.fake.events.subscriberCount("notes")).toBe(0));
    await waitFor(() => expect(second.fake.events.subscriberCount("notes")).toBe(1));
    expect(firstRequest.signal.aborted).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.signal.aborted).toBe(false);
  });

  it("uses polling immediately when the provider client transport cannot subscribe", async () => {
    const binding = { request: vi.fn() };
    const client = createStashClient({
      transport: { kind: "rpc", binding, token: "rpc-token" },
    });
    const rendered = renderHook(
      () => useLiveChanges("notes", { enabled: true } satisfies UseLiveChangesOptions),
      { wrapper: providerFor(client) },
    );

    await waitFor(() => expect(rendered.result.current.status).toBe("polling"));
    expect(binding.request).toHaveBeenCalledOnce();
  });

  it("rejects a separately supplied non-canonical suppression identity", () => {
    const { client } = fixture();
    expect(() =>
      renderHook(() => useLiveChanges("notes", { enabled: true, clientId: "emoji🙂" }), {
        wrapper: providerFor(client),
      }),
    ).toThrow("clientId must contain between 1 and 64 characters");
  });
});
