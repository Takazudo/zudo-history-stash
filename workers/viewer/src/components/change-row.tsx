import type { ChangeItem } from "@takazudo/zudo-history-stash";
import { Link } from "react-router-dom";
import { Bytes } from "./bytes.js";
import { KindBadge } from "./kind-badge.js";
import { RelativeTime } from "./relative-time.js";

function filePath(change: ChangeItem): string {
  return `/s/${change.stash}/f/${change.path}`;
}

function diffPath(change: ChangeItem): string | null {
  if (change.kind === "delete" || change.version <= 1) return null;
  return `/s/${change.stash}/diff/${change.path}?from=${change.version - 1}&to=${change.version}`;
}

export function ChangeRow({
  change,
  showStash = false,
}: {
  change: ChangeItem;
  showStash?: boolean;
}) {
  const diff = diffPath(change);
  return (
    <li className="change-row" data-change-id={change.changeId}>
      <div className="change-row__summary">
        <KindBadge kind={change.kind} />
        <span className="change-row__version">v{change.version}</span>
        <RelativeTime value={change.createdAt} />
      </div>
      <div className="change-row__path">
        {showStash ? (
          <>
            <Link className="change-row__stash" to={`/s/${change.stash}`}>
              {change.stash}
            </Link>
            <span aria-hidden="true"> / </span>
          </>
        ) : null}
        <Link className="change-row__file" to={filePath(change)}>
          {change.path}
        </Link>
      </div>
      <div className="change-row__meta">
        <Bytes value={change.size} />
        {change.author ? <span>{change.author}</span> : null}
        {diff ? <Link to={diff}>Diff</Link> : null}
      </div>
      {change.message ? <p className="change-row__message">{change.message}</p> : null}
    </li>
  );
}
