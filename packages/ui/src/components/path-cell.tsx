import type { ReactNode, TdHTMLAttributes } from "react";
import type { StashUiRoute } from "../provider/types.js";
import { TableCell } from "../primitives/table.js";
import { classNames } from "../primitives/class-names.js";
import { LinkBridge, type LinkBridgeOverrides } from "./link-bridge.js";
import { PathText } from "./path-text.js";

export interface PathCellProps extends TdHTMLAttributes<HTMLTableCellElement>, LinkBridgeOverrides {
  path?: string;
  route?: StashUiRoute;
  children?: ReactNode;
}

export function PathCell({
  path,
  route,
  children,
  className,
  Anchor,
  hrefFor,
  ...props
}: PathCellProps) {
  const content = children ?? (path === undefined ? null : <PathText value={path} />);
  const cellClassName = classNames("zhs-path-cell", className);

  if (route === undefined) {
    return (
      <TableCell className={cellClassName} {...props}>
        {content}
      </TableCell>
    );
  }

  return (
    <LinkBridge Anchor={Anchor} hrefFor={hrefFor}>
      {({ Anchor: AnchorComponent, hrefFor: resolveHref }) => (
        <TableCell className={cellClassName} {...props}>
          <AnchorComponent href={resolveHref(route)}>{content}</AnchorComponent>
        </TableCell>
      )}
    </LinkBridge>
  );
}
