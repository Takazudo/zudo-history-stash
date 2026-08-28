import type { ApproveProposalResult, Current, ProposalRecord } from "@takazudo/zudo-history-stash";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useCanWrite, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Notice } from "../primitives/notice.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";

export interface ApproveProposalDialogProps {
  open: boolean;
  stash: string;
  proposal: ProposalRecord;
  onClose: () => void;
  onApproved: (result: ApproveProposalResult) => void;
  onStale: (current: Current) => void;
  onExpired: () => void;
  onClosed: () => void;
}

function approvalConsequence(baseVersion: number | null): string {
  return baseVersion === null
    ? "Applies as v1 to a new file · a normal put version linked to this proposal"
    : `Applies as v${baseVersion + 1} on top of v${baseVersion} · a normal put version linked to this proposal`;
}

function ApproveProposalDialogOpen({
  stash,
  proposal,
  onClose,
  onApproved,
  onStale,
  onExpired,
  onClosed,
}: Omit<ApproveProposalDialogProps, "open">) {
  const titleId = useId();
  const descriptionId = useId();
  const clientForSignal = useStashClientForSignal();
  const pendingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<unknown | null>(null);

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

  async function approve(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    const lifecycle = lifecycleRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => lifecycleRef.current === lifecycle && !controller.signal.aborted;

    try {
      const result = await clientForSignal(controller.signal).proposals(stash).approve(proposal.id);
      if (!isCurrent()) return;
      if (result.ok) {
        onApproved(result.value);
      } else if (result.error.code === "stale" && result.current !== undefined) {
        onStale(result.current);
      } else if (result.error.code === "proposal-expired") {
        onExpired();
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
      className="zhs-proposal-dialog zhs-approve-proposal-dialog"
      open={true}
      onClose={requestClose}
    >
      <form
        aria-busy={submitting ? "true" : undefined}
        className="zhs-proposal-dialog__form"
        onSubmit={(event) => void approve(event)}
      >
        <header className="zhs-proposal-dialog__header">
          <div>
            <p className="zhs-proposal-dialog__eyebrow">Fenced approval</p>
            <h2 id={titleId}>
              Approve{" "}
              <span className="zhs-proposal-dialog__path">
                <PathText value={proposal.path} />
              </span>
            </h2>
          </div>
          <Button
            aria-label="Close approve proposal dialog"
            disabled={submitting}
            size="sm"
            onClick={requestClose}
          >
            Close
          </Button>
        </header>

        <div className="zhs-proposal-dialog__body">
          <Notice variant="warning">
            <strong id={descriptionId}>{approvalConsequence(proposal.baseVersion)}</strong>
            <p>The head is checked again at approval time. This proposal is never rebased.</p>
          </Notice>

          {failure !== null ? (
            <ErrorBanner
              error={failure}
              onRetry={() => void approve()}
              title="Could not approve this proposal"
            />
          ) : null}
        </div>

        <footer className="zhs-proposal-dialog__actions">
          <Button disabled={submitting} onClick={requestClose}>
            Cancel
          </Button>
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting ? "Approving…" : "Approve proposal"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

export function ApproveProposalDialog(props: ApproveProposalDialogProps) {
  const capability = useCanWrite(props.stash);
  if (!props.open || !capability.ready || !capability.canWrite) return null;
  return (
    <ApproveProposalDialogOpen key={JSON.stringify([props.stash, props.proposal.id])} {...props} />
  );
}
