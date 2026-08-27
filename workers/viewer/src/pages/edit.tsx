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
  const liveRefreshRef = useRef<EditWorkbenchLiveRefresh | null>(null);
  const registerLiveRefresh = useCallback((refresh: EditWorkbenchLiveRefresh) => {
    liveRefreshRef.current = refresh;
    return () => {
      if (liveRefreshRef.current === refresh) liveRefreshRef.current = null;
    };
  }, []);
  useViewerLiveRefresh(
    useCallback(
      async (batch) => {
        const refresh = liveRefreshRef.current;
        if (refresh === null) return;
        await refresh({
          reconcileCurrentHead:
            path !== undefined && batch.changes.some((change) => change.path === path),
        });
      },
      [path],
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
