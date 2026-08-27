import type {
  CreateProposalBody,
  FileRecord,
  FileRecordWithEtag,
  ProposalRecord,
} from "@takazudo/zudo-history-stash";
import { sha256Hex, utf8ByteLength } from "@takazudo/zudo-history-stash-core";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useCandidateDiff } from "../hooks/use-candidate-diff.js";
import { useDiffViewPreferences } from "../hooks/use-diff-view-preferences.js";
import {
  applyLineEnding,
  type LineEnding,
  type SaveMachine,
  type SaveMachineState,
} from "../hooks/use-save-machine.js";
import { useCanWrite, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";

const AUTHOR_STORAGE_KEY = "zhs.author";
const MAX_AUTHOR_BYTES = 200;
const MAX_MESSAGE_BYTES = 2_000;
const targetIdentityKeys = new WeakMap<object, number>();
let nextTargetIdentityKey = 1;

type PendingOperation = "save" | "retry" | "reload";

export type SaveReviewCompletion = Extract<SaveMachineState, { state: "saved" | "unchanged" }>;

export interface SaveReviewDialogProps {
  open: boolean;
  stash?: string;
  head: FileRecord;
  draft: string;
  lineEnding: LineEnding;
  machine: SaveMachine;
  onClose: () => void;
  onDiscard: () => void;
  onSaved: (completion: SaveReviewCompletion) => void;
  onProposed?: (record: ProposalRecord) => void;
}

interface SameAsHeadSnapshot {
  draft: string;
  lineEnding: LineEnding;
  headHash: string | null;
  same: boolean;
}

interface FrozenProposalAttempt {
  readonly input: Readonly<CreateProposalBody>;
  readonly options: Readonly<{ idempotencyKey: string }>;
}

type ProposalSaveState =
  | { state: "idle" }
  | { state: "error"; error: unknown; transport: boolean }
  | { state: "created"; record: ProposalRecord };

interface SaveAsProposalButtonProps {
  stash: string;
  path: string;
  body: string;
  baseVersion: number;
  author: string;
  message: string;
  disabled: boolean;
  state: ProposalSaveState;
  onBegin: () => boolean;
  onEnd: () => void;
  onFailure: (error: unknown, transport: boolean) => void;
  onProposed: (record: ProposalRecord) => void;
}

function SaveAsProposalButtonAllowed({
  stash,
  path,
  body,
  baseVersion,
  author,
  message,
  disabled,
  state,
  onBegin,
  onEnd,
  onFailure,
  onProposed,
}: SaveAsProposalButtonProps) {
  const clientForSignal = useStashClientForSignal();
  const pendingRef = useRef(false);
  const attemptRef = useRef<FrozenProposalAttempt | null>(null);
  const lifecycleRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
      pendingRef.current = false;
      attemptRef.current = null;
      controllerRef.current?.abort();
      controllerRef.current = null;
      onEnd();
    },
    [onEnd],
  );

  async function createProposal() {
    if (pendingRef.current || disabled || state.state === "created") {
      return;
    }
    const retryingTransport = state.state === "error" && state.transport;
    const attempt =
      retryingTransport && attemptRef.current !== null
        ? attemptRef.current
        : Object.freeze({
            input: Object.freeze({ path, body, baseVersion, author, message }),
            options: Object.freeze({ idempotencyKey: globalThis.crypto.randomUUID() }),
          });
    if (!onBegin()) return;
    attemptRef.current = attempt;
    pendingRef.current = true;
    setSubmitting(true);
    const lifecycle = lifecycleRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => lifecycleRef.current === lifecycle && !controller.signal.aborted;
    let created: ProposalRecord | null = null;

    try {
      const result = await clientForSignal(controller.signal)
        .proposals(stash)
        .create(attempt.input, attempt.options);
      if (!isCurrent()) return;
      if (result.ok) {
        attemptRef.current = null;
        created = result.value;
      } else {
        attemptRef.current = null;
        onFailure(result, false);
      }
    } catch (error: unknown) {
      if (isCurrent()) onFailure(error, true);
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setSubmitting(false);
        onEnd();
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }

    if (created !== null && isCurrent()) onProposed(created);
  }

  const retrying = state.state === "error" && state.transport;

  return (
    <Button
      disabled={disabled || submitting || state.state === "created"}
      onClick={() => void createProposal()}
    >
      {submitting
        ? retrying
          ? "Retrying proposal…"
          : "Saving proposal…"
        : state.state === "created"
          ? "Proposal saved"
          : retrying
            ? "Retry proposal"
            : "Save as proposal"}
    </Button>
  );
}

