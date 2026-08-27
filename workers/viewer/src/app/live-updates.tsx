import type { ChangeItem } from "@takazudo/zudo-history-stash";
import {
  useLiveChanges,
  type LiveChangesStatus,
  type LiveRefreshReason,
  type LiveRefreshRequest,
} from "@takazudo/zudo-history-stash-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";
import { clientValue } from "../components/error-banner.js";
import { useStashClient, type ViewerStashClient } from "./auth/stash-client-provider.js";

export const VIEWER_LIVE_POLL_INTERVAL_MS = 30_000;
const CHANGE_PAGE_LIMIT = 200;

export type ViewerLiveRefreshReason = LiveRefreshReason | "polling";

export interface ViewerLiveRefreshBatch {
  reason: ViewerLiveRefreshReason;
  /** True when no reconciled consumer cursor existed and the complete feed was read from zero. */
  full: boolean;
  checkpoint: number | null;
  /** Authoritative, ascending change-feed rows. The event path is never substituted for these. */
  changes: readonly ChangeItem[];
  /** Advisory event path retained for diagnostics and optional prefetch only. */
  hintedPath?: string;
  /** Aborts when the active stash, credential client, tab identity, or visibility changes. */
  signal: AbortSignal;
}

export type ViewerLiveRefreshHandler = (batch: ViewerLiveRefreshBatch) => void | Promise<void>;

interface ViewerLiveContextValue {
  status: LiveChangesStatus;
  checkpoint: number | null;
  register(handler: ViewerLiveRefreshHandler): () => void;
}

interface AuthoritativeRefreshRequest extends Omit<LiveRefreshRequest, "reason"> {
  reason: ViewerLiveRefreshReason;
}

interface RefreshQueue {
  controller: AbortController;
  key: readonly [ViewerStashClient | null, string, string | undefined];
  tail: Promise<void>;
}

const OFF_LIVE_STATE = { status: "off", checkpoint: null } as const;
const ViewerLiveContext = createContext<ViewerLiveContextValue | null>(null);

/**
 * Owns the only event subscription for the active Viewer stash and fans authoritative feed rows to
 * page consumers. Page handlers may trigger their existing loaders, but never open another stream.
 */
export function ViewerLiveUpdatesProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { stash } = useParams();
  const { client, clientId } = useStashClient();
  const handlersRef = useRef(new Set<ViewerLiveRefreshHandler>());
  const refreshQueue = useMemo<RefreshQueue>(
    () => ({
      controller: new AbortController(),
      key: [client, clientId, stash],
      tail: Promise.resolve(),
    }),
    [client, clientId, stash],
  );

  useEffect(() => {
    if (refreshQueue.controller.signal.aborted) refreshQueue.controller = new AbortController();
    return () => refreshQueue.controller.abort();
  }, [refreshQueue]);

  const register = useCallback((handler: ViewerLiveRefreshHandler) => {
    handlersRef.current.add(handler);
    return () => handlersRef.current.delete(handler);
  }, []);

  const performAuthoritativeRefresh = useCallback(
    async (request: AuthoritativeRefreshRequest): Promise<void> => {
      request.signal.throwIfAborted();
      if (client === null || stash === undefined) {
        throw new Error("The live refresh target is no longer active.");
      }

      const full = request.checkpoint === null;
      let since = request.checkpoint ?? 0;
      const changes = new Map<number, ChangeItem>();
      const files = client.withSignal(request.signal).files(stash);

      while (true) {
        request.signal.throwIfAborted();
        const page = await clientValue(files.changes({ since, limit: CHANGE_PAGE_LIMIT }));
        for (const change of page.changes) changes.set(change.changeId, change);
        if (!page.hasMore) break;
        const nextSince = "nextSince" in page ? page.nextSince : null;
        if (typeof nextSince !== "number" || nextSince <= since) {
          throw new Error("The live change feed returned an invalid nextSince cursor.");
        }
        since = nextSince;
      }

      request.signal.throwIfAborted();
      const batch: ViewerLiveRefreshBatch = {
        reason: request.reason,
        full,
        checkpoint: request.checkpoint,
        changes: [...changes.values()].sort((left, right) => left.changeId - right.changeId),
        ...(request.path === undefined ? {} : { hintedPath: request.path }),
        signal: request.signal,
      };
      const results = await Promise.allSettled(
        [...handlersRef.current].map((handler) => handler(batch)),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed !== undefined) throw failed.reason;
      request.signal.throwIfAborted();
    },
    [client, stash],
  );

  const refreshAuthoritative = useCallback(
    (request: AuthoritativeRefreshRequest): Promise<void> => {
      const queueSignal = refreshQueue.controller.signal;
      const run = async () => {
        const signal = AbortSignal.any([request.signal, queueSignal]);
        signal.throwIfAborted();
        await performAuthoritativeRefresh({ ...request, signal });
      };
      const refresh = refreshQueue.tail.then(run, run);
      // Keep one active authoritative fetch across stream, focus/visibility, and polling triggers.
      refreshQueue.tail = refresh.catch(() => undefined);
      return refresh;
    },
    [performAuthoritativeRefresh, refreshQueue],
  );

  const live = useLiveChanges(stash ?? "", {
    enabled: enabled && client !== null && stash !== undefined,
    clientId,
    refresh: refreshAuthoritative,
  });

  useEffect(() => {
    if (
      live.status !== "polling" ||
      !enabled ||
      client === null ||
      stash === undefined ||
      typeof window === "undefined"
    ) {
      return;
    }

    const lifecycle = new AbortController();
    let pending = false;
    const poll = () => {
      if (pending || lifecycle.signal.aborted) return;
      pending = true;
      void refreshAuthoritative({
        reason: "polling",
        // The public checkpoint is server-advertised and can be newer than the last successfully
        // reconciled consumer cursor. A full reconciliation is the conservative polling fallback.
        checkpoint: null,
        signal: lifecycle.signal,
      })
        .catch(() => {
          // Polling is advisory and retries on the next named interval.
        })
        .finally(() => {
          pending = false;
        });
    };
    poll();
    const timer = window.setInterval(poll, VIEWER_LIVE_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      lifecycle.abort();
    };
  }, [client, enabled, live.status, refreshAuthoritative, stash]);

  const value = useMemo<ViewerLiveContextValue>(
    () => ({ status: live.status, checkpoint: live.checkpoint, register }),
    [live.checkpoint, live.status, register],
  );

  return <ViewerLiveContext.Provider value={value}>{children}</ViewerLiveContext.Provider>;
}

/** Registers one page-level fanout handler while keeping its latest closure without churn. */
export function useViewerLiveRefresh(handler: ViewerLiveRefreshHandler): void {
  const context = useContext(ViewerLiveContext);
  const register = context?.register;
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (register === undefined) return;
    return register((batch) => handlerRef.current(batch));
  }, [register]);
}

export function useViewerLiveStatus(): Pick<ViewerLiveContextValue, "status" | "checkpoint"> {
  const context = useContext(ViewerLiveContext);
  return context ?? OFF_LIVE_STATE;
}
