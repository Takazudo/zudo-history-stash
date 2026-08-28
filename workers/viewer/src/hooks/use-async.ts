import { useCallback, useEffect, useMemo, useState, type DependencyList } from "react";

export type AsyncReload = (signal?: AbortSignal) => Promise<void>;

export type AsyncState<T> =
  | { state: "loading"; value?: never; error?: never; reload: AsyncReload }
  | { state: "ready"; value: T; error?: never; reload: AsyncReload }
  | { state: "error"; value?: never; error: unknown; reload: AsyncReload };

type AsyncSnapshot<T> = Omit<AsyncState<T>, "reload">;

interface AsyncTarget<T> {
  active: boolean;
  lifecycle: AbortController;
  load: (signal: AbortSignal) => Promise<T>;
  tail: Promise<void>;
}

interface AsyncEntry<T> {
  target: AsyncTarget<T>;
  snapshot: AsyncSnapshot<T>;
}

function createTarget<T>(load: (signal: AbortSignal) => Promise<T>): AsyncTarget<T> {
  return {
    active: false,
    lifecycle: new AbortController(),
    load,
    tail: Promise.resolve(),
  };
}

/** Viewer-local request state with one serialized command queue per caller-provided target. */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncState<T> {
  // The caller-provided list defines the request target, like a useEffect dependency list.
  const target = useMemo(() => createTarget(fn), deps);
  const [entry, setEntry] = useState<AsyncEntry<T>>(() => ({
    target,
    snapshot: { state: "loading" },
  }));
  const snapshot = entry.target === target ? entry.snapshot : ({ state: "loading" } as const);

  const reload = useCallback<AsyncReload>(
    (externalSignal) => {
      setEntry({ target, snapshot: { state: "loading" } });
      const lifecycleSignal = target.lifecycle.signal;
      const execute = async (): Promise<void> => {
        const signal =
          externalSignal === undefined
            ? lifecycleSignal
            : AbortSignal.any([lifecycleSignal, externalSignal]);
        signal.throwIfAborted();
        if (!target.active) throw new DOMException("The request target is inactive.", "AbortError");

        try {
          const value = await target.load(signal);
          signal.throwIfAborted();
          if (!target.active) {
            throw new DOMException("The request target is inactive.", "AbortError");
          }
          setEntry({ target, snapshot: { state: "ready", value } });
        } catch (error: unknown) {
          if (!signal.aborted && target.active) {
            setEntry({ target, snapshot: { state: "error", error } });
          }
          throw error;
        }
      };

      const request = target.tail.then(execute, execute);
      target.tail = request.catch(() => undefined);
      return request;
    },
    [target],
  );

  useEffect(() => {
    if (target.lifecycle.signal.aborted) target.lifecycle = new AbortController();
    target.active = true;
    void reload().catch(() => {
      // The state channel owns initial-load failures; command callers receive their rejection.
    });
    return () => {
      target.active = false;
      target.lifecycle.abort();
    };
  }, [reload, target]);

  return { ...snapshot, reload } as AsyncState<T>;
}
