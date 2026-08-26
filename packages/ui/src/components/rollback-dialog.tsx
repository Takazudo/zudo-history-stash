import type {
  Current,
  GetDiffResult,
  RollbackResult,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  useCanWrite,
  useStashClient,
  useStashClientForSignal,
  useStashHref,
  Anchor,
} from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";

interface HeadSnapshot {
  version: number;
  hash: string | null;
  deleted: boolean;
  author: string;
}

type RollbackInput = Parameters<StashFilesClient["rollback"]>[1];

interface RollbackAttempt {
  readonly input: Readonly<RollbackInput>;
  readonly options: Readonly<{ idempotencyKey: string }>;
}

interface SubmitFailure {
  error: unknown;
  transport: boolean;
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

export interface RollbackDialogProps {
  stash: string;
  path: string;
  target: VersionRecord;
  onClose: () => void;
  onSuccess: (success: RollbackSuccess) => void;
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

function freezeAttempt(
  targetVersion: number,
  expectedVersion: number,
  message: string,
): RollbackAttempt {
  const input = Object.freeze({
    toVersion: targetVersion,
    expectedVersion,
    author: "viewer",
    message,
  });
  const options = Object.freeze({ idempotencyKey: globalThis.crypto.randomUUID() });
  return Object.freeze({ input, options });
}

export function RollbackDialog({ stash, path, target, onClose, onSuccess }: RollbackDialogProps) {
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const capability = useCanWrite(stash);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const rollbackAttemptRef = useRef<RollbackAttempt | null>(null);
  const mutationLifecycleRef = useRef(0);
  const previewSequenceRef = useRef(0);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ state: "loading" });
  const [message, setMessage] = useState(`Rollback to v${target.version}`);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(null);
  const [staleHead, setStaleHead] = useState<Current | null>(null);
  const readyHunks =
    preview.state === "ready" && preview.diff.state === "ready" ? preview.diff.hunks : null;
  const diffModel = useMemo(
    () => (readyHunks === null ? null : buildDiffModel(readyHunks)),
    [readyHunks],
  );

