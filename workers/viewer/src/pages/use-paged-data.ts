import { useCallback, useEffect, useMemo, useState, type DependencyList } from "react";

export interface PageChunk<Item, Cursor> {
  items: Item[];
  nextCursor: Cursor | null;
}

export interface PagedData<Item> {
  items: Item[];
  loading: boolean;
  initialLoading: boolean;
  error: unknown | null;
  hasMore: boolean;
  loadMore(): void;
  retry(signal?: AbortSignal): Promise<void>;
  reset(signal?: AbortSignal): Promise<void>;
}

interface PagedSnapshot<Item, Cursor> {
  items: Item[];
  loading: boolean;
  error: unknown | null;
  nextCursor: Cursor | null;
}

interface PagedTarget<Item, Cursor> {
  active: boolean;
  lifecycle: AbortController;
  load: (signal: AbortSignal, cursor: Cursor | null) => Promise<PageChunk<Item, Cursor>>;
  getKey: (item: Item) => string | number;
  loadMorePending: boolean;
  tail: Promise<void>;
}

interface PagedEntry<Item, Cursor> {
  target: PagedTarget<Item, Cursor>;
  snapshot: PagedSnapshot<Item, Cursor>;
}

function initialSnapshot<Item, Cursor>(): PagedSnapshot<Item, Cursor> {
  return { items: [], loading: true, error: null, nextCursor: null };
}

function uniqueItems<Item>(
  items: readonly Item[],
  getKey: (item: Item) => string | number,
): Item[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function usePagedData<Item, Cursor>(
  load: (signal: AbortSignal, cursor: Cursor | null) => Promise<PageChunk<Item, Cursor>>,
  deps: DependencyList,
  getKey: (item: Item) => string | number,
): PagedData<Item> {
  // The caller-provided list defines the pagination target, like a useEffect dependency list.
  const target = useMemo<PagedTarget<Item, Cursor>>(
    () => ({
      active: false,
      lifecycle: new AbortController(),
      load,
      getKey,
      loadMorePending: false,
      tail: Promise.resolve(),
    }),
    deps,
  );
  const [entry, setEntry] = useState<PagedEntry<Item, Cursor>>(() => ({
    target,
    snapshot: initialSnapshot(),
  }));
  const snapshot = entry.target === target ? entry.snapshot : initialSnapshot<Item, Cursor>();

  const requestPage = useCallback(
    (cursor: Cursor | null, replace: boolean, externalSignal?: AbortSignal): Promise<void> => {
      const lifecycleSignal = target.lifecycle.signal;
      setEntry((current) => ({
        target,
        snapshot: {
          ...(current.target === target ? current.snapshot : initialSnapshot<Item, Cursor>()),
          loading: true,
          error: null,
        },
      }));

      const execute = async (): Promise<void> => {
        const signal =
          externalSignal === undefined
            ? lifecycleSignal
            : AbortSignal.any([lifecycleSignal, externalSignal]);
        signal.throwIfAborted();
        if (!target.active) throw new DOMException("The page target is inactive.", "AbortError");
        try {
          const page = await target.load(signal, cursor);
          signal.throwIfAborted();
          if (!target.active) {
            throw new DOMException("The page target is inactive.", "AbortError");
          }
          setEntry((current) => {
            const base =
              current.target === target ? current.snapshot : initialSnapshot<Item, Cursor>();
            const items = replace ? page.items : [...base.items, ...page.items];
            return {
              target,
              snapshot: {
                items: uniqueItems(items, target.getKey),
                loading: false,
                error: null,
                nextCursor: page.nextCursor,
              },
            };
          });
        } catch (error: unknown) {
          if (!signal.aborted && target.active) {
            setEntry((current) => ({
              target,
              snapshot: {
                ...(current.target === target ? current.snapshot : initialSnapshot<Item, Cursor>()),
                loading: false,
                error,
              },
            }));
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

  const reset = useCallback(
    (signal?: AbortSignal) => requestPage(null, true, signal),
    [requestPage],
  );

  useEffect(() => {
    if (target.lifecycle.signal.aborted) target.lifecycle = new AbortController();
    target.active = true;
    void reset().catch(() => {
      // The state channel owns initial-load failures; command callers receive their rejection.
    });
    return () => {
      target.active = false;
      target.lifecycle.abort();
    };
  }, [reset, target]);

  return {
    items: snapshot.items,
    loading: snapshot.loading,
    initialLoading: snapshot.loading && snapshot.items.length === 0,
    error: snapshot.error,
    hasMore: snapshot.nextCursor !== null,
    loadMore: () => {
      if (snapshot.loading || snapshot.nextCursor === null || target.loadMorePending) return;
      target.loadMorePending = true;
      void requestPage(snapshot.nextCursor, false)
        .catch(() => undefined)
        .finally(() => {
          target.loadMorePending = false;
        });
    },
    retry: reset,
    reset,
  };
}
