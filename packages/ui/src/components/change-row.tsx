import type { ChangeItem } from "@takazudo/zudo-history-stash";
import { Bytes } from "./bytes.js";
import { KindBadge } from "./kind-badge.js";
import { LinkBridge, type LinkBridgeOverrides } from "./link-bridge.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

export interface ChangeRowProps extends LinkBridgeOverrides {
  change: ChangeItem;
  showStash?: boolean;
}

export interface ChangesListProps extends LinkBridgeOverrides {
  changes: readonly ChangeItem[];
  showStash?: boolean;
}

export function ChangeRow({ change, showStash = false, Anchor, hrefFor }: ChangeRowProps) {
  const hasDiff = change.kind !== "delete" && change.version > 1;
  return (
    <LinkBridge Anchor={Anchor} hrefFor={hrefFor}>
      {({ Anchor: AnchorComponent, hrefFor: resolveHref }) => (
        <li className="zhs-change-row" data-change-id={change.changeId}>
          <div className="zhs-change-row__summary">
            <KindBadge kind={change.kind} />
            <span className="zhs-change-row__version">v{change.version}</span>
            <AnchorComponent
              className="zhs-commit-badge"
              href={resolveHref({ kind: "commit", stash: change.stash, id: change.commitId })}
            >
              Commit {change.commitId}
            </AnchorComponent>
            <RelativeTime value={change.createdAt} />
          </div>
          <div className="zhs-change-row__path">
            {showStash ? (
              <>
                <AnchorComponent
                  className="zhs-change-row__stash"
                  href={resolveHref({ kind: "stash", stash: change.stash })}
                >
                  {change.stash}
                </AnchorComponent>
                <span aria-hidden="true"> / </span>
              </>
            ) : null}
            <AnchorComponent
              className="zhs-change-row__file"
              href={resolveHref({ kind: "file", stash: change.stash, path: change.path })}
            >
              <PathText value={change.path} />
            </AnchorComponent>
          </div>
          <div className="zhs-change-row__meta">
            <Bytes value={change.size} />
            {change.author ? <span>{change.author}</span> : null}
            {hasDiff ? (
              <AnchorComponent
                href={resolveHref({
                  kind: "diff",
                  stash: change.stash,
                  path: change.path,
                  from: change.version - 1,
                  to: change.version,
                })}
              >
                Diff
              </AnchorComponent>
            ) : null}
          </div>
          {change.message ? <p className="zhs-change-row__message">{change.message}</p> : null}
        </li>
      )}
    </LinkBridge>
  );
}

function consecutiveGroups(changes: readonly ChangeItem[]): ChangeItem[][] {
  const groups: ChangeItem[][] = [];
  for (const change of changes) {
    const current = groups.at(-1);
    if (current?.[0]?.commitId === change.commitId) current.push(change);
    else groups.push([change]);
  }
  return groups;
}

/** Renders an ordered changes feed and folds only adjacent entries from the same atomic commit. */
export function ChangesList({ changes, showStash = false, Anchor, hrefFor }: ChangesListProps) {
  return (
    <ul className="zhs-changes-list">
      {consecutiveGroups(changes).map((group) => {
        const first = group[0];
        if (!first) return null;
        if (group.length === 1) {
          return (
            <ChangeRow
              key={first.changeId}
              change={first}
              showStash={showStash}
              Anchor={Anchor}
              hrefFor={hrefFor}
            />
          );
        }
        return (
          <li
            key={`${first.commitId}:${first.changeId}`}
            className="zhs-change-group"
            data-commit-id={first.commitId}
          >
            <details open>
              <summary>
                {group.length} changes in commit {first.commitId}
              </summary>
              <ul className="zhs-change-group__children">
                {group.map((change) => (
                  <ChangeRow
                    key={change.changeId}
                    change={change}
                    showStash={showStash}
                    Anchor={Anchor}
                    hrefFor={hrefFor}
                  />
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
