import {
  forwardRef,
  useEffect,
  useRef,
  type DialogHTMLAttributes,
  type SyntheticEvent,
} from "react";
import { classNames } from "./class-names.js";

export interface DialogProps extends Omit<
  DialogHTMLAttributes<HTMLDialogElement>,
  "onCancel" | "onClose" | "open"
> {
  open: boolean;
  onClose: () => void;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog(
  { open, onClose, className, children, ...props },
  forwardedRef,
) {
  const localRef = useRef<HTMLDialogElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  const setRef = (dialog: HTMLDialogElement | null) => {
    localRef.current = dialog;
    if (typeof forwardedRef === "function") forwardedRef(dialog);
    else if (forwardedRef !== null) forwardedRef.current = dialog;
  };

  useEffect(() => {
    const dialog = localRef.current;
    if (dialog === null) return;

    if (open && !wasOpen.current) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      showDialog(dialog);
      wasOpen.current = true;
      return;
    }

    if (!open && wasOpen.current) {
      closeDialog(dialog);
      wasOpen.current = false;
      previousFocus.current?.focus();
      previousFocus.current = null;
    }
  }, [open]);

  useEffect(
    () => () => {
      const dialog = localRef.current;
      if (dialog !== null) closeDialog(dialog);
      previousFocus.current?.focus();
    },
    [],
  );

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  return (
    <dialog
      {...props}
      ref={setRef}
      className={classNames("zhs-dialog", className)}
      onCancel={handleCancel}
    >
      {children}
    </dialog>
  );
});
