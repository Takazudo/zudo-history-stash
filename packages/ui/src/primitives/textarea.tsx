import { forwardRef, type TextareaHTMLAttributes } from "react";
import { classNames } from "./class-names.js";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea {...props} ref={ref} className={classNames("zhs-textarea", className)} />;
});
