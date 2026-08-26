import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDiffViewPreferences } from "./use-diff-view-preferences.js";

interface MutableMediaQueryList extends MediaQueryList {
  setMatches: (matches: boolean) => void;
}

function mutableMediaQueryList(initialMatches = false): MutableMediaQueryList {
  const events = new EventTarget();
  let matches = initialMatches;

  return {
    get matches() {
      return matches;
    },
    media: "(max-width: 56rem)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((type, listener, options) =>
      events.addEventListener(type, listener as EventListener, options),
    ),
    removeEventListener: vi.fn((type, listener, options) =>
      events.removeEventListener(type, listener as EventListener, options),
    ),
    dispatchEvent: (event) => events.dispatchEvent(event),
    setMatches(nextMatches) {
      matches = nextMatches;
      events.dispatchEvent(new Event("change"));
    },
  };
}

function useMedia(matches = false): MutableMediaQueryList {
  const mediaQuery = mutableMediaQueryList(matches);
  vi.spyOn(window, "matchMedia").mockReturnValue(mediaQuery);
  return mediaQuery;
}

describe("useDiffViewPreferences", () => {
  it("uses unified layout with marks and wrapping by default", () => {
    useMedia();
    const { result } = renderHook(useDiffViewPreferences);

    expect(result.current.preferredLayout).toBe("unified");
    expect(result.current.effectiveLayout).toBe("unified");
    expect(result.current.isNarrow).toBe(false);
    expect(result.current.marks).toBe(true);
    expect(result.current.wrap).toBe(true);
  });

  it("persists each preferred value across remounts", () => {
    useMedia();
    const first = renderHook(useDiffViewPreferences);

    act(() => {
      first.result.current.setPreferredLayout("split");
      first.result.current.setMarks(false);
      first.result.current.setWrap(false);
    });
    expect(localStorage.getItem("zhs.diff.layout")).toBe("split");
    expect(localStorage.getItem("zhs.diff.marks")).toBe("false");
    expect(localStorage.getItem("zhs.diff.wrap")).toBe("false");

    first.unmount();
    const second = renderHook(useDiffViewPreferences);
    expect(second.result.current.preferredLayout).toBe("split");
    expect(second.result.current.effectiveLayout).toBe("split");
    expect(second.result.current.marks).toBe(false);
    expect(second.result.current.wrap).toBe(false);
  });

  it("falls back to defaults for invalid stored values", () => {
    localStorage.setItem("zhs.diff.layout", "sideways");
    localStorage.setItem("zhs.diff.marks", "maybe");
    localStorage.setItem("zhs.diff.wrap", "maybe");
    useMedia();

    const { result } = renderHook(useDiffViewPreferences);
    expect(result.current.preferredLayout).toBe("unified");
    expect(result.current.marks).toBe(true);
    expect(result.current.wrap).toBe(true);
  });

  it("tolerates throwing storage reads and writes while keeping visible state usable", () => {
    useMedia();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage read blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage write blocked");
    });
    const { result } = renderHook(useDiffViewPreferences);

    expect(result.current.preferredLayout).toBe("unified");
    expect(result.current.marks).toBe(true);
    expect(result.current.wrap).toBe(true);
    act(() => {
      result.current.setPreferredLayout("split");
      result.current.setMarks(false);
      result.current.setWrap(false);
    });
    expect(result.current.preferredLayout).toBe("split");
    expect(result.current.marks).toBe(false);
    expect(result.current.wrap).toBe(false);
  });

  it("restores a stored split preference after a live narrow-to-wide change without writing", () => {
    localStorage.setItem("zhs.diff.layout", "split");
    const mediaQuery = useMedia(true);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(useDiffViewPreferences);

    expect(result.current.preferredLayout).toBe("split");
    expect(result.current.isNarrow).toBe(true);
    expect(result.current.effectiveLayout).toBe("unified");

    act(() => mediaQuery.setMatches(false));
    expect(result.current.preferredLayout).toBe("split");
    expect(result.current.isNarrow).toBe(false);
    expect(result.current.effectiveLayout).toBe("split");
    expect(setItem).not.toHaveBeenCalled();
  });
});
