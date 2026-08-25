import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  compact?: boolean;
}

export function Button({
  variant = "secondary",
  compact = false,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  const classes = `button button--${variant}${compact ? " button--compact" : ""}${className ? ` ${className}` : ""}`;
  return <button className={classes} type={type} {...props} />;
}
