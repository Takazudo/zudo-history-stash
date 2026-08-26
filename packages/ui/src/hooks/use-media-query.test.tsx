import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./use-media-query.js";

interface MutableMediaQueryList extends MediaQueryList {
  setMatches: (matches: boolean) => void;
}

function mutableMediaQueryList(initialMatches: boolean): MutableMediaQueryList {
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

describe("useMediaQuery", () => {
  it("returns false during server rendering without a window", () => {
    vi.stubGlobal("window", undefined);

    function QueryResult() {
      return <span>{String(useMediaQuery("(max-width: 56rem)"))}</span>;
    }

    expect(renderToString(<QueryResult />)).toBe("<span>false</span>");
  });

  it("reads matchMedia and subscribes to live change events", () => {
    const mediaQuery = mutableMediaQueryList(true);
    const matchMedia = vi.fn(() => mediaQuery);
    vi.stubGlobal("matchMedia", matchMedia);
    const { result, unmount } = renderHook(() => useMediaQuery("(max-width: 56rem)"));

    expect(matchMedia).toHaveBeenCalledWith("(max-width: 56rem)");
    expect(result.current).toBe(true);
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    act(() => mediaQuery.setMatches(false));
    expect(result.current).toBe(false);

    unmount();
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
