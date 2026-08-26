import { forwardRef, type ButtonHTMLAttributes } from "react";
import { classNames } from "./class-names.js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "default" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "default", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classNames(
        "zhs-button",
        `zhs-button--${variant}`,
        size === "sm" && "zhs-button--sm",
        className,
      )}
    />
  );
});