function SaveAsProposalButton(props: SaveAsProposalButtonProps) {
  const capability = useCanWrite(props.stash);
  if (!capability.ready || !capability.canWrite) return null;
  return <SaveAsProposalButtonAllowed {...props} />;
}

function readRememberedAuthor(): string {
  if (typeof window === "undefined") return "";
  try {
    return fitUtf8Bytes(window.localStorage.getItem(AUTHOR_STORAGE_KEY) ?? "", MAX_AUTHOR_BYTES);
  } catch {
    return "";
  }
}

function rememberAuthor(author: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTHOR_STORAGE_KEY, author);
  } catch {
    // The field remains usable when storage is blocked or full.
  }
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

function completionFrom(machine: SaveMachine): SaveReviewCompletion | null {
  if (machine.state === "saved") {
    return { state: "saved", version: machine.version, changeId: machine.changeId };
  }
  if (machine.state === "unchanged") {
    return { state: "unchanged", version: machine.version };
  }
  return null;
}

function sameCompletion(left: SaveReviewCompletion | null, right: SaveReviewCompletion): boolean {
  return (
    left?.state === right.state &&
    left.version === right.version &&
    (left.state !== "saved" || (right.state === "saved" && left.changeId === right.changeId))
  );
}

function keyForTargetIdentity(identity: object): number {
  const existing = targetIdentityKeys.get(identity);
  if (existing !== undefined) return existing;
  const key = nextTargetIdentityKey;
  nextTargetIdentityKey += 1;
  targetIdentityKeys.set(identity, key);
  return key;
}

