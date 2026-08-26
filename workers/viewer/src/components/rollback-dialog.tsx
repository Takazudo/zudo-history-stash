import type {
  Current,
  GetDiffResult,
  RollbackResult,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { Button } from "../app/shell/button.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";
import { useIdempotencyKey } from "./use-idempotency-key.js";
import "./rollback-dialog.css";

interface HeadSnapshot {
  version: number;
  hash: string | null;
  deleted: boolean;
  author: string;
}

interface RollbackAttempt {
  expectedVersion: number;
  message: string;
}

type PreviewState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | {
      state: "ready";
      head: HeadSnapshot;
      diff: GetDiffResult;
      identicalToHead: boolean;
    };

export interface RollbackSuccess {
  result: RollbackResult;
  message: string;
}

interface RollbackDialogProps {
  client: ViewerStashClient;
  stash: string;
  path: string;
  target: VersionRecord;
  onClose: () => void;
  onSuccess: (success: RollbackSuccess) => void;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const rollbackPreviewStyle = {
  maxHeight: "40dvh",
  overflow: "auto",
  overscrollBehavior: "contain",
} as const;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true",
  );
}

async function readHead(files: StashFilesClient, path: string): Promise<HeadSnapshot> {
  const result = await files.get(path);
  if (result.ok) {
    if ("notModified" in result) throw new Error("The head response was unexpectedly cached.");
    return {
      version: result.value.version,
      hash: result.value.hash,
      deleted: result.value.deleted,
      author: result.value.author,
    };
  }

  if (result.error.code === "file-deleted" && result.current) {
    return {
      version: result.current.version,
      hash: result.current.hash,
      deleted: result.current.deleted,
      author: result.current.author,
    };
  }
  throw result;
}

async function readPreview(
  files: StashFilesClient,
  path: string,
  target: VersionRecord,
): Promise<Extract<PreviewState, { state: "ready" }>> {
  const head = await readHead(files, path);
  const diffResult = await files.diff(path, { from: head.version, to: target.version });
  if (!diffResult.ok) throw diffResult;
  return {
    state: "ready",
    head,
    diff: diffResult.value,
    identicalToHead: target.kind !== "delete" && target.hash !== null && target.hash === head.hash,
  };
}

function DiffStats({ diff }: { diff: GetDiffResult }) {
  if (diff.state === "ready") {
    return (
      <strong aria-label={`${diff.stats.added} lines added, ${diff.stats.removed} lines removed`}>
        +{diff.stats.added} −{diff.stats.removed}
      </strong>
    );
  }
  if (diff.state === "same") {
    return <strong aria-label="0 lines added, 0 lines removed">+0 −0</strong>;
  }
  return <strong>Diff preview unavailable ({diff.reason})</strong>;
}

