import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export type AsyncState<T> =
  | { state: "loading"; value?: never; error?: never; reload: () => void }
  | { state: "ready"; value: T; error?: never; reload: () => void }
  | { state: "error"; value?: never; error: unknown; reload: () => void };

export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [result, setResult] = useState<Omit<AsyncState<T>, "reload">>({ state: "loading" });
  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setResult({ state: "loading" });

    void Promise.resolve()
      .then(() => fnRef.current(controller.signal))
      .then(
        (value) => {
          if (!controller.signal.aborted) setResult({ state: "ready", value });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setResult({ state: "error", error });
        },
      );

    return () => controller.abort();
    // This hook deliberately follows the caller-provided dependency list, like useEffect.
  }, [reloadVersion, ...deps]);

  return { ...result, reload } as AsyncState<T>;
}
