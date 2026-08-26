import {
  PathCell as RelocatedPathCell,
  type PathCellProps as RelocatedPathCellProps,
} from "../../../../packages/ui/src/components/relocated.js";
import { ViewerAnchor } from "./relocated-link-bridge.js";

export interface PathCellProps extends Omit<
  RelocatedPathCellProps,
  "Anchor" | "hrefFor" | "route"
> {
  to?: string;
}

const VIEWER_PASSTHROUGH_ROUTE = { kind: "home" } as const;

/** Adapt the old `to` prop until #99 switches Viewer call sites to package routes. */
export function PathCell({ to, className, ...props }: PathCellProps) {
  const classes = `list-path-cell${className ? ` ${className}` : ""}`;
  if (!to) return <RelocatedPathCell {...props} className={classes} />;

  return (
    <RelocatedPathCell
      {...props}
      Anchor={ViewerAnchor}
      className={classes}
      hrefFor={() => to}
      route={VIEWER_PASSTHROUGH_ROUTE}
    />
  );
}
