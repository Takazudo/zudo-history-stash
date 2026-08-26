import type { HistoryPage, StashClient, VersionRecord } from "@takazudo/zudo-history-stash";
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

interface FileHistoryTarget {
  clientForSignal: (signal: AbortSignal) => StashClient;
  stash: string;
  path: string;
  reloadVersion: number;
}

interface FileHistoryEntry extends FileHistoryTarget {
  snapshot: FileHistorySnapshot;
}

function loadingSnapshot(): FileHistorySnapshot {
  return {
    state: "loading",
    page: null,
    error: null,
    loadingMore: false,
    loadMoreError: null,
  };
}

function matchesTarget(entry: FileHistoryEntry, target: FileHistoryTarget): boolean {
  return (
    entry.clientForSignal === target.clientForSignal &&
    entry.stash === target.stash &&
    entry.path === target.path &&
    entry.reloadVersion === target.reloadVersion
  );
}

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
  const initialLifecycleRef = useRef({ clientForSignal, stash, path, page: initialPage, limit });
  const initialLifecycleActiveRef = useRef(true);
  const currentTarget = { clientForSignal, stash, path, reloadVersion };
  const [entry, setEntry] = useState<FileHistoryEntry>(() => ({
    ...currentTarget,
    snapshot: initialPage ? readySnapshot(initialPage) : loadingSnapshot(),
  }));
  const snapshot = matchesTarget(entry, currentTarget) ? entry.snapshot : loadingSnapshot();
  const snapshotRef = useRef(snapshot);
  const requestSequenceRef = useRef(0);
  const pagingControllerRef = useRef<AbortController | null>(null);
  const pagingPendingRef = useRef(false);

  useLayoutEffect(() => {
    const initial = initialLifecycleRef.current;
    if (
      initial.clientForSignal !== clientForSignal ||
      initial.stash !== stash ||
      initial.path !== path ||
      initial.limit !== limit
    ) {
      initialLifecycleActiveRef.current = false;
    }
  }, [clientForSignal, limit, path, stash]);

  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    pagingControllerRef.current?.abort();
    pagingPendingRef.current = false;
    const sequence = ++requestSequenceRef.current;
    const target = { clientForSignal, stash, path, reloadVersion };

    const initial = initialLifecycleRef.current;
    if (initialLifecycleActiveRef.current && initial.page && reloadVersion === 0) {
      setEntry({ ...target, snapshot: readySnapshot(initial.page) });
      return;
    }

    const controller = new AbortController();
    setEntry({ ...target, snapshot: loadingSnapshot() });
    const requestOptions = limit === undefined ? undefined : { limit };

    void clientValue(clientForSignal(controller.signal).files(stash).history(path, requestOptions))
      .then((page) => {
        if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
          setEntry({ ...target, snapshot: readySnapshot(page) });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
          setEntry({
            ...target,
            snapshot: {
              state: "error",
              page: null,
              error,
              loadingMore: false,
              loadMoreError: null,
            },
          });
        }
      });

    return () => controller.abort();
  }, [clientForSignal, limit, path, reloadVersion, stash]);

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
    const target = { clientForSignal, stash, path, reloadVersion };
    setEntry((latest) =>
      matchesTarget(latest, target) && latest.snapshot.state === "ready"
        ? {
            ...latest,
            snapshot: { ...latest.snapshot, loadingMore: true, loadMoreError: null },
          }
        : latest,
    );

    void clientValue(clientForSignal(controller.signal).files(stash).history(path, requestOptions))
      .then((nextPage) => {
        if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
        setEntry((latest) =>
          matchesTarget(latest, target) && latest.snapshot.state === "ready"
            ? {
                ...latest,
                snapshot: {
                  ...latest.snapshot,
                  page: mergeHistoryPage(latest.snapshot.page, nextPage),
                  loadingMore: false,
                  loadMoreError: null,
                },
              }
            : latest,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
        setEntry((latest) =>
          matchesTarget(latest, target) && latest.snapshot.state === "ready"
            ? {
                ...latest,
                snapshot: { ...latest.snapshot, loadingMore: false, loadMoreError: error },
              }
            : latest,
        );
      })
      .finally(() => {
        if (requestSequenceRef.current === sequence) pagingPendingRef.current = false;
      });
  }, [clientForSignal, limit, path, reloadVersion, stash]);

  return { ...snapshot, reload, loadMore } as FileHistoryState;
}
