import type { ReactNode, TdHTMLAttributes } from "react";
import { Link } from "react-router-dom";

export interface PathCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  path?: string;
  to?: string;
  children?: ReactNode;
}

export function PathCell({ path, to, children, className = "", ...props }: PathCellProps) {
  const content = children ?? path;
  return (
    <td className={`path-cell list-path-cell${className ? ` ${className}` : ""}`} {...props}>
      {to ? <Link to={to}>{content}</Link> : content}
    </td>
  );
}
