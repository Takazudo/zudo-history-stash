import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { useAsync } from "../hooks/use-async.js";

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
  retry(): void;
  reset(): void;
}

export function usePagedData<Item, Cursor>(
  load: (signal: AbortSignal, cursor: Cursor | null) => Promise<PageChunk<Item, Cursor>>,
  deps: DependencyList,
  getKey: (item: Item) => string | number,
): PagedData<Item> {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;
  const request = useAsync((signal) => load(signal, cursor), [...deps, cursor]);
  const readyValue = request.state === "ready" ? request.value : undefined;

  useEffect(() => {
    if (!readyValue) return;
    setItems((current) => {
      const combined = cursor === null ? readyValue.items : [...current, ...readyValue.items];
      const seen = new Set<string | number>();
      return combined.filter((item) => {
        const key = getKeyRef.current(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    setNextCursor(readyValue.nextCursor);
  }, [cursor, readyValue]);

  const reset = useCallback(() => {
    setItems([]);
    setNextCursor(null);
    setCursor(null);
    request.reload();
  }, [request.reload]);

  return {
    items,
    loading: request.state === "loading",
    initialLoading: request.state === "loading" && items.length === 0,
    error: request.state === "error" ? request.error : null,
    hasMore: nextCursor !== null,
    loadMore: () => {
      if (request.state !== "loading" && nextCursor !== null) setCursor(nextCursor);
    },
    retry: request.reload,
    reset,
  };
}
