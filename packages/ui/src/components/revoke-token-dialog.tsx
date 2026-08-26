import type { TokenRecord } from "@takazudo/zudo-history-stash";
import { useId, useRef, useState } from "react";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { ErrorBanner } from "./error-banner.js";

export interface RevokeTokenDialogProps {
  open: boolean;
  token: TokenRecord;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function RevokeTokenDialog({ open, token, onClose, onConfirm }: RevokeTokenDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const submittingRef = useRef(false);

  async function handleConfirm() {
    if (submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (requestError) {
      setError(requestError);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-tokens-revoke-dialog"
      open={open}
      onClose={onClose}
    >
      <header className="zhs-tokens-dialog-header">
        <div>
          <p className="zhs-tokens-dialog-eyebrow">Access token</p>
          <h2 id={titleId}>Revoke token</h2>
        </div>
        <Button
          aria-label="Close revoke token dialog"
          disabled={submitting}
          size="sm"
          onClick={onClose}
        >
          Close
        </Button>
      </header>
      <div className="zhs-tokens-dialog-body" id={descriptionId}>
        <p>
          Revoke <code>{token.label || token.id}</code>? Clients using this token will immediately
          lose access.
        </p>
        <dl className="zhs-tokens-revoke-summary">
          <div>
            <dt>ID</dt>
            <dd>
              <code>{token.id}</code>
            </dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{token.scope}</dd>
          </div>
        </dl>
        {error ? <ErrorBanner error={error} title="Could not revoke the token" /> : null}
      </div>
      <footer className="zhs-tokens-dialog-footer">
        <Button disabled={submitting} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={submitting} variant="danger" onClick={() => void handleConfirm()}>
          {submitting ? "Revoking…" : "Confirm revoke"}
        </Button>
      </footer>
    </Dialog>
  );
}