export function RollbackDialog({
  client,
  stash,
  path,
  target,
  onClose,
  onSuccess,
}: RollbackDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(false);
  const rollbackAttemptRef = useRef<RollbackAttempt | null>(null);
  const getIdempotencyKey = useIdempotencyKey();
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ state: "loading" });
  const [message, setMessage] = useState(`Rollback to v${target.version}`);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [staleHead, setStaleHead] = useState<Current | null>(null);
  const readyHunks =
    preview.state === "ready" && preview.diff.state === "ready" ? preview.diff.hunks : null;
  const diffModel = useMemo(
    () => (readyHunks === null ? null : buildDiffModel(readyHunks)),
    [readyHunks],
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    function keepFocusInside(event: FocusEvent) {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      dialog.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", keepFocusInside);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPreview({ state: "loading" });
    setSubmitError(null);
    setStaleHead(null);

    void readPreview(client.withSignal(controller.signal).files(stash), path, target)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPreview({ state: "error", error });
      });

    return () => controller.abort();
  }, [client, path, previewAttempt, stash, target]);

  useLayoutEffect(() => {
    if (preview.state === "ready" && target.kind !== "delete") {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-rollback-confirm]")?.focus();
    }
  }, [preview.state, target.kind]);

  function reloadPreview() {
    rollbackAttemptRef.current = null;
    setPreviewAttempt((attempt) => attempt + 1);
  }

  async function submitRollback(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (preview.state !== "ready" || target.kind === "delete" || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setStaleHead(null);
    const attempt = rollbackAttemptRef.current ?? {
      expectedVersion: preview.head.version,
      message,
    };
    rollbackAttemptRef.current = attempt;
    let completed: RollbackSuccess | null = null;
    try {
      const result = await client.files(stash).rollback(
        path,
        {
          toVersion: target.version,
          expectedVersion: attempt.expectedVersion,
          author: "viewer",
          message: attempt.message,
        },
        { idempotencyKey: getIdempotencyKey() },
      );
      if (!result.ok) {
        if (result.error.code === "stale" && result.current) setStaleHead(result.current);
        else setSubmitError(result);
        return;
      }
      completed = { result: result.value, message: attempt.message };
    } catch (error) {
      setSubmitError(error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (completed) onSuccess(completed);
  }

  const diffUrl =
    preview.state === "ready"
      ? `/s/${stash}/diff/${path}?from=${preview.head.version}&to=${target.version}`
      : null;
  const targetIsTombstone = target.kind === "delete";

  return createPortal(
    <div className="rollback-dialog__backdrop" role="presentation">
      <div
        aria-busy={preview.state === "loading" ? "true" : undefined}
        aria-describedby="rollback-dialog-description"
        aria-labelledby="rollback-dialog-title"
        aria-modal="true"
        className="rollback-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="rollback-dialog__header">
          <div>
            <p className="rollback-dialog__eyebrow">Append-only rollback</p>
            <h2 id="rollback-dialog-title">
              Rollback <span className="rollback-dialog__path">{path}</span> to v{target.version}
            </h2>
          </div>
          <Button aria-label="Close rollback dialog" compact onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="rollback-dialog__body" id="rollback-dialog-description">
          {preview.state === "loading" ? (
            <p className="loading-copy" role="status">
              Re-reading the current head and loading the diff preview…
            </p>
          ) : null}

          {preview.state === "error" ? (
            <ErrorBanner
              error={preview.error}
              onRetry={reloadPreview}
              title="Could not prepare the rollback"
            />
          ) : null}

          {preview.state === "ready" ? (
            <form className="rollback-dialog__form" onSubmit={submitRollback}>
              <section className="rollback-dialog__summary" aria-label="Rollback summary">
                <div className="rollback-dialog__stats">
                  <span>
                    Head v{preview.head.version} → target v{target.version}
                  </span>
                  <DiffStats diff={preview.diff} />
                </div>
                {diffUrl ? <Link to={diffUrl}>Open full diff</Link> : null}
              </section>

              {diffModel ? (
                <section
                  aria-label="Rollback diff preview"
                  className="rollback-dialog__preview"
                  style={rollbackPreviewStyle}
                >
                  <DiffPane
                    fromLabel={`v${preview.head.version}`}
                    layout="unified"
                    marks={true}
                    model={diffModel}
                    toLabel={`v${target.version}`}
                    wrap={true}
                  />
                </section>
              ) : null}

              {preview.diff.state === "oversized" ? (
                <p className="rollback-dialog__preview-notice">
                  Preview unavailable: diff too large
                </p>
              ) : null}

              <p className="rollback-dialog__consequence">
                This creates v{preview.head.version + 1} as a rollback to v{target.version}. History
                is not deleted.
              </p>

              {preview.identicalToHead ? (
                <p className="rollback-dialog__warning" role="status">
                  v{target.version} is identical to the current head; a rollback still records a
                  history item.
                </p>
              ) : null}

              {targetIsTombstone ? (
                <p className="rollback-dialog__warning" role="status">
                  Rollback to a deletion is not allowed — use delete instead.
                </p>
              ) : null}

              <label className="rollback-dialog__message">
                <span>Message (optional)</span>
                <textarea
                  disabled={submitting || submitError !== null || staleHead !== null}
                  maxLength={2000}
                  rows={3}
                  value={message}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                />
              </label>

              {staleHead ? (
                <section className="rollback-dialog__stale" role="alert">
                  <strong>Head changed</strong>
                  <p>
                    Head moved to v{staleHead.version} by {staleHead.author || "unknown author"} —
                    reload to continue.
                  </p>
                  <Button onClick={reloadPreview}>Reload</Button>
                </section>
              ) : null}

              {submitError ? (
                <ErrorBanner
                  error={submitError}
                  onRetry={() => void submitRollback()}
                  title="Could not complete the rollback"
                />
              ) : null}

              <div className="rollback-dialog__actions">
                <Button disabled={submitting} onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  data-rollback-confirm
                  disabled={targetIsTombstone || submitting || staleHead !== null}
                  type="submit"
                  variant="danger"
                >
                  {submitting ? "Rolling back…" : "Confirm rollback"}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
