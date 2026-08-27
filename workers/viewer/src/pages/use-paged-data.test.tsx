import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePagedData, type PageChunk } from "./use-paged-data.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("usePagedData", () => {
  it("serializes a live reset behind the current load and rejects when its load fails", async () => {
    const first = deferred<PageChunk<string, string>>();
    const second = deferred<PageChunk<string, string>>();
    let active = 0;
    let maxActive = 0;
    const load = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await (load.mock.calls.length === 1 ? first.promise : second.promise);
      } finally {
        active -= 1;
      }
    });
    const { result } = renderHook(() => usePagedData(load, [], (item) => item));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let reset!: Promise<void>;
    act(() => {
      reset = result.current.reset();
    });
    const rejection = reset.catch((error: unknown) => error);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ items: ["old"], nextCursor: null }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const failure = new Error("latest first page failed");
    await act(async () => second.reject(failure));

    await expect(rejection).resolves.toBe(failure);
    expect(maxActive).toBe(1);
    expect(result.current.error).toBe(failure);
    expect(result.current.items).toEqual(["old"]);
  });

  it("commits a blocked live reset before a queued same-target retry can fail", async () => {
    const livePage = deferred<PageChunk<string, string>>();
    const retryPage = deferred<PageChunk<string, string>>();
    const load = vi
      .fn<() => Promise<PageChunk<string, string>>>()
      .mockResolvedValueOnce({ items: ["initial"], nextCursor: null })
      .mockImplementationOnce(() => livePage.promise)
      .mockImplementationOnce(() => retryPage.promise);
    const { result } = renderHook(() => usePagedData(load, [], (item) => item));
    await waitFor(() => expect(result.current.items).toEqual(["initial"]));

    let liveReset!: Promise<void>;
    let queuedRetry!: Promise<void>;
    act(() => {
      liveReset = result.current.reset();
      queuedRetry = result.current.retry();
    });
    const retryFailure = queuedRetry.catch((error: unknown) => error);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    await act(async () => livePage.resolve({ items: ["live authoritative"], nextCursor: null }));
    await liveReset;
    expect(result.current.items).toEqual(["live authoritative"]);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));

    const failure = new Error("queued retry failed");
    await act(async () => retryPage.reject(failure));
    await expect(retryFailure).resolves.toBe(failure);
    expect(result.current.items).toEqual(["live authoritative"]);
    expect(result.current.error).toBe(failure);
  });
});
