import {
  createStashClient,
  type ClientResult,
  type HistoryPage,
  type StashClient,
  type StashFilesClient,
  type VersionRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { useFileHistory } from "./use-file-history.js";

function version(value: number): VersionRecord {
  return {
    version: value,
    kind: "put",
    hash: `sha256-${value}`,
    size: value,
    rollbackOf: null,
    author: "Ada",
    message: `v${value}`,
    meta: {},
    createdAt: `2026-08-25T0${value}:00:00.000Z`,
  };
}

function page(
  versions: number[],
  nextBefore: number | null,
  path = "docs/readme.txt",
): HistoryPage {
  return {
    path,
    headVersion: Math.max(...versions),
    deleted: false,
    total: 4,
    versions: versions.map(version),
    nextBefore,
  };
}

function clientWithHistory(history: StashFilesClient["history"]): StashClient {
  const adminToken = "history-admin";
  const fake = createFakeStash({ adminToken });
  fake.createStash("notes");
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    fetch: fake.fetch,
  });
  const files = client.files("notes");
  vi.spyOn(client, "files").mockImplementation(() => ({ ...files, history }));
  return client;
}

function providerFor(
  client: StashClient,
  clientForSignal: (signal: AbortSignal) => StashClient = () => client,
) {
  return function Provider({ children }: PropsWithChildren) {
    return (
      <StashUiProvider client={client} clientForSignal={clientForSignal}>
        {children}
      </StashUiProvider>
    );
  };
}