  useLayoutEffect(() => {
    const lifecycle = mutationLifecycleRef.current + 1;
    mutationLifecycleRef.current = lifecycle;
    submittingRef.current = false;
    rollbackAttemptRef.current = null;
    setMessage(`Rollback to v${target.version}`);
    setSubmitting(false);
    setSubmitFailure(null);
    setStaleHead(null);
    setPreview({ state: "loading" });

    return () => {
      if (mutationLifecycleRef.current === lifecycle) mutationLifecycleRef.current += 1;
      submittingRef.current = false;
      rollbackAttemptRef.current = null;
    };
  }, [client, path, stash, target.hash, target.kind, target.version]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++previewSequenceRef.current;
    rollbackAttemptRef.current = null;
    setPreview({ state: "loading" });
    setSubmitFailure(null);
    setStaleHead(null);

    void readPreview(clientForSignal(controller.signal).files(stash), path, target)
      .then((value) => {
        if (!controller.signal.aborted && previewSequenceRef.current === sequence)
          setPreview(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && previewSequenceRef.current === sequence) {
          setPreview({ state: "error", error });
        }
      });

    return () => controller.abort();
  }, [clientForSignal, path, previewAttempt, stash, target]);

  useLayoutEffect(() => {
    if (preview.state === "ready" && target.kind !== "delete" && capability.canWrite) {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-rollback-confirm]")?.focus();
    }
  }, [capability.canWrite, preview.state, target.kind]);

  function reloadPreview() {
    rollbackAttemptRef.current = null;
    setPreviewAttempt((attempt) => attempt + 1);
  }

  async function submitRollback(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (
      preview.state !== "ready" ||
      target.kind === "delete" ||
      submittingRef.current ||
      !capability.ready ||
      !capability.canWrite
    ) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setSubmitFailure(null);
    setStaleHead(null);
    const attempt =
      rollbackAttemptRef.current ?? freezeAttempt(target.version, preview.head.version, message);
    rollbackAttemptRef.current = attempt;
    const lifecycle = mutationLifecycleRef.current;
    const isCurrentLifecycle = () => mutationLifecycleRef.current === lifecycle;
    let completed: RollbackSuccess | null = null;

    try {
      const result = await client.files(stash).rollback(path, attempt.input, attempt.options);
      if (!isCurrentLifecycle()) return;
      if (!result.ok) {
        rollbackAttemptRef.current = null;
        if (result.error.code === "stale" && result.current) setStaleHead(result.current);
        else setSubmitFailure({ error: result, transport: false });
      } else {
        completed = { result: result.value, message: attempt.input.message ?? "" };
      }
    } catch (error) {
      if (!isCurrentLifecycle()) return;
      // A transport retry must replay the exact immutable body and key from this attempt.
      setSubmitFailure({ error, transport: true });
    } finally {
      if (isCurrentLifecycle()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
    if (completed && isCurrentLifecycle()) onSuccess(completed);
  }

  const diffHref =
    preview.state === "ready"
      ? hrefFor({
          kind: "diff",
          stash,
          path,
          from: preview.head.version,
          to: target.version,
        })
      : null;
  const targetIsTombstone = target.kind === "delete";
  const capabilityUnavailable = !capability.ready || !capability.canWrite;

  return (
    <Dialog
      aria-busy={preview.state === "loading" ? "true" : undefined}
      aria-describedby="rollback-dialog-description"
      aria-labelledby="rollback-dialog-title"
      className="zhs-rollback-dialog"
      open={true}
      ref={dialogRef}
      onClose={onClose}
    >
      <header className="zhs-rollback-dialog__header">
        <div>
          <p className="zhs-rollback-dialog__eyebrow">Append-only rollback</p>
          <h2 id="rollback-dialog-title">
            Rollback <span className="zhs-rollback-dialog__path">{path}</span> to v{target.version}
          </h2>
        </div>
        <Button aria-label="Close rollback dialog" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="zhs-rollback-dialog__body" id="rollback-dialog-description">
        {preview.state === "loading" ? (
          <p className="zhs-rollback-dialog__loading" role="status">
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
          <form className="zhs-rollback-dialog__form" onSubmit={submitRollback}>
            <section className="zhs-rollback-dialog__summary" aria-label="Rollback summary">
              <div className="zhs-rollback-dialog__stats">
                <span>
                  Head v{preview.head.version} → target v{target.version}
                </span>
                <DiffStats diff={preview.diff} />
              </div>
              {diffHref ? <Anchor href={diffHref}>Open full diff</Anchor> : null}
            </section>

            {diffModel ? (
              <section aria-label="Rollback diff preview" className="zhs-rollback-dialog__preview">
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
              <p className="zhs-rollback-dialog__preview-notice">
                Preview unavailable: diff too large
              </p>
            ) : null}

            <p className="zhs-rollback-dialog__consequence">
              This creates v{preview.head.version + 1} as a rollback to v{target.version}. History
              is not deleted.
            </p>

            {preview.identicalToHead ? (
              <Notice className="zhs-rollback-dialog__warning" variant="warning">
                v{target.version} is identical to the current head; a rollback still records a
                history item.
              </Notice>
            ) : null}

            {targetIsTombstone ? (
              <Notice className="zhs-rollback-dialog__warning" variant="warning">
                Rollback to a deletion is not allowed — use delete instead.
              </Notice>
            ) : null}

            {capabilityUnavailable ? (
              <Notice className="zhs-rollback-dialog__capability" variant="warning">
                {capability.ready
                  ? "Write access is required to roll back this file."
                  : "Checking write access before rollback…"}
              </Notice>
            ) : null}

            <label className="zhs-rollback-dialog__message">
              <span>Message (optional)</span>
              <Textarea
                disabled={submitting || submitFailure?.transport === true || staleHead !== null}
                maxLength={2000}
                rows={3}
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>

            {staleHead ? (
              <Notice className="zhs-rollback-dialog__stale" variant="error">
                <strong>Head changed</strong>
                <p>
                  Head moved to v{staleHead.version} by {staleHead.author || "unknown author"} —
                  reload to continue.
                </p>
                <Button size="sm" onClick={reloadPreview}>
                  Reload
                </Button>
              </Notice>
            ) : null}

            {submitFailure ? (
              <ErrorBanner
                error={submitFailure.error}
                onRetry={() => void submitRollback()}
                title="Could not complete the rollback"
              />
            ) : null}

            <div className="zhs-rollback-dialog__actions">
              <Button disabled={submitting} onClick={onClose}>
                Cancel
              </Button>
              <Button
                data-rollback-confirm
                disabled={
                  targetIsTombstone || submitting || staleHead !== null || capabilityUnavailable
                }
                type="submit"
                variant="danger"
              >
                {submitting ? "Rolling back…" : "Confirm rollback"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}
