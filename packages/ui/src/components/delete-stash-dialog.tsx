import type { DeleteStashResult } from "@takazudo/zudo-history-stash";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Notice } from "../primitives/notice.js";
import { useIsAdmin, useStashClientForSignal } from "../provider/hooks.js";
import { ErrorBanner } from "./error-banner.js";

export interface DeleteStashDialogProps {
  open: boolean;
  stash: string;
  onClose: () => void;
  onDeleted: (result: DeleteStashResult) => void;
}

type DeleteStatus =
  | { state: "idle" }
  | { state: "error"; error: unknown }
  | { state: "deleted"; result: DeleteStashResult };

export function DeleteStashDialog({ open, stash, onClose, onDeleted }: DeleteStashDialogProps) {
  const { ready, isAdmin } = useIsAdmin();
  const clientForSignal = useStashClientForSignal();
  const titleId = useId();
  const descriptionId = useId();
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const submittingRef = useRef(false);
  const completionReportedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<DeleteStatus>({ state: "idle" });

  useEffect(() => {
    if (open && ready && isAdmin) return;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    if (!open) {
      completionReportedRef.current = false;
      setStatus({ state: "idle" });
    }
  }, [isAdmin, open, ready]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      submittingRef.current = false;
    },
    [],
  );

  async function handleDelete() {
    if (!open || !ready || !isAdmin || submittingRef.current || status.state === "deleted") return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    setStatus({ state: "idle" });

    try {
      const result = await clientForSignal(controller.signal).stashes.delete(stash);
      if (controller.signal.aborted || generationRef.current !== generation) return;
      if (!result.ok) {
        setStatus({ state: "error", error: result });
        return;
      }
      setStatus({ state: "deleted", result: result.value });
    } catch (error: unknown) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setStatus({ state: "error", error });
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) {
        submittingRef.current = false;
        setSubmitting(false);
        controllerRef.current = null;
      }
    }
  }

  function handleClose() {
    if (submittingRef.current) return;
    if (status.state === "deleted" && !completionReportedRef.current) {
      completionReportedRef.current = true;
      onDeleted(status.result);
    }
    onClose();
  }

  if (!ready || !isAdmin) return null;

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-delete-stash-dialog"
      open={open}
      onClose={handleClose}
    >
      <div className="zhs-delete-stash-dialog__content" aria-busy={submitting || undefined}>
        <header className="zhs-delete-stash-dialog__header">
          <div>
            <p className="zhs-delete-stash-dialog__eyebrow">Stash lifecycle</p>
            <h2 className="zhs-delete-stash-dialog__title" id={titleId}>
              Delete <code>{stash}</code>
            </h2>
          </div>
          <Button disabled={submitting} size="sm" onClick={handleClose}>
            Close
          </Button>
        </header>

        <div className="zhs-delete-stash-dialog__body" id={descriptionId}>
          {status.state === "deleted" ? (
            <Notice variant="success">
              <strong>Stash deleted and hidden.</strong>
              <p>
                Restore is available until{" "}
                <time dateTime={status.result.restoreUntil}>{status.result.restoreUntil}</time>.
              </p>
              <p>
                All {status.result.revokedTokens} former tokens remain revoked and cannot be reused
                after restore. Create new tokens after restoring.
              </p>
              <p>The stash name and complete history remain stored.</p>
            </Notice>
          ) : (
            <Notice variant="warning">
              <strong>This hides the stash from normal routes and feeds.</strong>
              <p>All current tokens will be revoked and cannot be reused after a restore.</p>
              <p>The stash name and complete file history remain stored.</p>
              <p>The server will return the exact restore deadline after deletion.</p>
            </Notice>
          )}

          {status.state === "error" ? (
            <ErrorBanner error={status.error} title="Could not delete this stash" />
          ) : null}
        </div>

        <footer className="zhs-delete-stash-dialog__actions">
          <Button disabled={submitting} onClick={handleClose}>
            {status.state === "deleted" ? "Done" : "Cancel"}
          </Button>
          {status.state !== "deleted" ? (
            <Button disabled={submitting} variant="danger" onClick={() => void handleDelete()}>
              {submitting ? "Deleting…" : "Delete stash"}
            </Button>
          ) : null}
        </footer>
      </div>
    </Dialog>
  );
}
