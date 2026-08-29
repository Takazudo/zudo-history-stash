import {
  isCommitConflict,
  type CommitConflict,
  type CommitRecord,
  type CommitResult,
  type Current,
} from "@takazudo/zudo-history-stash";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useStashClient, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";

export interface RevertCommitDialogProps {
  stash: string;
  commit: CommitRecord;
  onClose: () => void;
  onSuccess: (commit: CommitResult) => void;
}

type PreviewState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; heads: Map<string, Current | null> };

interface RevertAttempt {
  input: { author: string; message: string; meta: Record<string, never> };
  options: { idempotencyKey: string };
}

export function RevertCommitDialog({ stash, commit, onClose, onSuccess }: RevertCommitDialogProps) {
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const titleId = useId();
  const [preview, setPreview] = useState<PreviewState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [author, setAuthor] = useState("");
  const [message, setMessage] = useState(`Revert: ${commit.message}`);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [conflicts, setConflicts] = useState<CommitConflict[]>([]);
  const submittingRef = useRef(false);
  const revertAttemptRef = useRef<RevertAttempt | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPreview({ state: "loading" });
    const files = clientForSignal(controller.signal).files(stash);
    void Promise.all(
      commit.entries.map(async (entry) => {
        const result = await files.get(entry.path);
        if (result.ok) {
          if ("notModified" in result) return [entry.path, null] as const;
          const value = result.value;
          return [
            entry.path,
            {
              version: value.version,
              hash: value.hash,
              deleted: value.deleted,
              kind: value.kind,
              author: value.author,
              createdAt: value.createdAt,
            },
          ] as const;
        }
        if (result.current) return [entry.path, result.current] as const;
        if (result.error.code === "not-found") return [entry.path, null] as const;
        throw result;
      }),
    )
      .then((entries) => {
        if (!controller.signal.aborted) setPreview({ state: "ready", heads: new Map(entries) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPreview({ state: "error", error });
      });
    return () => controller.abort();
  }, [attempt, clientForSignal, commit, stash]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current || preview.state !== "ready") return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    setConflicts([]);
    try {
      const attempt = revertAttemptRef.current ?? {
        input: { author, message, meta: {} },
        options: { idempotencyKey: crypto.randomUUID() },
      };
      revertAttemptRef.current = attempt;
      const result = await client.commits(stash).revert(commit.id, attempt.input, attempt.options);
      if (!result.ok) {
        revertAttemptRef.current = null;
        if (isCommitConflict(result)) setConflicts(result.conflicts);
        else setFailure(result);
      } else onSuccess(result.value);
    } catch (error) {
      setFailure(error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      aria-labelledby={titleId}
      className="zhs-decision-dialog"
      onClose={() => {
        if (!submittingRef.current) onClose();
      }}
    >
      <form className="zhs-decision-dialog__form" onSubmit={submit}>
        <h2 id={titleId}>Revert commit</h2>
        <p>This creates a new atomic commit that reverses all {commit.entryCount} entries.</p>
        {preview.state === "loading" ? <p role="status">Reading current heads…</p> : null}
        {preview.state === "error" ? (
          <ErrorBanner
            error={preview.error}
            onRetry={() => setAttempt((value) => value + 1)}
            title="Could not preview current heads"
          />
        ) : null}
        {preview.state === "ready" ? (
          <ul className="zhs-record-list__paths" aria-label="Current head preview">
            {commit.entries.map((entry) => {
              const head = preview.heads.get(entry.path);
              return (
                <li key={entry.path}>
                  <PathText value={entry.path} /> —{" "}
                  {head ? `head v${head.version}${head.deleted ? " (deleted)" : ""}` : "missing"}
                </li>
              );
            })}
          </ul>
        ) : null}
        {conflicts.length > 0 ? (
          <Notice variant="error">
            <strong>The commit could not be reverted because heads changed.</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.path}>
                  <PathText value={conflict.path} />: expected{" "}
                  {conflict.expectedVersion === null ? "missing" : `v${conflict.expectedVersion}`},
                  now {conflict.current ? `v${conflict.current.version}` : "missing"}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {failure ? <ErrorBanner error={failure} title="Could not revert commit" /> : null}
        {failure && revertAttemptRef.current ? (
          <Notice variant="warning">Retry replays the exact previous request safely.</Notice>
        ) : null}
        <label className="zhs-decision-dialog__field">
          Author
          <Input
            value={author}
            maxLength={200}
            disabled={submitting || (failure !== null && revertAttemptRef.current !== null)}
            onChange={(event) => setAuthor(event.currentTarget.value)}
          />
        </label>
        <label className="zhs-decision-dialog__field">
          Message
          <Textarea
            value={message}
            maxLength={2000}
            rows={3}
            disabled={submitting || (failure !== null && revertAttemptRef.current !== null)}
            onChange={(event) => setMessage(event.currentTarget.value)}
          />
        </label>
        <div className="zhs-decision-actions">
          <Button
            disabled={submitting}
            onClick={() => {
              if (!submittingRef.current) onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={submitting || preview.state !== "ready"}>
            {submitting ? "Reverting…" : "Revert commit"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
