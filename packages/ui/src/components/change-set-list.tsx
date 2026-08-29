import type { ChangeSetListResponse, ChangeSetStatus } from "@takazudo/zudo-history-stash";
import { Anchor, useStashHref } from "../provider/hooks.js";
import { Input } from "../primitives/input.js";
import { Select } from "../primitives/select.js";
import { LoadMore } from "./load-more.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

export type ChangeSetStatusFilter = ChangeSetStatus | "all";
export interface ChangeSetListProps {
  stash: string;
  page: ChangeSetListResponse;
  status: ChangeSetStatusFilter;
  path: string;
  onStatusChange: (status: ChangeSetStatusFilter) => void;
  onPathChange: (path: string) => void;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function ChangeSetList({
  stash,
  page,
  status,
  path,
  onStatusChange,
  onPathChange,
  loadingMore = false,
  onLoadMore,
}: ChangeSetListProps) {
  const hrefFor = useStashHref();
  return (
    <section className="zhs-section-card zhs-record-list" aria-labelledby="change-set-list-title">
      <div className="zhs-section-card__heading">
        <h2 id="change-set-list-title">Change sets</h2>
        <p>{page.total} total</p>
      </div>
      <div className="zhs-filter-bar">
        <label>
          Status
          <Select
            aria-label="Change set status"
            value={status}
            onChange={(event) => onStatusChange(event.currentTarget.value as ChangeSetStatusFilter)}
          >
            <option value="open">Open</option>
            <option value="applied">Applied</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
            <option value="all">All</option>
          </Select>
        </label>
        <label>
          Path
          <Input
            aria-label="Filter by path"
            value={path}
            onChange={(event) => onPathChange(event.currentTarget.value)}
          />
        </label>
      </div>
      {page.changeSets.length === 0 ? (
        <p className="zhs-record-list__empty">No change sets found.</p>
      ) : (
        <ol className="zhs-record-list__items">
          {page.changeSets.map((changeSet) => (
            <li
              className="zhs-record-list__item"
              key={changeSet.id}
              data-change-set-id={changeSet.id}
            >
              <div className="zhs-record-list__heading">
                <Anchor href={hrefFor({ kind: "change-set", stash, id: changeSet.id })}>
                  {changeSet.message || "Untitled change set"}
                </Anchor>
                <span className={`zhs-status-badge zhs-status-badge--${changeSet.status}`}>
                  {changeSet.status}
                </span>
              </div>
              <div className="zhs-record-list__meta">
                <span>{changeSet.author || changeSet.createdBy || "Unknown author"}</span>
                <RelativeTime value={changeSet.createdAt} />
                <span>
                  {changeSet.entries.length} {changeSet.entries.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <ul className="zhs-record-list__paths">
                {changeSet.entries.slice(0, 3).map((entry) => (
                  <li key={entry.path}>
                    <PathText value={entry.path} />
                    {entry.stale ? <span className="zhs-stale-badge">stale</span> : null}
                  </li>
                ))}
              </ul>
            </li>
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
