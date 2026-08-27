import type { ProposalRecord } from "@takazudo/zudo-history-stash";
import { utf8ByteLength } from "@takazudo/zudo-history-stash-core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useCanWrite, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Textarea } from "../primitives/textarea.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";

const MAX_REASON_BYTES = 2_000;

export interface RejectProposalDialogProps {
  open: boolean;
  stash: string;
  proposal: ProposalRecord;
  onClose: () => void;
  onRejected: (record: ProposalRecord) => void;
  onClosed: () => void;
}

function fitUtf8Bytes(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value;
  let fitted = "";
  for (const character of value) {
    if (utf8ByteLength(fitted + character) > maximum) break;
    fitted += character;
  }
  return fitted;
}

function RejectProposalDialogOpen({
  stash,
  proposal,
  onClose,
  onRejected,
  onClosed,
}: Omit<RejectProposalDialogProps, "open">) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const reasonCountId = useId();
  const clientForSignal = useStashClientForSignal();
  const pendingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<unknown | null>(null);
  const reasonBytes = utf8ByteLength(reason);

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
      pendingRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  function requestClose() {
    if (pendingRef.current) return;
    onClose();
  }

  async function reject(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pendingRef.current || reasonBytes > MAX_REASON_BYTES) return;
    pendingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    const lifecycle = lifecycleRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => lifecycleRef.current === lifecycle && !controller.signal.aborted;

    try {
      const result = await clientForSignal(controller.signal)
        .proposals(stash)
        .reject(proposal.id, reason.length === 0 ? {} : { reason });
      if (!isCurrent()) return;
      if (result.ok) {
        onRejected(result.value);
      } else if (result.error.code === "proposal-closed") {
        onClosed();
      } else {
        setFailure(result);
      }
    } catch (error: unknown) {
      if (isCurrent()) setFailure(error);
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setSubmitting(false);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-proposal-dialog zhs-reject-proposal-dialog"
      open={true}
      onClose={requestClose}
    >
      <form
        aria-busy={submitting ? "true" : undefined}
        className="zhs-proposal-dialog__form"
        onSubmit={(event) => void reject(event)}
      >
        <header className="zhs-proposal-dialog__header">
          <div>
            <p className="zhs-proposal-dialog__eyebrow">Close proposal</p>
            <h2 id={titleId}>
              Reject{" "}
              <span className="zhs-proposal-dialog__path">
                <PathText value={proposal.path} />
              </span>
            </h2>
          </div>
          <Button
            aria-label="Close reject proposal dialog"
            disabled={submitting}
            size="sm"
            onClick={requestClose}
          >
            Close
          </Button>
        </header>

        <div className="zhs-proposal-dialog__body">
          <p className="zhs-proposal-dialog__description" id={descriptionId}>
            Rejection closes this proposal without changing the file head.
          </p>
          <div className="zhs-proposal-dialog__field">
            <label htmlFor={reasonId}>Reason (optional)</label>
            <Textarea
              aria-describedby={reasonCountId}
              disabled={submitting}
              id={reasonId}
              rows={4}
              value={reason}
              onChange={(event) =>
                setReason(fitUtf8Bytes(event.currentTarget.value, MAX_REASON_BYTES))
              }
            />
            <span className="zhs-proposal-dialog__byte-count" id={reasonCountId}>
              {reasonBytes} / {MAX_REASON_BYTES} UTF-8 bytes
            </span>
          </div>

          {failure !== null ? (
            <ErrorBanner
              error={failure}
              onRetry={() => void reject()}
              title="Could not reject this proposal"
            />
          ) : null}
        </div>

        <footer className="zhs-proposal-dialog__actions">
          <Button disabled={submitting} onClick={requestClose}>
            Cancel
          </Button>
          <Button disabled={submitting} type="submit" variant="danger">
            {submitting ? "Rejecting…" : "Reject proposal"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

export function RejectProposalDialog(props: RejectProposalDialogProps) {
  const capability = useCanWrite(props.stash);
  if (!props.open || !capability.ready || !capability.canWrite) return null;
  return (
    <RejectProposalDialogOpen key={JSON.stringify([props.stash, props.proposal.id])} {...props} />
  );
}
