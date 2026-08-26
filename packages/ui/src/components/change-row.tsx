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

export function ChangeRow({ change, showStash = false, Anchor, hrefFor }: ChangeRowProps) {
  const hasDiff = change.kind !== "delete" && change.version > 1;
  return (
    <LinkBridge Anchor={Anchor} hrefFor={hrefFor}>
      {({ Anchor: AnchorComponent, hrefFor: resolveHref }) => (
        <li className="zhs-change-row" data-change-id={change.changeId}>
          <div className="zhs-change-row__summary">
            <KindBadge kind={change.kind} />
            <span className="zhs-change-row__version">v{change.version}</span>
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
