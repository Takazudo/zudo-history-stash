import { useCallback, useMemo, useSyncExternalStore } from "react";

function mediaQueryFor(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

export function useMediaQuery(query: string): boolean {
  const mediaQuery = useMemo(() => mediaQueryFor(query), [query]);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (mediaQuery === null) return () => undefined;
      mediaQuery.addEventListener("change", notify);
      return () => mediaQuery.removeEventListener("change", notify);
    },
    [mediaQuery],
  );
  const getSnapshot = useCallback(() => mediaQuery?.matches ?? false, [mediaQuery]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
