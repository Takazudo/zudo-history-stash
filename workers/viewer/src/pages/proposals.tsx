import { Notice, ProposalList } from "@takazudo/zudo-history-stash-ui";
import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { proposalListHref, proposalListStatusFrom } from "../app/proposal-routes.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner } from "../components/error-banner.js";

export default function ProposalsPage() {
  const { stash } = useParams();
  const [searchParams] = useSearchParams();
  const status = proposalListStatusFrom(searchParams);
  const pathParam = searchParams.get("path");
  const path = pathParam === null || pathParam.length === 0 ? undefined : pathParam;
  const [refreshRevision, setRefreshRevision] = useState(0);
  useViewerLiveRefresh(useCallback(() => setRefreshRevision((revision) => revision + 1), []));

  if (!stash) {
    return (
      <Page title="Proposals">
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      </Page>
    );
  }

  return (
    <Page
      title="Proposals"
      description="Review stored candidate writes without changing the current head."
      actions={
        <nav aria-label="Proposal status filter" className="page-actions">
          <Link
            aria-current={status === "open" ? "page" : undefined}
            className={`zhs-button zhs-button--${status === "open" ? "primary" : "secondary"}`}
            to={proposalListHref(stash, { path })}
          >
            Open
          </Link>
          <Link
            aria-current={status === "all" ? "page" : undefined}
            className={`zhs-button zhs-button--${status === "all" ? "primary" : "secondary"}`}
            to={proposalListHref(stash, { status: "all", path })}
          >
            All
          </Link>
        </nav>
      }
    >
      <div className="section-stack">
        {path === undefined ? null : (
          <Notice aria-label="Active proposal path filter">
            <span>
              Showing proposals for <span className="path-cell">{path}</span>.
            </span>
            <Link to={proposalListHref(stash, { status })}>Clear path filter</Link>
          </Notice>
        )}
        <ProposalList path={path} refreshRevision={refreshRevision} stash={stash} status={status} />
      </div>
    </Page>
  );
}
