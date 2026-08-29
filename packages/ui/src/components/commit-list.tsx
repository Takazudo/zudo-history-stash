import type { CommitListResponse, CommitSummary } from "@takazudo/zudo-history-stash";
import { Anchor, useStashHref } from "../provider/hooks.js";
import { LoadMore } from "./load-more.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

export interface CommitListProps {
  stash: string;
  page: CommitListResponse;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Optional paths keyed by commit id. Summaries intentionally contain no full entry array. */
  pathsByCommit?: Readonly<Record<string, readonly string[]>>;
}

function CommitItem({
  stash,
  commit,
  paths,
}: {
  stash: string;
  commit: CommitSummary;
  paths: readonly string[];
}) {
  const hrefFor = useStashHref();
  const shownPaths = paths.slice(0, 3);
  return (
    <li className="zhs-record-list__item" data-commit-id={commit.id}>
      <div className="zhs-record-list__heading">
        <Anchor href={hrefFor({ kind: "commit", stash, id: commit.id })}>
          {commit.message || "Untitled commit"}
        </Anchor>
        <span className="zhs-source-badge">{commit.source}</span>
      </div>
      <div className="zhs-record-list__meta">
        <span>{commit.author || commit.createdBy || "Unknown author"}</span>
        <RelativeTime value={commit.createdAt} />
        <span>
          {commit.entryCount} {commit.entryCount === 1 ? "entry" : "entries"}
        </span>
      </div>
      {shownPaths.length > 0 ? (
        <ul className="zhs-record-list__paths" aria-label="First changed paths">
          {shownPaths.map((path) => (
            <li key={path}>
              <PathText value={path} />
            </li>
          ))}
        </ul>
      ) : null}
      {commit.revertsCommitId ? (
        <p className="zhs-record-list__relation">
          Reverts{" "}
          <Anchor href={hrefFor({ kind: "commit", stash, id: commit.revertsCommitId })}>
            {commit.revertsCommitId}
          </Anchor>
        </p>
      ) : null}
    </li>
  );
}

function embeddedPaths(commit: CommitSummary): readonly string[] {
  const value = commit as CommitSummary & { entries?: unknown };
  if (!Array.isArray(value.entries)) return [];
  return value.entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("path" in entry)) return [];
    return typeof entry.path === "string" ? [entry.path] : [];
  });
}

export function CommitList({
  stash,
  page,
  loadingMore = false,
  onLoadMore,
  pathsByCommit = {},
}: CommitListProps) {
  return (
    <section className="zhs-section-card zhs-record-list" aria-labelledby="commit-list-title">
      <div className="zhs-section-card__heading">
        <h2 id="commit-list-title">Commits</h2>
        <p>{page.total} total</p>
      </div>
      {page.commits.length === 0 ? (
        <p className="zhs-record-list__empty">No commits found.</p>
      ) : (
        <ol className="zhs-record-list__items">
          {page.commits.map((commit) => (
            <CommitItem
              key={commit.id}
              stash={stash}
              commit={commit}
              paths={pathsByCommit[commit.id] ?? embeddedPaths(commit)}
            />
          ))}
        </ol>
      )}
      {onLoadMore ? (
        <div className="zhs-section-card__footer">
          <LoadMore
            hasMore={page.nextAfter !== null}
            loading={loadingMore}
            onLoadMore={onLoadMore}
          />
        </div>
      ) : null}
    </section>
  );
}
