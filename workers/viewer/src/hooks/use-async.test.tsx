import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAsync } from "./use-async.js";

describe("useAsync", () => {
  it("moves from loading to ready and reloads on demand", async () => {
    const load = vi.fn(async () => load.mock.calls.length);
    const { result } = renderHook(() => useAsync(load, []));

    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    if (result.current.state === "ready") expect(result.current.value).toBe(1);

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    expect(result.current.state).toBe("loading");
    await act(async () => reload);
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.state).toBe("ready");
    });
  });

  it("exposes rejected requests as an error state", async () => {
    const failure = new Error("offline");
    const { result } = renderHook(() => useAsync(async () => Promise.reject(failure), []));

    await waitFor(() => expect(result.current.state).toBe("error"));
    if (result.current.state === "error") expect(result.current.error).toBe(failure);
  });

  it("aborts the active request when dependencies change and on unmount", async () => {
    const signals: AbortSignal[] = [];
    const { rerender, unmount } = renderHook(
      ({ value }) =>
        useAsync(
          async (signal) => {
            signals.push(signal);
            return value;
          },
          [value],
        ),
      { initialProps: { value: 1 } },
    );

    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ value: 2 });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);

    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("queues a command reload without overlapping and rejects its request failure", async () => {
    let resolveFirst!: (value: number) => void;
    const first = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    let rejectSecond!: (error: unknown) => void;
    const second = new Promise<number>((_resolve, reject) => {
      rejectSecond = reject;
    });
    let active = 0;
    let maxActive = 0;
    const load = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await (load.mock.calls.length === 1 ? first : second);
      } finally {
        active -= 1;
      }
    });
    const { result } = renderHook(() => useAsync(load, []));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    const rejection = reload.catch((error: unknown) => error);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst(1));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const failure = new Error("reload failed");
    await act(async () => rejectSecond(failure));

    await expect(rejection).resolves.toBe(failure);
    expect(maxActive).toBe(1);
    expect(result.current.state).toBe("error");
  });
});
