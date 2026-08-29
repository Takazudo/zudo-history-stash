import type { ChangeSetRecord } from "@takazudo/zudo-history-stash";
import {
  ChangeSetList,
  type ChangeSetStatusFilter,
  useStashHref,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { usePagedData } from "./use-paged-data.js";

const changeSetKey = (changeSet: ChangeSetRecord) => changeSet.id;
const changeSetStatuses: readonly ChangeSetStatusFilter[] = [
  "open",
  "applied",
  "rejected",
  "expired",
  "all",
];

function statusFromSearch(searchParams: URLSearchParams): ChangeSetStatusFilter {
  const status = searchParams.get("status");
  return changeSetStatuses.includes(status as ChangeSetStatusFilter)
    ? (status as ChangeSetStatusFilter)
    : "open";
}

function pathFromSearch(searchParams: URLSearchParams): string {
  const path = searchParams.get("path");
  return path ?? "";
}

export default function ChangeSetsPage() {
  const { stash } = useParams();
  const { client } = useStashClient();
  const hrefFor = useStashHref();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = statusFromSearch(searchParams);
  const path = pathFromSearch(searchParams);
  const [total, setTotal] = useState(0);
  const changeSets = usePagedData<ChangeSetRecord, string>(
    async (signal, after) => {
      if (!client || !stash) return { items: [], nextCursor: null };
      const page = await clientValue(
        client
          .withSignal(signal)
          .changeSets(stash)
          .list({
            status,
            ...(path.length === 0 ? {} : { path }),
            ...(after === null ? {} : { after }),
          }),
      );
      if (!signal.aborted) setTotal(page.total);
      return { items: page.changeSets, nextCursor: page.nextAfter };
    },
    [client, path, stash, status],
    changeSetKey,
  );
  const resetChangeSets = changeSets.reset;

  useEffect(() => setTotal(0), [path, stash, status]);

  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        await resetChangeSets(signal);
      },
      [resetChangeSets],
    ),
  );

  function updateSearch(nextStatus: ChangeSetStatusFilter, nextPath: string) {
    const next = new URLSearchParams(searchParams);
    if (nextStatus === "open") next.delete("status");
    else next.set("status", nextStatus);
    if (nextPath.length === 0) next.delete("path");
    else next.set("path", nextPath);
    setSearchParams(next, { replace: true });
  }

  if (!stash) {
    return (
      <Page title="Change sets" description="Review staged changes for this stash.">
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      </Page>
    );
  }

  const showList = (!changeSets.initialLoading && !changeSets.error) || changeSets.items.length > 0;

  return (
    <Page
      title="Change sets"
      description={`Review staged changes for ${stash}.`}
      actions={
        <nav aria-label="Stash history" className="page-actions">
          <Link
            className="zhs-button zhs-button--secondary"
            to={hrefFor({ kind: "commits", stash })}
          >
            Commits
          </Link>
          <Link
            className="zhs-button zhs-button--primary"
            to={hrefFor({ kind: "change-sets", stash })}
          >
            Change sets
          </Link>
        </nav>
      }
    >
      <div className="section-stack">
        {changeSets.initialLoading ? <p className="loading-copy">Loading change sets…</p> : null}
        {changeSets.error ? (
          <ErrorBanner
            error={changeSets.error}
            onRetry={() => void changeSets.retry().catch(() => undefined)}
            title="Could not load change sets"
          />
        ) : null}
        {showList ? (
          <ChangeSetList
            stash={stash}
            page={{
              changeSets: changeSets.items,
              nextAfter: changeSets.hasMore ? "more" : null,
              total,
            }}
            status={status}
            path={path}
            onStatusChange={(nextStatus) => updateSearch(nextStatus, path)}
            onPathChange={(nextPath) => updateSearch(status, nextPath)}
            loadingMore={changeSets.loading}
            onLoadMore={() => changeSets.loadMore()}
          />
        ) : null}
      </div>
    </Page>
  );
}
