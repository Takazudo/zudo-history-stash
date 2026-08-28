import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  EditWorkbench,
  ErrorBanner,
  useStashHref,
  type EditWorkbenchLiveRefresh,
  type EditWorkbenchSaved,
} from "@takazudo/zudo-history-stash-ui";
import type { ProposalRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useRef } from "react";
import { proposalCreatedLocationState } from "../app/proposal-routes.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";

interface RegisteredEditRefresh {
  controller: AbortController;
  refresh: EditWorkbenchLiveRefresh;
}

type EditRefreshWaiter = (entry: RegisteredEditRefresh) => void;

function abortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new DOMException("The edit live refresh was aborted", "AbortError");
}

function settleWithSignal(task: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    signal.addEventListener("abort", handleAbort, { once: true });
    task.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function positiveVersion(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export default function EditPage() {
  const { stash, "*": path } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const hrefFor = useStashHref();
  const initialSource = positiveVersion(searchParams.get("from"));
  const liveRefreshRef = useRef<RegisteredEditRefresh | null>(null);
  const liveRefreshWaitersRef = useRef(new Set<EditRefreshWaiter>());
  const registerLiveRefresh = useCallback((refresh: EditWorkbenchLiveRefresh) => {
    liveRefreshRef.current?.controller.abort();
    const entry: RegisteredEditRefresh = { controller: new AbortController(), refresh };
    liveRefreshRef.current = entry;
    for (const notify of [...liveRefreshWaitersRef.current]) notify(entry);
    return () => {
      entry.controller.abort();
      if (liveRefreshRef.current === entry) liveRefreshRef.current = null;
    };
  }, []);
  const waitForLiveRefresh = useCallback((signal: AbortSignal): Promise<RegisteredEditRefresh> => {
    const current = liveRefreshRef.current;
    if (current !== null && !current.controller.signal.aborted) return Promise.resolve(current);
    signal.throwIfAborted();
    return new Promise<RegisteredEditRefresh>((resolve, reject) => {
      const cleanup = () => {
        liveRefreshWaitersRef.current.delete(handleReady);
        signal.removeEventListener("abort", handleAbort);
      };
      const handleReady: EditRefreshWaiter = (entry) => {
        cleanup();
        resolve(entry);
      };
      const handleAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      liveRefreshWaitersRef.current.add(handleReady);
      signal.addEventListener("abort", handleAbort, { once: true });
    });
  }, []);
  useViewerLiveRefresh(
    useCallback(
      async (batch) => {
        const entry = await waitForLiveRefresh(batch.signal);
        const signal = AbortSignal.any([batch.signal, entry.controller.signal]);
        await settleWithSignal(
          entry.refresh({
            reconcileCurrentHead:
              path !== undefined && batch.changes.some((change) => change.path === path),
            signal,
          }),
          signal,
        );
      },
      [path, waitForLiveRefresh],
    ),
  );

  if (!stash || !path) {
    return (
      <Page title="Edit file">
        <ErrorBanner error={new Error("The stash name or file path is missing from this URL.")} />
      </Page>
    );
  }

  if (initialSource === null) {
    return (
      <Page title={`Edit: ${path}`}>
        <ErrorBanner error={new Error("The from query must be a positive integer.")} />
      </Page>
    );
  }

  function handleSaved({ completion, record }: EditWorkbenchSaved): void {
    if (!stash) return;
    const flash =
      completion.state === "saved"
        ? `Saved v${record.version}.`
        : `No write was needed; the file already matches v${record.version}.`;
    navigate(hrefFor({ kind: "file", stash, path: record.path }), {
      state: { flash },
    });
  }

  function handleProposed(record: ProposalRecord): void {
    if (!stash) return;
    navigate(hrefFor({ kind: "proposal", stash, id: record.id }), {
      state: proposalCreatedLocationState(),
    });
  }

  return (
    <EditWorkbench
      initialSource={initialSource}
      path={path}
      registerLiveRefresh={registerLiveRefresh}
      stash={stash}
      onProposed={handleProposed}
      onSaved={handleSaved}
    />
  );
}
