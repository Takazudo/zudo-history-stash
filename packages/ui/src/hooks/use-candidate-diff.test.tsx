import { act, renderHook } from "@testing-library/react";
import { DIFF_MAX_BYTES } from "@takazudo/zudo-history-stash-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCandidateDiff } from "./use-candidate-diff.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("useCandidateDiff", () => {
  it("memoizes the current model and debounces changed input for 250ms", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ draftText }) =>
        useCandidateDiff({
          baseText: "first\nsecond\n",
          draftText,
          context: 2,
        }),
      { initialProps: { draftText: "first\nchanged\n" } },
    );

    const initial = result.current;
    expect(initial).toMatchObject({
      stats: { added: 1, removed: 1 },
      same: false,
      oversized: false,
    });
    expect(initial.model).not.toBeNull();

    rerender({ draftText: "first\nchanged\n" });
    expect(result.current).toBe(initial);

    rerender({ draftText: "first\nthird\n" });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe(initial);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).not.toBe(initial);
    expect(result.current).toMatchObject({
      stats: { added: 1, removed: 1 },
      same: false,
      oversized: false,
    });
  });

  it("reports identical text without a display model", () => {
    const { result } = renderHook(() =>
      useCandidateDiff({ baseText: "same\n", draftText: "same\n", context: 3 }),
    );

    expect(result.current).toEqual({
      model: null,
      stats: { added: 0, removed: 0 },
      same: true,
      oversized: false,
    });
  });

  it("reports an oversized local diff without making a network request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const draftText = "x".repeat(DIFF_MAX_BYTES + 1);

    const { result } = renderHook(() => useCandidateDiff({ baseText: "", draftText, context: 3 }));

    expect(result.current).toEqual({
      model: null,
      stats: { added: 0, removed: 0 },
      same: false,
      oversized: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
