import type { StashEventStream, StashLiveStatus } from "@takazudo/zudo-history-stash";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStashClient } from "../provider/hooks.js";
import { createRefreshScheduler } from "./refresh-scheduler.js";

export type LiveChangesStatus = "live" | "reconnecting" | "polling" | "off";

export type LiveRefreshReason = "ready" | "change" | "proposal" | "focus" | "visibility";

/** Advisory input for a host refresh. The host's `since=` feed remains the correctness source. */
export interface LiveRefreshRequest {
  reason: LiveRefreshReason;
  /** Query the authoritative change feed strictly after this consumer checkpoint. */
  checkpoint: number | null;
  /** A targeted-invalidation hint only; consumers must not treat it as a complete change set. */
  path?: string;
  /** Aborts when this hook unmounts, hides, or changes client/stash identity. */
  signal: AbortSignal;
}

export interface UseLiveChangesOptions {
  enabled: boolean;
  /** Stable identity also passed to createStashClient, used only to suppress own live echoes. */
  clientId?: string;
  /** Fan one coalesced signal into the host's existing checkpoint-driven refresh path. */
  refresh?: (request: LiveRefreshRequest) => void | Promise<void>;
}

export interface UseLiveChangesResult {
  status: LiveChangesStatus;
  /** The latest server-validated replay checkpoint. Live change ids never advance this value. */
  checkpoint: number | null;
}

interface LiveTarget {
  client: ReturnType<typeof useStashClient>;
  stash: string;
  clientId: string | undefined;
}

interface LiveEntry extends UseLiveChangesResult {
  target: LiveTarget;
}

interface ActiveStream {
  target: LiveTarget;
  stream: StashEventStream;
}

