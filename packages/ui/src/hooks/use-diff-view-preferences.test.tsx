import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffViewPreferences } from "./use-diff-view-preferences.js";

interface MutableMediaQueryList extends MediaQueryList {
  setMatches: (matches: boolean) => void;
}

function useMutableMedia(initialMatches = false): MutableMediaQueryList {
  const events = new EventTarget();
  let matches = initialMatches;
  const mediaQuery: MutableMediaQueryList = {
    get matches() {
      return matches;
    },
    media: "(max-width: 56rem)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => events.addEventListener(type, listener as EventListener, options),
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => events.removeEventListener(type, listener as EventListener, options),
    dispatchEvent: (event) => events.dispatchEvent(event),
    setMatches(nextMatches) {
      matches = nextMatches;
      events.dispatchEvent(new Event("change"));
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQuery),
  );
  return mediaQuery;
}

afterEach(() => localStorage.clear());

describe("useDiffViewPreferences package hook", () => {
  it("defaults to unified with marks and wrapping", () => {
    useMutableMedia();
    const { result } = renderHook(useDiffViewPreferences);
    expect(result.current).toMatchObject({
      preferredLayout: "unified",
      effectiveLayout: "unified",
      isNarrow: false,
      marks: true,
      wrap: true,
    });
  });

  it("persists preferences and restores split after a narrow viewport widens", () => {
    const media = useMutableMedia(true);
    const first = renderHook(useDiffViewPreferences);
    act(() => {
      first.result.current.setPreferredLayout("split");
      first.result.current.setMarks(false);
      first.result.current.setWrap(false);
    });
    expect(first.result.current.effectiveLayout).toBe("unified");
    expect(localStorage.getItem("zhs.diff.layout")).toBe("split");

    act(() => media.setMatches(false));
    expect(first.result.current.effectiveLayout).toBe("split");
    first.unmount();

    useMutableMedia(false);
    const second = renderHook(useDiffViewPreferences);
    expect(second.result.current).toMatchObject({
      preferredLayout: "split",
      effectiveLayout: "split",
      marks: false,
      wrap: false,
    });
  });

  it("survives unavailable storage while keeping live state usable", () => {
    useMutableMedia();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(useDiffViewPreferences);
    act(() => result.current.setPreferredLayout("split"));
    expect(result.current.preferredLayout).toBe("split");
  });
});
