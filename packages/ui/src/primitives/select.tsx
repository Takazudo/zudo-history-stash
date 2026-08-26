import { forwardRef, type SelectHTMLAttributes } from "react";
import { classNames } from "./class-names.js";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, ...props },
  ref,
) {
  return <select {...props} ref={ref} className={classNames("zhs-select", className)} />;
});
