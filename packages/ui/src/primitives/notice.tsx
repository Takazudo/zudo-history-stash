import { forwardRef, type HTMLAttributes } from "react";
import { classNames } from "./class-names.js";

export type NoticeVariant = "info" | "warning" | "error" | "success";

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: NoticeVariant;
}

export const Notice = forwardRef<HTMLDivElement, NoticeProps>(function Notice(
  { variant = "info", className, role, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      role={role ?? (variant === "error" ? "alert" : "status")}
      className={classNames("zhs-notice", `zhs-notice--${variant}`, className)}
    />
  );
});