interface ConsumerCursor {
  target: LiveTarget;
  checkpoint: number | null;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function statusForStream(status: StashLiveStatus): LiveChangesStatus {
  if (typeof status !== "string") return "off";
  if (status === "live") return "live";
  if (status === "closed") return "off";
  return "reconnecting";
}

/**
 * Owns one visible-document live subscription. Event frames only schedule advisory refreshes; the
 * host keeps using its existing `since=` change feed to establish authoritative state.
 */
export function useLiveChanges(
  stash: string,
  { enabled, clientId, refresh }: UseLiveChangesOptions,
): UseLiveChangesResult {
  const client = useStashClient();
  const target = useMemo<LiveTarget>(
    () => ({ client, stash, clientId }),
    [client, clientId, stash],
  );
  const [visible, setVisible] = useState(documentIsVisible);
  const [entry, setEntry] = useState<LiveEntry>(() => ({
    target,
    status: enabled && visible ? "reconnecting" : "off",
    checkpoint: null,
  }));
  const current =
    entry.target === target
      ? entry
      : ({
          target,
          status: enabled && visible ? "reconnecting" : "off",
          checkpoint: null,
        } satisfies LiveEntry);
  const currentRef = useRef(current);
  const targetRef = useRef(target);
  const refreshRef = useRef(refresh);
  const activeStreamRef = useRef<ActiveStream | null>(null);
  const pollingTargetRef = useRef<LiveTarget | null>(null);
  const consumerCursorRef = useRef<ConsumerCursor>({ target, checkpoint: null });
  const visibilityRef = useRef(visible);
  const resumedVisibilityRef = useRef(false);

  useLayoutEffect(() => {
    currentRef.current = current;
    targetRef.current = target;
    refreshRef.current = refresh;
  }, [current, refresh, target]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibility = () => {
      const nextVisible = documentIsVisible();
      if (nextVisible === visibilityRef.current) return;
      if (nextVisible) resumedVisibilityRef.current = true;
      else activeStreamRef.current?.stream.close();
      visibilityRef.current = nextVisible;
      setVisible(nextVisible);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    const existing = currentRef.current;
    let checkpoint = existing.target === target ? existing.checkpoint : null;
    const existingCursor = consumerCursorRef.current;
    let consumerCheckpoint = existingCursor.target === target ? existingCursor.checkpoint : null;
    if (existingCursor.target !== target) {
      consumerCursorRef.current = { target, checkpoint: null };
    }
    const commit = (update: Partial<UseLiveChangesResult>) => {
      if (targetRef.current !== target) return;
      setEntry((latest) => {
        const base =
          latest.target === target ? latest : { target, status: "off" as const, checkpoint };
        return { ...base, ...update };
      });
    };

    if (!enabled || !visible) {
      commit({ status: "off", checkpoint });
      return;
    }

    const lifecycle = new AbortController();
    const scheduler = createRefreshScheduler<string>();
    const refreshKey = stash;
    const schedule = (
      reason: LiveRefreshReason,
      path?: string,
      reconciledCheckpoint?: number | null,
    ) => {
      const request: LiveRefreshRequest = {
        reason,
        checkpoint: consumerCheckpoint,
        ...(path === undefined ? {} : { path }),
        signal: lifecycle.signal,
      };
      scheduler.schedule(refreshKey, async () => {
        if (lifecycle.signal.aborted || targetRef.current !== target) return;
        const reconcile = refreshRef.current;
        if (reconcile === undefined) return;
        await reconcile(request);
        if (
          reconciledCheckpoint === undefined ||
          lifecycle.signal.aborted ||
          targetRef.current !== target
        ) {
          return;
        }
        consumerCheckpoint = reconciledCheckpoint;
        consumerCursorRef.current = { target, checkpoint: reconciledCheckpoint };
      });
    };
    const handleFocus = () => schedule("focus");
    if (typeof window !== "undefined") window.addEventListener("focus", handleFocus);

    if (resumedVisibilityRef.current) {
      resumedVisibilityRef.current = false;
      schedule("visibility");
    }

    if (pollingTargetRef.current === target) {
      commit({ status: "polling", checkpoint });
      return () => {
        if (typeof window !== "undefined") window.removeEventListener("focus", handleFocus);
        lifecycle.abort();
        scheduler.close();
      };
    }

    commit({ status: "reconnecting", checkpoint });
    let stream: StashEventStream;
    try {
      stream = client.files(stash).events({
        ...(consumerCheckpoint === null ? {} : { since: consumerCheckpoint }),
        signal: lifecycle.signal,
      });
    } catch {
      pollingTargetRef.current = target;
      commit({ status: "polling", checkpoint });
      return () => {
        if (typeof window !== "undefined") window.removeEventListener("focus", handleFocus);
        lifecycle.abort();
        scheduler.close();
      };
    }

    activeStreamRef.current = { target, stream };
    let awaitingReady = true;
    let bufferedPath: string | undefined;
    let mixedBufferedPaths = false;
    const bufferPath = (path: string) => {
      if (bufferedPath === undefined) bufferedPath = path;
      else if (bufferedPath !== path) mixedBufferedPaths = true;
    };
    const unsubscribeStatus = stream.onStatus((streamStatus) => {
      if (lifecycle.signal.aborted || targetRef.current !== target) return;
      if (stream.failureCount >= 3) {
        commit({ status: "polling", checkpoint });
        return;
      }
      if (streamStatus === "live" && pollingTargetRef.current === target) {
        pollingTargetRef.current = null;
      }
      if (streamStatus === "connecting" || streamStatus === "reconnecting") {
        awaitingReady = true;
      }
      const status =
        streamStatus === "closed" && pollingTargetRef.current === target
          ? "polling"
          : statusForStream(streamStatus);
      commit({ status, checkpoint });
    });

    const consume = async () => {
      for await (const event of stream) {
        if (lifecycle.signal.aborted || targetRef.current !== target) return;
        if (event.type === "ready") {
          checkpoint = event.checkpoint;
          awaitingReady = false;
          commit({ checkpoint });
          schedule("ready", mixedBufferedPaths ? undefined : bufferedPath, event.checkpoint);
          bufferedPath = undefined;
          mixedBufferedPaths = false;
          continue;
        }
        if (event.type === "reconnect") {
          awaitingReady = true;
          bufferedPath = undefined;
          mixedBufferedPaths = false;
          continue;
        }
        if (clientId !== undefined && event.origin === clientId) continue;
        if (awaitingReady) {
          bufferPath(event.path);
          continue;
        }
        schedule(event.type, event.path);
      }
    };
    void consume().catch(() => {
      // The client status channel owns terminal/retry state. Iteration failure cannot bypass it.
    });

    return () => {
      if (typeof window !== "undefined") window.removeEventListener("focus", handleFocus);
      unsubscribeStatus();
      lifecycle.abort();
      scheduler.close();
      stream.close();
      if (activeStreamRef.current?.target === target) activeStreamRef.current = null;
    };
  }, [client, enabled, stash, target, visible]);

  return {
    status: enabled && visible ? current.status : "off",
    checkpoint: current.checkpoint,
  };
}
