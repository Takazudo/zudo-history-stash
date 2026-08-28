import {
  validatePath,
  type Current,
  type PutResult,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Anchor, useCanWrite, useStashClient, useStashHref } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { ErrorBanner } from "./error-banner.js";

type PutInput = Parameters<StashFilesClient["put"]>[1];

interface FileSnapshot {
  readonly path: string;
  readonly body: string;
  readonly author?: string;
  readonly message?: string;
}

interface PutAttempt {
  readonly source: FileSnapshot;
  readonly input: Readonly<PutInput>;
  readonly options: Readonly<{ idempotencyKey: string }>;
}

interface ConflictState {
  readonly current: Current;
  readonly source: FileSnapshot;
}

interface SubmitFailure {
  readonly error: unknown;
  readonly transport: boolean;
}

export interface NewFileCreated {
  path: string;
  version: number;
}

export interface NewFileFormProps {
  stash: string;
  onCreated: (created: NewFileCreated) => void;
}

function snapshotFile(path: string, body: string, author: string, message: string): FileSnapshot {
  const trimmedAuthor = author.trim();
  const trimmedMessage = message.trim();
  return Object.freeze({
    path,
    body,
    ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
    ...(trimmedMessage ? { message: trimmedMessage } : {}),
  });
}

function createAttempt(source: FileSnapshot, expectedVersion: number | null): PutAttempt {
  const input = Object.freeze({
    body: source.body,
    expectedVersion,
    ...(source.author ? { author: source.author } : {}),
    ...(source.message ? { message: source.message } : {}),
  });
  const options = Object.freeze({ idempotencyKey: globalThis.crypto.randomUUID() });
  return Object.freeze({ source, input, options });
}

function conflictDescription(current: Current): string {
  const author = current.author || "unknown author";
  return current.deleted
    ? `The path is a tombstone at v${current.version}, deleted by ${author}.`
    : `The path already has a live head at v${current.version}, written by ${author}.`;
}

