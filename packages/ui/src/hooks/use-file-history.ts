import type { HistoryPage, StashClient, VersionRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clientValue } from "../components/error-banner.js";
import { useStashClientForSignal } from "../provider/hooks.js";

export interface UseFileHistoryOptions {
  /** A host may adopt an already-loaded first page without issuing a duplicate request. */
  initialPage?: HistoryPage;
  limit?: number;
}

interface FileHistoryCommon {
  reload: (signal?: AbortSignal) => Promise<void>;
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
  active: boolean;
  clientForSignal: (signal: AbortSignal) => StashClient;
  firstPagePending: number;
  lifecycle: AbortController;
  limit: number | undefined;
  path: string;
  stash: string;
  tail: Promise<void>;
}

interface FileHistoryEntry {
  target: FileHistoryTarget;
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

/** Load file history with abort-aware, serialized first-page refresh and keyset pagination. */
export function useFileHistory(
  stash: string,
  path: string,
  options: UseFileHistoryOptions = {},
): FileHistoryState {
  const { initialPage, limit } = options;
  const clientForSignal = useStashClientForSignal();
  const target = useMemo<FileHistoryTarget>(
    () => ({
      active: false,
      clientForSignal,
      firstPagePending: 0,
      lifecycle: new AbortController(),
      limit,
      path,
      stash,
      tail: Promise.resolve(),
    }),
    [clientForSignal, limit, path, stash],
  );
  const initialLifecycleRef = useRef({ clientForSignal, stash, path, page: initialPage, limit });
  const initialLifecycleActiveRef = useRef(true);
  const [entry, setEntry] = useState<FileHistoryEntry>(() => ({
    target,
    snapshot: initialPage ? readySnapshot(initialPage) : loadingSnapshot(),
  }));
  const snapshot = entry.target === target ? entry.snapshot : loadingSnapshot();
  const snapshotRef = useRef(snapshot);
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

  const reload = useCallback(
    (externalSignal?: AbortSignal): Promise<void> => {
      const lifecycleSignal = target.lifecycle.signal;
      target.firstPagePending += 1;
      pagingControllerRef.current?.abort();
      pagingControllerRef.current = null;
      pagingPendingRef.current = false;
      setEntry({ target, snapshot: loadingSnapshot() });

      const execute = async (): Promise<void> => {
        const signal =
          externalSignal === undefined
            ? lifecycleSignal
            : AbortSignal.any([lifecycleSignal, externalSignal]);
        signal.throwIfAborted();
        if (!target.active) {
          throw new DOMException("The history target is inactive.", "AbortError");
        }
        try {
          const requestOptions = target.limit === undefined ? undefined : { limit: target.limit };
          const page = await clientValue(
            target.clientForSignal(signal).files(target.stash).history(target.path, requestOptions),
          );
          signal.throwIfAborted();
          if (!target.active) {
            throw new DOMException("The history target is inactive.", "AbortError");
          }
          setEntry({ target, snapshot: readySnapshot(page) });
        } catch (error: unknown) {
          if (!signal.aborted && target.active) {
            setEntry({
              target,
              snapshot: {
                state: "error",
                page: null,
                error,
                loadingMore: false,
                loadMoreError: null,
              },
            });
          }
          throw error;
        }
      };

      const request = target.tail.then(execute, execute);
      const settled = request.finally(() => {
        target.firstPagePending -= 1;
      });
      target.tail = settled.catch(() => undefined);
      return settled;
    },
    [target],
  );

  useEffect(() => {
    if (target.lifecycle.signal.aborted) target.lifecycle = new AbortController();
    target.active = true;
    const initial = initialLifecycleRef.current;
    if (initialLifecycleActiveRef.current && initial.page) {
      setEntry({ target, snapshot: readySnapshot(initial.page) });
    } else {
      void reload().catch(() => {
        // The state channel owns initial-load failures; command callers receive their rejection.
      });
    }
    return () => {
      target.active = false;
      target.lifecycle.abort();
      pagingControllerRef.current?.abort();
      pagingControllerRef.current = null;
      pagingPendingRef.current = false;
    };
  }, [reload, target]);

  const loadMore = useCallback(() => {
    const current = snapshotRef.current;
    if (
      current.state !== "ready" ||
      current.page.nextBefore === null ||
      pagingPendingRef.current ||
      target.firstPagePending > 0
    ) {
      return;
    }

    pagingPendingRef.current = true;
    const before = current.page.nextBefore;
    setEntry((latest) =>
      latest.target === target && latest.snapshot.state === "ready"
        ? {
            target,
            snapshot: { ...latest.snapshot, loadingMore: true, loadMoreError: null },
          }
        : latest,
    );

    const execute = async (): Promise<void> => {
      const controller = new AbortController();
      pagingControllerRef.current = controller;
      const signal = AbortSignal.any([target.lifecycle.signal, controller.signal]);
      try {
        signal.throwIfAborted();
        const requestOptions =
          target.limit === undefined ? { before } : { before, limit: target.limit };
        const nextPage = await clientValue(
          target.clientForSignal(signal).files(target.stash).history(target.path, requestOptions),
        );
        signal.throwIfAborted();
        if (!target.active) return;
        setEntry((latest) =>
          latest.target === target && latest.snapshot.state === "ready"
            ? {
                target,
                snapshot: {
                  ...latest.snapshot,
                  page: mergeHistoryPage(latest.snapshot.page, nextPage),
                  loadingMore: false,
                  loadMoreError: null,
                },
              }
            : latest,
        );
      } catch (error: unknown) {
        if (!signal.aborted && target.active) {
          setEntry((latest) =>
            latest.target === target && latest.snapshot.state === "ready"
              ? {
                  target,
                  snapshot: { ...latest.snapshot, loadingMore: false, loadMoreError: error },
                }
              : latest,
          );
        }
      } finally {
        if (pagingControllerRef.current === controller) pagingControllerRef.current = null;
        pagingPendingRef.current = false;
      }
    };

    const request = target.tail.then(execute, execute);
    target.tail = request.catch(() => undefined);
  }, [target]);

  return { ...snapshot, reload, loadMore } as FileHistoryState;
}
