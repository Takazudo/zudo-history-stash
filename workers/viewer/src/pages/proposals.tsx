import { Notice, ProposalList } from "@takazudo/zudo-history-stash-ui";
import { useCallback, useRef } from "react";
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
  const refreshRef = useRef<((signal: AbortSignal) => Promise<void>) | null>(null);
  const registerLiveRefresh = useCallback((refresh: (signal: AbortSignal) => Promise<void>) => {
    refreshRef.current = refresh;
    return () => {
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, []);
  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        const refresh = refreshRef.current;
        if (refresh === null) {
          throw new Error(
            `The ${status} proposal list${path === undefined ? "" : ` for ${path}`} in ${stash ?? "the active stash"} is not ready to refresh.`,
          );
        }
        await refresh(signal);
      },
      // Scope the provider listener to the keyed ProposalList consumer lifecycle. Its signal must
      // abort an old filter/path command even when that command's transport ignores cancellation.
      [path, stash, status],
    ),
  );

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
        <ProposalList
          path={path}
          registerLiveRefresh={registerLiveRefresh}
          stash={stash}
          status={status}
        />
      </div>
    </Page>
  );
}