function SaveReviewDialogOpen({
  stash,
  head,
  draft,
  lineEnding,
  machine,
  onClose,
  onDiscard,
  onSaved,
  onProposed,
}: Omit<SaveReviewDialogProps, "open">) {
  const titleId = useId();
  const descriptionId = useId();
  const messageId = useId();
  const messageCountId = useId();
  const authorId = useId();
  const authorCountId = useId();
  const [message, setMessage] = useState("");
  const [author, setAuthor] = useState(readRememberedAuthor);
  const [reloadedHead, setReloadedHead] = useState<FileRecordWithEtag | null>(null);
  const [sameSnapshot, setSameSnapshot] = useState<SameAsHeadSnapshot | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposalSave, setProposalSave] = useState<ProposalSaveState>({ state: "idle" });
  const lifecycleRef = useRef(0);
  const renderEpochRef = useRef(0);
  const hashSequenceRef = useRef(0);
  const pendingOperationRef = useRef<PendingOperation | null>(null);
  const proposalPendingRef = useRef(false);
  const completionArmedRef = useRef(false);
  const reportedCompletionRef = useRef<SaveReviewCompletion | null>(null);
  const machineStateRef = useRef(machine.state);
  const displayHead = reloadedHead ?? head;
  const exactDraft = applyLineEnding(draft, lineEnding);
  const saveDiff = useCandidateDiff({
    baseText: displayHead.body ?? "",
    draftText: exactDraft,
  });
  const preferences = useDiffViewPreferences();
  const sameAsHead =
    sameSnapshot?.draft === draft &&
    sameSnapshot.lineEnding === lineEnding &&
    sameSnapshot.headHash === displayHead.hash
      ? sameSnapshot.same
      : null;
  const nextVersion = displayHead.version + 1;
  const authorBytes = utf8ByteLength(author);
  const messageBytes = utf8ByteLength(message);
  const machineSaving = machine.state === "saving";
  const busy = machineSaving || reconciling || reloading || retrying || proposing;
  const proposalFrozen = proposalSave.state === "error" && proposalSave.transport;
  const fieldsDisabled =
    busy ||
    proposalFrozen ||
    machine.state === "error" ||
    machine.state === "saved" ||
    machine.state === "unchanged";

  const beginProposal = useCallback(() => {
    if (
      pendingOperationRef.current !== null ||
      proposalPendingRef.current ||
      machineStateRef.current !== "idle"
    ) {
      return false;
    }
    proposalPendingRef.current = true;
    setProposing(true);
    return true;
  }, []);

  const endProposal = useCallback(() => {
    proposalPendingRef.current = false;
    setProposing(false);
  }, []);

  useLayoutEffect(() => {
    renderEpochRef.current += 1;
  }, [displayHead.hash, displayHead.path, displayHead.version, draft, lineEnding]);

  useLayoutEffect(() => {
    machineStateRef.current = machine.state;
  }, [machine.state]);

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
      hashSequenceRef.current += 1;
      pendingOperationRef.current = null;
      proposalPendingRef.current = false;
      completionArmedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const sequence = ++hashSequenceRef.current;
    let active = true;
    const draftAtRequest = draft;
    const lineEndingAtRequest = lineEnding;
    const headHashAtRequest = displayHead.hash;

    void sha256Hex(applyLineEnding(draftAtRequest, lineEndingAtRequest)).then((hash) => {
      if (!active || hashSequenceRef.current !== sequence) return;
      setSameSnapshot({
        draft: draftAtRequest,
        lineEnding: lineEndingAtRequest,
        headHash: headHashAtRequest,
        same: headHashAtRequest !== null && hash === headHashAtRequest,
      });
    });

    return () => {
      active = false;
    };
  }, [displayHead.hash, draft, lineEnding]);

  useEffect(() => {
    const completion = completionFrom(machine);
    if (completion === null || !completionArmedRef.current) return;
    completionArmedRef.current = false;
    if (pendingOperationRef.current === "save" || pendingOperationRef.current === "retry") {
      pendingOperationRef.current = null;
    }
    if (sameCompletion(reportedCompletionRef.current, completion)) return;
    reportedCompletionRef.current = completion;
    onSaved(completion);
  }, [machine, onSaved]);

  useEffect(() => {
    if (machine.state === "error" || machine.state === "stale") {
      completionArmedRef.current = false;
      if (pendingOperationRef.current === "save" || pendingOperationRef.current === "retry") {
        pendingOperationRef.current = null;
      }
    }
  }, [machine.state]);

  function requestClose() {
    if (
      pendingOperationRef.current !== null ||
      proposalPendingRef.current ||
      machine.state === "saving"
    ) {
      return;
    }
    if (!machine.resetSession()) return;
    onClose();
  }

  function requestDiscard() {
    if (
      pendingOperationRef.current !== null ||
      proposalPendingRef.current ||
      machine.state === "saving"
    ) {
      return;
    }
    if (!machine.resetSession()) return;
    onDiscard();
  }

  async function saveFresh(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      machine.state !== "idle" ||
      sameAsHead !== false ||
      proposalFrozen ||
      busy ||
      pendingOperationRef.current !== null ||
      proposalPendingRef.current ||
      authorBytes > MAX_AUTHOR_BYTES ||
      messageBytes > MAX_MESSAGE_BYTES
    ) {
      return;
    }

    const lifecycle = lifecycleRef.current;
    const renderEpoch = renderEpochRef.current;
    const metadata = { author, message };
    pendingOperationRef.current = "save";
    completionArmedRef.current = true;
    setReconciling(true);

    try {
      const unchanged = await machine.reconcile();
      if (lifecycleRef.current !== lifecycle || renderEpochRef.current !== renderEpoch) {
        completionArmedRef.current = false;
        if (pendingOperationRef.current === "save") pendingOperationRef.current = null;
        return;
      }
      if (unchanged) return;
      if (machineStateRef.current !== "idle") {
        completionArmedRef.current = false;
        if (pendingOperationRef.current === "save") pendingOperationRef.current = null;
        return;
      }
      await machine.save(metadata);
    } catch {
      completionArmedRef.current = false;
      if (pendingOperationRef.current === "save") pendingOperationRef.current = null;
    } finally {
      if (lifecycleRef.current === lifecycle) {
        setReconciling(false);
      }
    }
  }

  async function reloadAndCompare() {
    if (
      machine.state !== "stale" ||
      busy ||
      pendingOperationRef.current !== null ||
      proposalPendingRef.current
    ) {
      return;
    }
    const lifecycle = lifecycleRef.current;
    pendingOperationRef.current = "reload";
    setReloading(true);
    try {
      const record = await machine.reloadAndCompare();
      if (lifecycleRef.current === lifecycle) setReloadedHead(record);
    } catch {
      // useSaveMachine exposes the request failure through its error state.
    } finally {
      if (lifecycleRef.current === lifecycle) {
        if (pendingOperationRef.current === "reload") pendingOperationRef.current = null;
        setReloading(false);
      }
    }
  }

  async function retryFrozenAttempt() {
    if (
      machine.state !== "error" ||
      !machine.canRetry ||
      busy ||
      pendingOperationRef.current !== null ||
      proposalPendingRef.current
    ) {
      return;
    }
    const lifecycle = lifecycleRef.current;
    pendingOperationRef.current = "retry";
    completionArmedRef.current = true;
    setRetrying(true);
    try {
      await machine.retry();
    } catch {
      completionArmedRef.current = false;
      if (pendingOperationRef.current === "retry") pendingOperationRef.current = null;
    } finally {
      if (lifecycleRef.current === lifecycle) {
        setRetrying(false);
      }
    }
  }

  const primaryLabel = reloadedHead
    ? `Save v${nextVersion} on top of v${displayHead.version}`
    : `Save v${nextVersion}`;

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-save-review-dialog"
      open={true}
      onClose={requestClose}
    >
      <form
        aria-busy={busy ? "true" : undefined}
        className="zhs-save-review-dialog__form"
        onSubmit={saveFresh}
      >
        <header className="zhs-save-review-dialog__header">
          <div>
            <p className="zhs-save-review-dialog__eyebrow">Compare-and-swap save</p>
            <h2 className="zhs-save-review-dialog__title" id={titleId}>
              Review save against head v{displayHead.version}
            </h2>
          </div>
          <Button aria-label="Close save review" disabled={busy} size="sm" onClick={requestClose}>
            Close
          </Button>
        </header>

        <div className="zhs-save-review-dialog__body">
          {machine.state === "stale" ? (
            <Notice className="zhs-save-review-dialog__notice" variant="warning">
              <strong>
                Head moved to v{machine.current.version} by{" "}
                {machine.current.author || "unknown author"}
              </strong>
              <p>
                Reload the current head and review this draft against it. A stale save is never
                retried automatically.
              </p>
            </Notice>
          ) : reloadedHead ? (
            <Notice className="zhs-save-review-dialog__notice" variant="info">
              <strong>
                Head moved to v{reloadedHead.version} by {reloadedHead.author || "unknown author"}
              </strong>
              {reloadedHead.message ? <p>{reloadedHead.message}</p> : null}
            </Notice>
          ) : null}

          {machine.state === "error" ? (
            <Notice className="zhs-save-review-dialog__notice" variant="error">
              <strong>Could not save this draft</strong>
              <p>{machine.message}</p>
              {machine.canRetry ? (
                <p>The exact frozen request can be retried without creating a new attempt.</p>
              ) : null}
            </Notice>
          ) : null}

          {machine.state === "unchanged" ? (
            <Notice className="zhs-save-review-dialog__notice" variant="info">
              <strong>No write was needed</strong>
              <p>The draft already matches head v{machine.version}.</p>
            </Notice>
          ) : null}

          {machine.state === "saved" ? (
            <Notice className="zhs-save-review-dialog__notice" variant="success">
              <strong>Saved v{machine.version}</strong>
            </Notice>
          ) : null}

          {proposalSave.state === "created" ? (
            <Notice className="zhs-save-review-dialog__notice" variant="success">
              <strong>Proposal saved</strong>
              <p>
                {proposalSave.record.id} is fenced to v{proposalSave.record.baseVersion}.
              </p>
            </Notice>
          ) : null}

          {proposalSave.state === "error" ? (
            <ErrorBanner
              error={proposalSave.error}
              title={
                proposalSave.transport
                  ? "The proposal response was interrupted"
                  : "Could not save this proposal"
              }
            />
          ) : null}

          <section className="zhs-save-review-dialog__review" aria-label="Save diff">
            <div className="zhs-save-review-dialog__toolbar">
              <DiffControls
                isNarrow={preferences.isNarrow}
                marks={preferences.marks}
                preferredLayout={preferences.preferredLayout}
                setMarks={preferences.setMarks}
                setPreferredLayout={preferences.setPreferredLayout}
                setWrap={preferences.setWrap}
                wrap={preferences.wrap}
              />
              <p className="zhs-save-review-dialog__stats" aria-live="polite">
                <span className="zhs-save-review-dialog__stats-add">+{saveDiff.stats.added}</span>
                <span className="zhs-save-review-dialog__stats-remove">
                  −{saveDiff.stats.removed}
                </span>
                <span>vs head v{displayHead.version}</span>
              </p>
            </div>

            <div className="zhs-save-review-dialog__diff">
              {saveDiff.model ? (
                <DiffPane
                  fromLabel={`head v${displayHead.version}`}
                  layout={preferences.effectiveLayout}
                  marks={preferences.marks}
                  model={saveDiff.model}
                  toLabel="draft"
                  wrap={preferences.wrap}
                />
              ) : saveDiff.oversized ? (
                <Notice variant="warning">The save diff is too large to preview.</Notice>
              ) : (
                <Notice variant="info">No line changes to preview.</Notice>
              )}
            </div>
          </section>

          <p className="zhs-save-review-dialog__cas" id={descriptionId}>
            Saves as v{nextVersion} on top of v{displayHead.version} — the head is re-checked on
            save. Line endings: {lineEnding === "crlf" ? "CRLF" : "LF"}.
          </p>

          <div className="zhs-save-review-dialog__metadata">
            <div className="zhs-save-review-dialog__field">
              <label htmlFor={messageId}>Message</label>
              <Textarea
                aria-describedby={messageCountId}
                disabled={fieldsDisabled}
                id={messageId}
                name="message"
                rows={3}
                value={message}
                onChange={(event) =>
                  setMessage(fitUtf8Bytes(event.currentTarget.value, MAX_MESSAGE_BYTES))
                }
              />
              <span className="zhs-save-review-dialog__byte-count" id={messageCountId}>
                {messageBytes} / {MAX_MESSAGE_BYTES} UTF-8 bytes
              </span>
            </div>

            <div className="zhs-save-review-dialog__field">
              <label htmlFor={authorId}>Author</label>
              <Input
                aria-describedby={authorCountId}
                autoComplete="name"
                disabled={fieldsDisabled}
                id={authorId}
                name="author"
                value={author}
                onChange={(event) => {
                  const nextAuthor = fitUtf8Bytes(event.currentTarget.value, MAX_AUTHOR_BYTES);
                  setAuthor(nextAuthor);
                  rememberAuthor(nextAuthor);
                }}
              />
              <span className="zhs-save-review-dialog__byte-count" id={authorCountId}>
                {authorBytes} / {MAX_AUTHOR_BYTES} UTF-8 bytes
              </span>
            </div>
          </div>
        </div>

        <footer className="zhs-save-review-dialog__actions">
          {machine.state === "stale" ? (
            <>
              <Button disabled={busy} onClick={() => void reloadAndCompare()}>
                {reloading ? "Reloading…" : "Reload & compare"}
              </Button>
              <Button disabled={busy} variant="danger" onClick={requestDiscard}>
                Discard
              </Button>
            </>
          ) : machine.state === "error" ? (
            <>
              <Button disabled={busy} onClick={requestClose}>
                Close
              </Button>
              {machine.canRetry ? (
                <Button disabled={busy} variant="primary" onClick={() => void retryFrozenAttempt()}>
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
            </>
          ) : machine.state === "saved" || machine.state === "unchanged" ? (
            <Button disabled={busy} onClick={requestClose}>
              Close
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={requestClose}>
                Cancel
              </Button>
              {stash === undefined ? null : (
                <SaveAsProposalButton
                  author={author}
                  baseVersion={displayHead.version}
                  body={exactDraft}
                  disabled={busy}
                  message={message}
                  path={displayHead.path}
                  stash={stash}
                  state={proposalSave}
                  onBegin={beginProposal}
                  onEnd={endProposal}
                  onFailure={(error, transport) =>
                    setProposalSave({ state: "error", error, transport })
                  }
                  onProposed={(record) => {
                    setProposalSave({ state: "created", record });
                    onProposed?.(record);
                  }}
                />
              )}
              <Button
                disabled={busy || proposalFrozen || sameAsHead !== false}
                type="submit"
                variant="primary"
              >
                {machineSaving
                  ? `Saving v${nextVersion}…`
                  : reconciling
                    ? "Re-checking head…"
                    : primaryLabel}
              </Button>
            </>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

export function SaveReviewDialog(props: SaveReviewDialogProps) {
  if (!props.open) return null;
  const targetKey = JSON.stringify([
    keyForTargetIdentity(props.machine.targetIdentity),
    props.head.path,
    props.head.version,
    props.head.hash,
  ]);
  return <SaveReviewDialogOpen key={targetKey} {...props} />;
}