export function NewFileForm({ stash, onCreated }: NewFileFormProps) {
  const client = useStashClient();
  const hrefFor = useStashHref();
  const capability = useCanWrite(stash);
  const titleId = useId();
  const pathId = useId();
  const pathHintId = useId();
  const pathErrorId = useId();
  const bodyId = useId();
  const authorId = useId();
  const messageId = useId();
  const lifecycleRef = useRef(0);
  const submittingRef = useRef(false);
  const activeAttemptRef = useRef<PutAttempt | null>(null);
  const [path, setPath] = useState("");
  const [body, setBody] = useState("");
  const [author, setAuthor] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(null);

  useLayoutEffect(() => {
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    submittingRef.current = false;
    activeAttemptRef.current = null;
    setPath("");
    setBody("");
    setAuthor("");
    setMessage("");
    setSubmitting(false);
    setConflict(null);
    setSubmitFailure(null);

    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1;
      submittingRef.current = false;
      activeAttemptRef.current = null;
    };
  }, [client, stash]);

  const validation = validatePath(path);
  const pathErrorVisible = path.length > 0 && !validation.ok;
  const retryLocked = submitFailure?.transport === true;
  const controlsDisabled = submitting || retryLocked;

  function clearOutcome() {
    if (submittingRef.current || submitFailure?.transport) return;
    activeAttemptRef.current = null;
    setConflict(null);
    setSubmitFailure(null);
  }

  async function executeAttempt(attempt: PutAttempt) {
    if (
      submittingRef.current ||
      !capability.ready ||
      !capability.canWrite ||
      activeAttemptRef.current !== attempt
    ) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setConflict(null);
    setSubmitFailure(null);
    const lifecycle = lifecycleRef.current;
    const isCurrentLifecycle = () => lifecycleRef.current === lifecycle;
    let created: NewFileCreated | null = null;

    try {
      const result = await client
        .files(stash)
        .put(attempt.source.path, attempt.input, attempt.options);
      if (!isCurrentLifecycle() || activeAttemptRef.current !== attempt) return;

      if (!result.ok) {
        activeAttemptRef.current = null;
        if ((result.error.code === "exists" || result.error.code === "stale") && result.current) {
          setConflict({ current: result.current, source: attempt.source });
        } else {
          setSubmitFailure({ error: result, transport: false });
        }
        return;
      }

      const value: PutResult = result.value;
      activeAttemptRef.current = null;
      created = { path: attempt.source.path, version: value.version };
    } catch (error: unknown) {
      if (!isCurrentLifecycle() || activeAttemptRef.current !== attempt) return;
      // Only a transport failure keeps this exact frozen request and key eligible for replay.
      setSubmitFailure({ error, transport: true });
    } finally {
      if (isCurrentLifecycle()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }

    if (created && isCurrentLifecycle()) onCreated(created);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !capability.ready ||
      !capability.canWrite ||
      !validation.ok ||
      submittingRef.current ||
      retryLocked
    ) {
      return;
    }

    const attempt = createAttempt(snapshotFile(path, body, author, message), null);
    activeAttemptRef.current = attempt;
    void executeAttempt(attempt);
  }

  function handleRetry() {
    const attempt = activeAttemptRef.current;
    if (!attempt) return;
    void executeAttempt(attempt);
  }

  function handleResurrect() {
    if (
      !conflict?.current.deleted ||
      !capability.ready ||
      !capability.canWrite ||
      submittingRef.current
    ) {
      return;
    }

    // Resurrection is a new canonical operation: it gets the observed tombstone fence and key.
    const attempt = createAttempt(conflict.source, conflict.current.version);
    activeAttemptRef.current = attempt;
    void executeAttempt(attempt);
  }

  if (!capability.ready) {
    return (
      <section className="zhs-new-file-not-available" role="status">
        <h2>Checking write access…</h2>
      </section>
    );
  }

  if (!capability.canWrite) {
    return (
      <section className="zhs-new-file-not-available" role="status">
        <h2>File creation is not available</h2>
        <p>A write-capable token for this stash is required to create a file.</p>
      </section>
    );
  }

  return (
    <section className="zhs-new-file-form" aria-labelledby={titleId}>
      <header className="zhs-new-file-form__header">
        <h2 id={titleId}>Create file</h2>
        <p>Write the first version at a new path in {stash}.</p>
      </header>

      <form
        className="zhs-new-file-form__form"
        aria-busy={submitting ? "true" : undefined}
        noValidate
        onSubmit={handleSubmit}
      >
        <div className="zhs-new-file-form__field">
          <label className="zhs-new-file-form__label" htmlFor={pathId}>
            Path
          </label>
          <Input
            autoComplete="off"
            id={pathId}
            name="path"
            required
            spellCheck={false}
            value={path}
            aria-describedby={pathErrorVisible ? `${pathHintId} ${pathErrorId}` : pathHintId}
            aria-invalid={pathErrorVisible || undefined}
            disabled={controlsDisabled}
            onChange={(event) => {
              setPath(event.currentTarget.value);
              clearOutcome();
            }}
          />
          <p className="zhs-new-file-form__hint" id={pathHintId}>
            Use letters, numbers, dots, underscores, or hyphens in slash-separated segments.
          </p>
          {pathErrorVisible ? (
            <p className="zhs-new-file-form__field-error" id={pathErrorId} role="alert">
              {validation.message}
            </p>
          ) : null}
        </div>

        <div className="zhs-new-file-form__field">
          <label className="zhs-new-file-form__label" htmlFor={bodyId}>
            File body
          </label>
          <Textarea
            id={bodyId}
            name="body"
            rows={14}
            value={body}
            disabled={controlsDisabled}
            onChange={(event) => {
              setBody(event.currentTarget.value);
              clearOutcome();
            }}
          />
          <p className="zhs-new-file-form__hint">An empty first version is allowed.</p>
        </div>

        <div className="zhs-new-file-form__metadata">
          <div className="zhs-new-file-form__field">
            <label className="zhs-new-file-form__label" htmlFor={authorId}>
              Author <span className="zhs-new-file-form__optional">(optional)</span>
            </label>
            <Input
              id={authorId}
              name="author"
              value={author}
              disabled={controlsDisabled}
              onChange={(event) => {
                setAuthor(event.currentTarget.value);
                clearOutcome();
              }}
            />
          </div>

          <div className="zhs-new-file-form__field">
            <label className="zhs-new-file-form__label" htmlFor={messageId}>
              Message <span className="zhs-new-file-form__optional">(optional)</span>
            </label>
            <Input
              id={messageId}
              name="message"
              value={message}
              disabled={controlsDisabled}
              onChange={(event) => {
                setMessage(event.currentTarget.value);
                clearOutcome();
              }}
            />
          </div>
        </div>

        {conflict ? (
          <Notice className="zhs-new-file-form__conflict" variant="warning">
            <strong>
              {conflict.current.deleted ? "This path was deleted" : "This path exists"}
            </strong>
            <p>{conflictDescription(conflict.current)}</p>
            <p>
              Current kind: <code>{conflict.current.kind}</code>; recorded at{" "}
              <time dateTime={conflict.current.createdAt}>{conflict.current.createdAt}</time>
            </p>
            <div className="zhs-new-file-form__conflict-actions">
              {conflict.current.deleted ? (
                <Button disabled={submitting} onClick={handleResurrect} variant="primary">
                  Resurrect with this content
                </Button>
              ) : (
                <Anchor
                  className="zhs-new-file-form__open-link"
                  href={hrefFor({ kind: "file", stash, path: conflict.source.path })}
                  aria-label="Open file"
                >
                  Open the file
                </Anchor>
              )}
            </div>
          </Notice>
        ) : null}

        {submitFailure ? (
          <ErrorBanner
            error={submitFailure.error}
            onRetry={submitFailure.transport ? handleRetry : undefined}
            title={
              submitFailure.transport
                ? "File creation was interrupted"
                : "Could not create the file"
            }
          />
        ) : null}

        <footer className="zhs-new-file-form__actions">
          <Button
            disabled={!validation.ok || submitting || retryLocked || conflict !== null}
            type="submit"
            variant="primary"
          >
            {submitting ? "Creating…" : "Create file"}
          </Button>
        </footer>
      </form>
    </section>
  );
}
