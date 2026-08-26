import { forwardRef, type HTMLAttributes } from "react";
import { classNames } from "./class-names.js";

export type SrOnlyProps = HTMLAttributes<HTMLSpanElement>;

export const SrOnly = forwardRef<HTMLSpanElement, SrOnlyProps>(function SrOnly(
  { className, ...props },
  ref,
) {
  return <span {...props} ref={ref} className={classNames("zhs-sr-only", className)} />;
});