describe("useFileHistory", () => {
  it("adopts a host page without a duplicate request and lets reload refresh it", async () => {
    const history = vi
      .fn<StashFilesClient["history"]>()
      .mockResolvedValue({ ok: true, value: page([4, 3, 2], null) });
    const client = clientWithHistory(history);
    const initialPage = page([3, 2], 2);
    const { result } = renderHook(
      () => useFileHistory("notes", "docs/readme.txt", { initialPage }),
      { wrapper: providerFor(client) },
    );

    expect(result.current.state).toBe("ready");
    expect(history).not.toHaveBeenCalled();

    act(() => result.current.reload());
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(history).toHaveBeenCalledOnce();
    if (result.current.state !== "ready") throw new Error("Expected ready history");
    expect(result.current.page.versions.map((item) => item.version)).toEqual([4, 3, 2]);
  });

  it("binds initial-page adoption and its cursor to the original client, stash, and path", async () => {
    const originalHistory = vi
      .fn<StashFilesClient["history"]>()
      .mockResolvedValue({ ok: true, value: page([9], null) });
    const originalClient = clientWithHistory(originalHistory);
    let resolveNext!: (result: ClientResult<HistoryPage>) => void;
    const nextRequest = new Promise<ClientResult<HistoryPage>>((resolve) => {
      resolveNext = resolve;
    });
    const nextHistory = vi.fn<StashFilesClient["history"]>().mockReturnValue(nextRequest);
    const nextClient = clientWithHistory(nextHistory);
    const initialPage = page([3, 2], 2);
    let activeClient = originalClient;
    function Provider({ children }: PropsWithChildren) {
      return <StashUiProvider client={activeClient}>{children}</StashUiProvider>;
    }
    const rendered = renderHook(({ stash, path }) => useFileHistory(stash, path, { initialPage }), {
      initialProps: { stash: "notes", path: "docs/readme.txt" },
      wrapper: Provider,
    });

    expect(rendered.result.current.state).toBe("ready");
    expect(originalHistory).not.toHaveBeenCalled();

    activeClient = nextClient;
    rendered.rerender({ stash: "archive", path: "next.txt" });
    expect(rendered.result.current.state).toBe("loading");
    expect(rendered.result.current.page).toBeNull();
    act(() => rendered.result.current.loadMore());
    expect(nextHistory).toHaveBeenCalledOnce();
    expect(nextHistory).toHaveBeenCalledWith("next.txt", undefined);
    expect(nextClient.files).toHaveBeenCalledWith("archive");
    expect(originalHistory).not.toHaveBeenCalled();

    await act(async () => resolveNext({ ok: true, value: page([8], null, "next.txt") }));
    await waitFor(() => expect(rendered.result.current.state).toBe("ready"));
    if (rendered.result.current.state !== "ready") throw new Error("Expected ready history");
    expect(rendered.result.current.page.path).toBe("next.txt");

    activeClient = originalClient;
    rendered.rerender({ stash: "notes", path: "docs/readme.txt" });
    expect(rendered.result.current.state).toBe("loading");
    await waitFor(() => expect(rendered.result.current.state).toBe("ready"));
    expect(originalHistory).toHaveBeenCalledOnce();
    expect(originalHistory).toHaveBeenCalledWith("docs/readme.txt", undefined);
    expect(originalClient.files).toHaveBeenCalledWith("notes");
    if (rendered.result.current.state !== "ready") throw new Error("Expected ready history");
    expect(rendered.result.current.page.versions[0]?.version).toBe(9);
  });

  it("uses before-keyset pagination, newest-first merge, dedupe, and signal clients", async () => {
    const history = vi
      .fn<StashFilesClient["history"]>()
      .mockResolvedValueOnce({ ok: true, value: page([3, 4, 2], 2) })
      .mockResolvedValueOnce({ ok: true, value: page([2, 1], null) });
    const client = clientWithHistory(history);
    const signals: AbortSignal[] = [];
    const clientForSignal = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return client;
    });
    const rendered = renderHook(() => useFileHistory("notes", "docs/readme.txt"), {
      wrapper: providerFor(client, clientForSignal),
    });

    expect(rendered.result.current.state).toBe("loading");
    await waitFor(() => expect(rendered.result.current.state).toBe("ready"));
    if (rendered.result.current.state !== "ready") throw new Error("Expected ready history");
    expect(rendered.result.current.page.versions.map((item) => item.version)).toEqual([4, 3, 2]);

    act(() => rendered.result.current.loadMore());
    await waitFor(() => {
      if (rendered.result.current.state !== "ready") throw new Error("Expected ready history");
      expect(rendered.result.current.page.versions.map((item) => item.version)).toEqual([
        4, 3, 2, 1,
      ]);
    });
    expect(history).toHaveBeenNthCalledWith(1, "docs/readme.txt", undefined);
    expect(history).toHaveBeenNthCalledWith(2, "docs/readme.txt", { before: 2 });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    rendered.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("exposes initial errors and retries from a clean loading state", async () => {
    const failure: ClientResult<HistoryPage> = {
      ok: false,
      error: { status: 503, code: "internal", message: "offline" },
    };
    const history = vi
      .fn<StashFilesClient["history"]>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ ok: true, value: page([4, 3], null) });
    const client = clientWithHistory(history);
    const { result } = renderHook(() => useFileHistory("notes", "docs/readme.txt"), {
      wrapper: providerFor(client),
    });

    await waitFor(() => expect(result.current.state).toBe("error"));
    act(() => result.current.reload());
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("keeps a loaded page visible while a failed load-more request is explicitly retried", async () => {
    const history = vi
      .fn<StashFilesClient["history"]>()
      .mockResolvedValueOnce({ ok: true, value: page([4, 3, 2], 2) })
      .mockResolvedValueOnce({
        ok: false,
        error: { status: 503, code: "internal", message: "paging offline" },
      })
      .mockResolvedValueOnce({ ok: true, value: page([2, 1], null) });
    const client = clientWithHistory(history);
    const { result } = renderHook(() => useFileHistory("notes", "docs/readme.txt"), {
      wrapper: providerFor(client),
    });
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => result.current.loadMore());
    await waitFor(() => {
      expect(result.current.state).toBe("ready");
      if (result.current.state === "ready") expect(result.current.loadMoreError).toBeTruthy();
    });
    if (result.current.state !== "ready") throw new Error("Expected ready history");
    expect(result.current.page.versions.map((item) => item.version)).toEqual([4, 3, 2]);

    act(() => result.current.loadMore());
    await waitFor(() => {
      if (result.current.state !== "ready") throw new Error("Expected ready history");
      expect(result.current.page.nextBefore).toBeNull();
      expect(result.current.page.versions.map((item) => item.version)).toEqual([4, 3, 2, 1]);
    });
    expect(history).toHaveBeenCalledTimes(3);
  });

  it("uses its request sequence guard when an AbortController implementation cannot signal", async () => {
    const NativeAbortController = globalThis.AbortController;
    class NonSignallingAbortController {
      readonly signal = new NativeAbortController().signal;
      abort() {
        // Deliberately does not mark signal.aborted, exercising the sequence fallback.
      }
    }
    vi.stubGlobal("AbortController", NonSignallingAbortController);

    let resolveOld!: (result: ClientResult<HistoryPage>) => void;
    let resolveNew!: (result: ClientResult<HistoryPage>) => void;
    const oldRequest = new Promise<ClientResult<HistoryPage>>((resolve) => {
      resolveOld = resolve;
    });
    const newRequest = new Promise<ClientResult<HistoryPage>>((resolve) => {
      resolveNew = resolve;
    });
    const history = vi.fn<StashFilesClient["history"]>((path) =>
      path === "old.txt" ? oldRequest : newRequest,
    );
    const client = clientWithHistory(history);
    const rendered = renderHook(({ path }) => useFileHistory("notes", path), {
      initialProps: { path: "old.txt" },
      wrapper: providerFor(client),
    });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    rendered.rerender({ path: "new.txt" });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

    await act(async () => resolveNew({ ok: true, value: page([7], null, "new.txt") }));
    await waitFor(() => expect(rendered.result.current.state).toBe("ready"));
    await act(async () => resolveOld({ ok: true, value: page([99], null, "old.txt") }));
    if (rendered.result.current.state !== "ready") throw new Error("Expected ready history");
    expect(rendered.result.current.page.path).toBe("new.txt");
    expect(rendered.result.current.page.versions[0]?.version).toBe(7);
  });
});
