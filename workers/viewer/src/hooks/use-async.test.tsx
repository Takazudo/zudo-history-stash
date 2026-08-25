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

    act(() => result.current.reload());
    expect(result.current.state).toBe("loading");
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
});
