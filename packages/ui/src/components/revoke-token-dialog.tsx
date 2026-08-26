import type { TokenRecord } from "@takazudo/zudo-history-stash";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { ErrorBanner } from "./error-banner.js";

export interface RevokeTokenDialogProps {
  open: boolean;
  token: TokenRecord;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  operationKey: object;
}

interface RevokeOperation {
  operationKey: object;
  generation: number;
}

type RevokeOperationSnapshot =
  | { operation: RevokeOperation; state: "submitting" }
  | { operation: RevokeOperation; state: "error"; error: unknown };

export function RevokeTokenDialog({
  open,
  token,
  onClose,
  onConfirm,
  operationKey,
}: RevokeTokenDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const activeOperationKeyRef = useRef(operationKey);
  const operationGenerationRef = useRef(0);
  const activeOperationRef = useRef<RevokeOperation | null>(null);
  const [operationSnapshot, setOperationSnapshot] = useState<RevokeOperationSnapshot | null>(null);
  const submitting =
    operationSnapshot?.operation.operationKey === operationKey &&
    operationSnapshot.state === "submitting";
  const error =
    operationSnapshot?.operation.operationKey === operationKey &&
    operationSnapshot.state === "error"
      ? operationSnapshot.error
      : null;

  useLayoutEffect(() => {
    if (activeOperationKeyRef.current === operationKey) return;
    activeOperationKeyRef.current = operationKey;
    if (activeOperationRef.current?.operationKey !== operationKey) {
      activeOperationRef.current = null;
    }
  }, [operationKey]);

  function isCurrentOperation(operation: RevokeOperation): boolean {
    return (
      activeOperationKeyRef.current === operation.operationKey &&
      activeOperationRef.current?.operationKey === operation.operationKey &&
      activeOperationRef.current.generation === operation.generation
    );
  }

  function handleClose() {
    if (activeOperationRef.current?.operationKey === operationKey) return;
    onClose();
  }

  async function handleConfirm() {
    if (activeOperationRef.current?.operationKey === operationKey) return;

    const operation: RevokeOperation = {
      operationKey,
      generation: ++operationGenerationRef.current,
    };
    activeOperationRef.current = operation;
    setOperationSnapshot({ operation, state: "submitting" });
    try {
      await onConfirm();
      if (isCurrentOperation(operation)) setOperationSnapshot(null);
    } catch (requestError) {
      if (isCurrentOperation(operation)) {
        setOperationSnapshot({ operation, state: "error", error: requestError });
      }
    } finally {
      if (isCurrentOperation(operation)) {
        activeOperationRef.current = null;
        setOperationSnapshot((current) =>
          current?.operation.generation === operation.generation && current.state === "submitting"
            ? null
            : current,
        );
      }
    }
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-tokens-revoke-dialog"
      open={open}
      onClose={handleClose}
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
          onClick={handleClose}
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
        <Button disabled={submitting} onClick={handleClose}>
          Cancel
        </Button>
        <Button disabled={submitting} variant="danger" onClick={() => void handleConfirm()}>
          {submitting ? "Revoking…" : "Confirm revoke"}
        </Button>
      </footer>
    </Dialog>
  );
}
