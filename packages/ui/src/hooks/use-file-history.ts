import type { HistoryPage, VersionRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clientValue } from "../components/error-banner.js";
import { useStashClientForSignal } from "../provider/hooks.js";

export interface UseFileHistoryOptions {
  /** A host may adopt an already-loaded first page without issuing a duplicate request. */
  initialPage?: HistoryPage;
  limit?: number;
}

interface FileHistoryCommon {
  reload: () => void;
  loadMore: () => void;
}

export type FileHistoryState =
  | (FileHistoryCommon & {
      state: "loading";
      page: null;
      error: null;
      loadingMore: false;
      loadMoreError: null;
    })
  | (FileHistoryCommon & {
      state: "error";
      page: null;
      error: unknown;
      loadingMore: false;
      loadMoreError: null;
    })
  | (FileHistoryCommon & {
      state: "ready";
      page: HistoryPage;
      error: null;
      loadingMore: boolean;
      loadMoreError: unknown | null;
    });

type WithoutHistoryActions<T> = T extends FileHistoryCommon
  ? Omit<T, keyof FileHistoryCommon>
  : never;
type FileHistorySnapshot = WithoutHistoryActions<FileHistoryState>;

function newestFirst(versions: readonly VersionRecord[]): VersionRecord[] {
  return [...versions].sort((left, right) => right.version - left.version);
}

function mergeHistoryPage(current: HistoryPage, incoming: HistoryPage): HistoryPage {
  const byVersion = new Map(current.versions.map((version) => [version.version, version] as const));
  for (const version of incoming.versions) byVersion.set(version.version, version);
  return {
    ...current,
    headVersion: Math.max(current.headVersion, incoming.headVersion),
    deleted: incoming.headVersion >= current.headVersion ? incoming.deleted : current.deleted,
    total: Math.max(current.total, incoming.total),
    versions: newestFirst([...byVersion.values()]),
    nextBefore: incoming.nextBefore,
  };
}

function readySnapshot(page: HistoryPage): FileHistorySnapshot {
  return {
    state: "ready",
    page: { ...page, versions: newestFirst(page.versions) },
    error: null,
    loadingMore: false,
    loadMoreError: null,
  };
}

/** Load file history with abort-aware keyset pagination and a sequence fallback for signal-less hosts. */
export function useFileHistory(
  stash: string,
  path: string,
  options: UseFileHistoryOptions = {},
): FileHistoryState {
  const { initialPage, limit } = options;
  const clientForSignal = useStashClientForSignal();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<FileHistorySnapshot>(() =>
    initialPage
      ? readySnapshot(initialPage)
      : {
          state: "loading",
          page: null,
          error: null,
          loadingMore: false,
          loadMoreError: null,
        },
  );
  const snapshotRef = useRef(snapshot);
  const requestSequenceRef = useRef(0);
  const pagingControllerRef = useRef<AbortController | null>(null);
  const pagingPendingRef = useRef(false);

  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    pagingControllerRef.current?.abort();
    pagingPendingRef.current = false;
    const sequence = ++requestSequenceRef.current;

    if (initialPage && reloadVersion === 0) {
      setSnapshot(readySnapshot(initialPage));
      return;
    }

    const controller = new AbortController();
    setSnapshot({
      state: "loading",
      page: null,
      error: null,
      loadingMore: false,
      loadMoreError: null,
    });
    const requestOptions = limit === undefined ? undefined : { limit };

    void clientValue(clientForSignal(controller.signal).files(stash).history(path, requestOptions))
      .then((page) => {
        if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
          setSnapshot(readySnapshot(page));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
          setSnapshot({
            state: "error",
            page: null,
            error,
            loadingMore: false,
            loadMoreError: null,
          });
        }
      });

    return () => controller.abort();
  }, [clientForSignal, initialPage, limit, path, reloadVersion, stash]);

  useEffect(
    () => () => {
      requestSequenceRef.current += 1;
      pagingControllerRef.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    const current = snapshotRef.current;
    if (current.state !== "ready" || current.page.nextBefore === null || pagingPendingRef.current) {
      return;
    }

    pagingControllerRef.current?.abort();
    const controller = new AbortController();
    pagingControllerRef.current = controller;
    pagingPendingRef.current = true;
    const sequence = ++requestSequenceRef.current;
    const before = current.page.nextBefore;
    const requestOptions = limit === undefined ? { before } : { before, limit };
    setSnapshot({ ...current, loadingMore: true, loadMoreError: null });

    void clientValue(clientForSignal(controller.signal).files(stash).history(path, requestOptions))
      .then((nextPage) => {
        if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
        setSnapshot((latest) =>
          latest.state === "ready"
            ? {
                ...latest,
                page: mergeHistoryPage(latest.page, nextPage),
                loadingMore: false,
                loadMoreError: null,
              }
            : latest,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
        setSnapshot((latest) =>
          latest.state === "ready"
            ? { ...latest, loadingMore: false, loadMoreError: error }
            : latest,
        );
      })
      .finally(() => {
        if (requestSequenceRef.current === sequence) pagingPendingRef.current = false;
      });
  }, [clientForSignal, limit, path, stash]);

  return { ...snapshot, reload, loadMore } as FileHistoryState;
}
