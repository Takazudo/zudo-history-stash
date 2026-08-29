import type { CommitSummary } from "@takazudo/zudo-history-stash";
import { CommitList, Input, Notice, useStashHref } from "@takazudo/zudo-history-stash-ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { usePagedData } from "./use-paged-data.js";

const commitKey = (commit: CommitSummary) => commit.id;

function pathFromSearch(searchParams: URLSearchParams): string | undefined {
  const path = searchParams.get("path");
  return path === null || path.length === 0 ? undefined : path;
}

export default function CommitsPage() {
  const { stash } = useParams();
  const { client } = useStashClient();
  const hrefFor = useStashHref();
  const [searchParams, setSearchParams] = useSearchParams();
  const path = pathFromSearch(searchParams);
  const [total, setTotal] = useState(0);
  const commits = usePagedData<CommitSummary, string>(
    async (signal, after) => {
      if (!client || !stash) return { items: [], nextCursor: null };
      const page = await clientValue(
        client
          .withSignal(signal)
          .commits(stash)
          .list({
            ...(path === undefined ? {} : { path }),
            ...(after === null ? {} : { after }),
          }),
      );
      if (!signal.aborted) setTotal(page.total);
      return { items: page.commits, nextCursor: page.nextAfter };
    },
    [client, path, stash],
    commitKey,
  );
  const resetCommits = commits.reset;

  useEffect(() => {
    setTotal(0);
  }, [path, stash]);

  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        await resetCommits(signal);
      },
      [resetCommits],
    ),
  );

  function handlePathChange(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value.length === 0) next.delete("path");
    else next.set("path", value);
    setSearchParams(next, { replace: true });
  }

  if (!stash) {
    return (
      <Page title="Commits" description="Browse atomic history for this stash.">
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      </Page>
    );
  }

  const showList = (!commits.initialLoading && !commits.error) || commits.items.length > 0;

  return (
    <Page
      title="Commits"
      description={`Browse atomic history for ${stash}.`}
      actions={
        <nav aria-label="Stash history" className="page-actions">
          <Link className="zhs-button zhs-button--primary" to={hrefFor({ kind: "commits", stash })}>
            Commits
          </Link>
          <Link
            className="zhs-button zhs-button--secondary"
            to={hrefFor({ kind: "change-sets", stash })}
          >
            Change sets
          </Link>
        </nav>
      }
    >
      <div className="section-stack">
        <section className="section-card" aria-label="Commit filters">
          <div className="section-card__heading">
            <div>
              <h2>Filter commits</h2>
              <p>Match commits that changed one exact path.</p>
            </div>
          </div>
          <div className="zhs-filter-bar">
            <label>
              Path
              <Input
                aria-label="Filter by path"
                value={path ?? ""}
                onChange={(event) => handlePathChange(event.currentTarget.value)}
              />
            </label>
          </div>
        </section>
        {path === undefined ? null : (
          <Notice aria-label="Active commit path filter">
            <span>
              Showing commits that changed <span className="path-cell">{path}</span>.
            </span>
            <Link to={hrefFor({ kind: "commits", stash })}>Clear path filter</Link>
          </Notice>
        )}
        {commits.initialLoading ? <p className="loading-copy">Loading commits…</p> : null}
        {commits.error ? (
          <ErrorBanner
            error={commits.error}
            onRetry={() => void commits.retry().catch(() => undefined)}
            title="Could not load commits"
          />
        ) : null}
        {showList ? (
          <CommitList
            stash={stash}
            page={{
              commits: commits.items,
              nextAfter: commits.hasMore ? "more" : null,
              total,
            }}
            loadingMore={commits.loading}
            onLoadMore={() => commits.loadMore()}
          />
        ) : null}
      </div>
    </Page>
  );
}
