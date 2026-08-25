import type { HTMLAttributes, ReactNode, TdHTMLAttributes } from "react";

export function Table({ children, className = "", ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-scroll">
      <table className={`table${className ? ` ${className}` : ""}`} {...props}>
        {children}
      </table>
    </div>
  );
}

export function PathCell({
  children,
  className = "",
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`path-cell${className ? ` ${className}` : ""}`} {...props}>
      {children as ReactNode}
    </td>
  );
}
