import type {
  Current,
  DeleteFileBody,
  StashClient,
  StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { utf8ByteLength } from "@takazudo/zudo-history-stash-core";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useCanWrite, useStashClient } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { ErrorBanner } from "./error-banner.js";

const MAX_AUTHOR_BYTES = 200;
const MAX_MESSAGE_BYTES = 2_000;
const clientIdentityKeys = new WeakMap<object, number>();
let nextClientIdentityKey = 1;

type DeleteInput = Parameters<StashFilesClient["delete"]>[1];

interface DeleteAttempt {
  readonly input: Readonly<DeleteInput>;
  readonly options: Readonly<{ idempotencyKey: string }>;
}

type DeleteStatus =
  | { state: "idle" }
  | { state: "transport-error"; error: unknown }
  | { state: "error"; error: unknown }
  | { state: "stale"; current: Current }
  | { state: "completed" };

export interface DeleteFileDialogProps {
  open: boolean;
  stash: string;
  path: string;
  headVersion: number;
  onClose: () => void;
  onChanged: () => void;
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

function freezeAttempt(headVersion: number, author: string, message: string): DeleteAttempt {
  const input: DeleteFileBody = {
    expectedVersion: headVersion,
    ...(author.length > 0 ? { author } : {}),
    ...(message.length > 0 ? { message } : {}),
  };
  return Object.freeze({
    input: Object.freeze(input),
    options: Object.freeze({ idempotencyKey: globalThis.crypto.randomUUID() }),
  });
}

function keyForClient(client: StashClient): number {
  const existing = clientIdentityKeys.get(client);
  if (existing !== undefined) return existing;
  const key = nextClientIdentityKey;
  nextClientIdentityKey += 1;
  clientIdentityKeys.set(client, key);
  return key;
}

interface DeleteFileDialogOpenProps extends DeleteFileDialogProps {
  client: StashClient;
}

function DeleteFileDialogOpen({
  client,
  open,
  stash,
  path,
  headVersion,
  onClose,
  onChanged,
}: DeleteFileDialogOpenProps) {
  const titleId = useId();
  const descriptionId = useId();
  const authorId = useId();
  const authorCountId = useId();
  const messageId = useId();
  const messageCountId = useId();
  const lifecycleRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const deleteAttemptRef = useRef<DeleteAttempt | null>(null);
  const completedRef = useRef(false);
  const previousOpenRef = useRef(open);
  const [author, setAuthor] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<DeleteStatus>({ state: "idle" });
  const authorBytes = utf8ByteLength(author);
  const messageBytes = utf8ByteLength(message);
  const frozenAfterTransportFailure = status.state === "transport-error";
  const terminal = status.state === "stale" || status.state === "completed";
  const fieldsDisabled = submitting || frozenAfterTransportFailure || terminal;

  useLayoutEffect(() => {
    if (!open && previousOpenRef.current) {
      lifecycleRef.current += 1;
      operationSequenceRef.current += 1;
      submittingRef.current = false;
      deleteAttemptRef.current = null;
      completedRef.current = false;
      setSubmitting(false);
      setStatus({ state: "idle" });
    }
    previousOpenRef.current = open;
  }, [open]);

  useLayoutEffect(
    () => () => {
      lifecycleRef.current += 1;
      operationSequenceRef.current += 1;
      submittingRef.current = false;
      deleteAttemptRef.current = null;
    },
    [],
  );

  function resetRecoverableError() {
    if (status.state === "error") setStatus({ state: "idle" });
  }

  function requestClose() {
    if (submittingRef.current) return;
    lifecycleRef.current += 1;
    operationSequenceRef.current += 1;
    deleteAttemptRef.current = null;
    completedRef.current = false;
    setStatus({ state: "idle" });
    onClose();
  }

  function reportChanged() {
    if (completedRef.current) return;
    completedRef.current = true;
    deleteAttemptRef.current = null;
    setStatus({ state: "completed" });
    onClose();
    onChanged();
  }

  async function submitDelete(event?: FormEvent<HTMLFormElement>, retry = false) {
    event?.preventDefault();
    if (submittingRef.current || terminal || completedRef.current) return;
    if (retry && status.state !== "transport-error") return;
    if (!retry && status.state === "transport-error") return;

    const attempt = retry ? deleteAttemptRef.current : freezeAttempt(headVersion, author, message);
    if (attempt === null) return;
    deleteAttemptRef.current = attempt;
    submittingRef.current = true;
    setSubmitting(true);
    setStatus({ state: "idle" });
    const lifecycle = lifecycleRef.current;
    const operationSequence = ++operationSequenceRef.current;
    const isCurrent = () =>
      lifecycleRef.current === lifecycle && operationSequenceRef.current === operationSequence;

    let completed = false;
    try {
      const result = await client.files(stash).delete(path, attempt.input, attempt.options);
      if (!isCurrent()) return;
      if (result.ok) {
        completed = true;
      } else if (result.error.code === "stale" && result.current) {
        deleteAttemptRef.current = null;
        setStatus({ state: "stale", current: result.current });
      } else if (result.error.code === "already-deleted") {
        completed = true;
      } else {
        deleteAttemptRef.current = null;
        setStatus({ state: "error", error: result });
      }
    } catch (error: unknown) {
      if (!isCurrent()) return;
      // Only a transport-level retry retains and replays this exact immutable request and key.
      setStatus({ state: "transport-error", error });
    } finally {
      if (isCurrent()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }

    if (completed && isCurrent()) reportChanged();
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-delete-file-dialog"
      open={open}
      onClose={requestClose}
    >
      <form
        aria-busy={submitting ? "true" : undefined}
        className="zhs-delete-file-dialog__form"
        onSubmit={(event) => void submitDelete(event)}
      >
        <header className="zhs-delete-file-dialog__header">
          <div>
            <p className="zhs-delete-file-dialog__eyebrow">Append-only deletion</p>
            <h2 className="zhs-delete-file-dialog__title" id={titleId}>
              Delete <span className="zhs-delete-file-dialog__path">{path}</span>
            </h2>
          </div>
          <Button
            aria-label="Close delete file dialog"
            disabled={submitting}
            size="sm"
            onClick={requestClose}
          >
            Close
          </Button>
        </header>

        <div className="zhs-delete-file-dialog__body">
          <Notice className="zhs-delete-file-dialog__consequence" variant="warning">
            <strong id={descriptionId}>
              Creates v{headVersion + 1} as a tombstone · history is never deleted · restore later
              with rollback
            </strong>
          </Notice>

          {status.state === "stale" ? (
            <Notice className="zhs-delete-file-dialog__status" variant="warning">
              <strong>Head moved to v{status.current.version} — reload</strong>
              <p>The stale delete was not retried.</p>
            </Notice>
          ) : null}

          {status.state === "transport-error" ? (
            <ErrorBanner
              error={status.error}
              title="Could not delete this file"
              onRetry={() => void submitDelete(undefined, true)}
            />
          ) : null}

          {status.state === "error" ? (
            <ErrorBanner error={status.error} title="Could not delete this file" />
          ) : null}

          <div className="zhs-delete-file-dialog__field">
            <label htmlFor={authorId}>
              Author <span className="zhs-delete-file-dialog__optional">(optional)</span>
            </label>
            <Input
              aria-describedby={authorCountId}
              autoComplete="name"
              disabled={fieldsDisabled}
              id={authorId}
              name="author"
              value={author}
              onChange={(event) => {
                setAuthor(fitUtf8Bytes(event.currentTarget.value, MAX_AUTHOR_BYTES));
                resetRecoverableError();
              }}
            />
            <span className="zhs-delete-file-dialog__byte-count" id={authorCountId}>
              {authorBytes} / {MAX_AUTHOR_BYTES} UTF-8 bytes
            </span>
          </div>

          <div className="zhs-delete-file-dialog__field">
            <label htmlFor={messageId}>
              Message <span className="zhs-delete-file-dialog__optional">(optional)</span>
            </label>
            <Textarea
              aria-describedby={messageCountId}
              disabled={fieldsDisabled}
              id={messageId}
              name="message"
              rows={3}
              value={message}
              onChange={(event) => {
                setMessage(fitUtf8Bytes(event.currentTarget.value, MAX_MESSAGE_BYTES));
                resetRecoverableError();
              }}
            />
            <span className="zhs-delete-file-dialog__byte-count" id={messageCountId}>
              {messageBytes} / {MAX_MESSAGE_BYTES} UTF-8 bytes
            </span>
          </div>
        </div>

        <footer className="zhs-delete-file-dialog__actions">
          {status.state === "stale" ? (
            <Button onClick={requestClose}>Close</Button>
          ) : status.state === "transport-error" ? (
            <Button disabled={submitting} onClick={requestClose}>
              Close
            </Button>
          ) : (
            <>
              <Button disabled={submitting} onClick={requestClose}>
                Cancel
              </Button>
              <Button
                disabled={submitting || status.state === "completed"}
                type="submit"
                variant="danger"
              >
                {submitting ? `Deleting as v${headVersion + 1}…` : `Delete as v${headVersion + 1}`}
              </Button>
            </>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

export function DeleteFileDialog(props: DeleteFileDialogProps) {
  const client = useStashClient();
  const capability = useCanWrite(props.stash);
  if (!capability.ready || !capability.canWrite) return null;
  const targetKey = JSON.stringify([
    keyForClient(client),
    props.stash,
    props.path,
    props.headVersion,
  ]);
  return <DeleteFileDialogOpen key={targetKey} {...props} client={client} />;
}
