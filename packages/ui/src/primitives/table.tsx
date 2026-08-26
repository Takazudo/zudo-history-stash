import {
  forwardRef,
  type HTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { classNames } from "./class-names.js";

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(
  function Table({ className, ...props }, ref) {
    return <table {...props} ref={ref} className={classNames("zhs-table", className)} />;
  },
);

export const TableHead = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHead({ className, ...props }, ref) {
  return <thead {...props} ref={ref} className={classNames("zhs-table__head", className)} />;
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody {...props} ref={ref} className={classNames("zhs-table__body", className)} />;
});

export const TableFoot = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableFoot({ className, ...props }, ref) {
  return <tfoot {...props} ref={ref} className={classNames("zhs-table__foot", className)} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return <tr {...props} ref={ref} className={classNames("zhs-table__row", className)} />;
  },
);

export const TableHeader = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  function TableHeader({ className, ...props }, ref) {
    return <th {...props} ref={ref} className={classNames("zhs-table__header", className)} />;
  },
);

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  function TableCell({ className, ...props }, ref) {
    return <td {...props} ref={ref} className={classNames("zhs-table__cell", className)} />;
  },
);

export const TableCaption = forwardRef<
  HTMLTableCaptionElement,
  HTMLAttributes<HTMLTableCaptionElement>
>(function TableCaption({ className, ...props }, ref) {
  return <caption {...props} ref={ref} className={classNames("zhs-table__caption", className)} />;
});
