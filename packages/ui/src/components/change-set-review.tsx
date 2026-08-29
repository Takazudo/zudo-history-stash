import {
  isCommitConflict,
  type ChangeSetDiffResult,
  type ChangeSetRecord,
  type CommitConflict,
} from "@takazudo/zudo-history-stash";
import {
  buildDiffModel,
  MAX_AUTHOR_BYTES,
  MAX_MESSAGE_BYTES,
  utf8ByteLength,
} from "@takazudo/zudo-history-stash-core";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useDiffViewPreferences } from "../hooks/use-diff-view-preferences.js";
import {
  Anchor,
  useStashClient,
  useStashClientForSignal,
  useStashHref,
} from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

export interface ChangeSetReviewProps {
  stash: string;
  changeSet: ChangeSetRecord;
  onDecision?: (changeSet: ChangeSetRecord) => void;
}
type DiffState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; value: ChangeSetDiffResult };

function fitUtf8Bytes(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value;
  let fitted = "";
  for (const character of value) {
    if (utf8ByteLength(fitted + character) > maximum) break;
    fitted += character;
  }
  return fitted;
}

function ChangeSetDiffEntry({
  entry,
  preferences,
}: {
  entry: ChangeSetDiffResult["entries"][number];
  preferences: ReturnType<typeof useDiffViewPreferences>;
}) {
  const diff = entry.diff;
  const model = diff.state === "ready" ? buildDiffModel(diff.hunks) : null;
  return (
    <article className="zhs-diff-entry" data-diff-path={entry.path}>
      <div className="zhs-diff-entry__heading">
        <h3>
          <PathText value={entry.path} />
        </h3>
        <span>
          {entry.op} {entry.stale ? <span className="zhs-stale-badge">stale</span> : null}
        </span>
      </div>
      <div className="zhs-diff-entry__body">
        {entry.candidate === null || entry.op === "delete" ? (
          <div className="zhs-diff-entry__tombstone">Candidate deletes this path</div>
        ) : diff.state === "binary" || entry.op === "copy" ? (
          <div className="zhs-diff-entry__metadata">
            <strong>{entry.op === "copy" ? "Copied file" : "Binary file"}</strong>
            <p>
              Candidate v{entry.candidate.version} · {entry.candidate.hash ?? "no content hash"}
            </p>
          </div>
        ) : model ? (
          <DiffPane
            fromLabel={entry.base ? `base v${entry.base.version}` : "empty"}
            toLabel="candidate"
            model={model}
            layout={preferences.effectiveLayout}
            marks={preferences.marks}
            wrap={preferences.wrap}
          />
        ) : diff.state === "same" ? (
          <Notice variant="info">No line changes.</Notice>
        ) : (
          <Notice variant="warning">Diff preview is too large.</Notice>
        )}
      </div>
    </article>
  );
}

function LazyChangeSetEntry({
  stash,
  id,
  path,
  preferences,
}: {
  stash: string;
  id: string;
  path: string;
  preferences: ReturnType<typeof useDiffViewPreferences>;
}) {
  const clientForSignal = useStashClientForSignal();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<DiffState>({ state: "loading" });
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.target === node && entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void clientForSignal(controller.signal)
      .changeSets(stash)
      .diff(id, { path })
      .then((result) => {
        if (!controller.signal.aborted)
          setState(
            result.ok ? { state: "ready", value: result.value } : { state: "error", error: result },
          );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [clientForSignal, id, path, stash, visible]);
  const entry = state.state === "ready" ? state.value.entries[0] : undefined;
  return (
    <div ref={ref} data-lazy-diff-path={path}>
      {entry ? (
        <ChangeSetDiffEntry entry={entry} preferences={preferences} />
      ) : state.state === "error" ? (
        <ErrorBanner error={state.error} title={`Could not load ${path}`} />
      ) : (
        <p role="status">
          Loading diff for <PathText value={path} />…
        </p>
      )}
    </div>
  );
}

function DecisionDialog({
  kind,
  stash,
  changeSet,
  onClose,
  onDecision,
}: {
  kind: "approve" | "reject";
  stash: string;
  changeSet: ChangeSetRecord;
  onClose: () => void;
  onDecision: (record: ChangeSetRecord) => void;
}) {
  const client = useStashClient();
  const titleId = useId();
  const authorCountId = useId();
  const messageCountId = useId();
  const reasonCountId = useId();
  const [author, setAuthor] = useState("");
  const [message, setMessage] = useState(changeSet.message);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<unknown | null>(null);
  const [conflicts, setConflicts] = useState<CommitConflict[]>([]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    setConflicts([]);
    try {
      if (kind === "approve") {
        const result = await client.changeSets(stash).approve(changeSet.id, { author, message });
        if (!result.ok) {
          if (isCommitConflict(result)) setConflicts(result.conflicts);
          else setError(result);
        } else {
          const decided = await client.changeSets(stash).get(changeSet.id);
          if (!decided.ok) setError(decided);
          else onDecision(decided.value);
        }
      } else {
        const result = await client
          .changeSets(stash)
          .reject(changeSet.id, { ...(reason ? { reason } : {}) });
        if (!result.ok) setError(result);
        else onDecision(result.value);
      }
    } catch (failure) {
      setError(failure);
    } finally {
      submittingRef.current = false;
      setBusy(false);
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
        <h2 id={titleId}>{kind === "approve" ? "Approve change set" : "Reject change set"}</h2>
        <p>This decision is permanent and will be recorded with the change set.</p>
        {conflicts.length ? (
          <Notice variant="error">
            <strong>Some paths are stale.</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.path}>
                  <PathText value={conflict.path} /> — now{" "}
                  {conflict.current ? `v${conflict.current.version}` : "missing"}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {error ? <ErrorBanner error={error} title={`Could not ${kind} change set`} /> : null}
        {kind === "approve" ? (
          <>
            <label className="zhs-decision-dialog__field">
              Author
              <Input
                aria-label="Author"
                aria-describedby={authorCountId}
                disabled={busy}
                value={author}
                onChange={(event) =>
                  setAuthor(fitUtf8Bytes(event.currentTarget.value, MAX_AUTHOR_BYTES))
                }
              />
              <span id={authorCountId}>
                {utf8ByteLength(author)} / {MAX_AUTHOR_BYTES} UTF-8 bytes
              </span>
            </label>
            <label className="zhs-decision-dialog__field">
              Commit message
              <Textarea
                aria-label="Commit message"
                aria-describedby={messageCountId}
                disabled={busy}
                value={message}
                rows={3}
                onChange={(event) =>
                  setMessage(fitUtf8Bytes(event.currentTarget.value, MAX_MESSAGE_BYTES))
                }
              />
              <span id={messageCountId}>
                {utf8ByteLength(message)} / {MAX_MESSAGE_BYTES} UTF-8 bytes
              </span>
            </label>
          </>
        ) : (
          <label className="zhs-decision-dialog__field">
            Reason (optional)
            <Textarea
              aria-label="Reason (optional)"
              aria-describedby={reasonCountId}
              disabled={busy}
              value={reason}
              rows={3}
              onChange={(event) =>
                setReason(fitUtf8Bytes(event.currentTarget.value, MAX_MESSAGE_BYTES))
              }
            />
            <span id={reasonCountId}>
              {utf8ByteLength(reason)} / {MAX_MESSAGE_BYTES} UTF-8 bytes
            </span>
          </label>
        )}
        <div className="zhs-decision-actions">
          <Button
            disabled={busy}
            onClick={() => {
              if (!submittingRef.current) onClose();
            }}
          >
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant={kind === "reject" ? "danger" : "primary"}>
            {busy
              ? `${kind === "approve" ? "Approving" : "Rejecting"}…`
              : kind === "approve"
                ? "Approve and apply"
                : "Reject"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangeSetReviewTarget({ stash, changeSet: initial, onDecision }: ChangeSetReviewProps) {
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const preferences = useDiffViewPreferences();
  const [changeSet, setChangeSet] = useState(initial);
  const [state, setState] = useState<DiffState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: "loading" });
    void clientForSignal(controller.signal)
      .changeSets(stash)
      .diff(changeSet.id)
      .then((result) => {
        if (!controller.signal.aborted)
          setState(
            result.ok ? { state: "ready", value: result.value } : { state: "error", error: result },
          );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [attempt, changeSet.id, clientForSignal, stash]);
  const inline = useMemo(
    () =>
      new Map(
        state.state === "ready" ? state.value.entries.map((entry) => [entry.path, entry]) : [],
      ),
    [state],
  );
  const stale =
    changeSet.entries.some((entry) => entry.stale) ||
    (state.state === "ready" && state.value.stale);
  function decided(record: ChangeSetRecord) {
    setChangeSet(record);
    setDialog(null);
    onDecision?.(record);
  }
  return (
    <section className="zhs-section-card zhs-diff-page" aria-labelledby="change-set-review-title">
      <header className="zhs-diff-page__header">
        <h2 id="change-set-review-title">{changeSet.message || "Untitled change set"}</h2>
        <p>
          {changeSet.author || changeSet.createdBy || "Unknown author"} ·{" "}
          <RelativeTime value={changeSet.createdAt} /> ·{" "}
          <span className={`zhs-status-badge zhs-status-badge--${changeSet.status}`}>
            {changeSet.status}
          </span>
        </p>
        <p>
          {changeSet.entries.length} {changeSet.entries.length === 1 ? "entry" : "entries"}
        </p>
      </header>
      {stale ? (
        <Notice variant="warning">
          <strong>This change set contains stale entries.</strong> Review every stale path before
          deciding.
        </Notice>
      ) : null}
      <div className="zhs-diff-page__toolbar">
        <DiffControls {...preferences} />
      </div>
      {state.state === "loading" ? (
        <p className="zhs-record-list__empty" role="status">
          Loading change-set diff…
        </p>
      ) : state.state === "error" ? (
        <ErrorBanner
          error={state.error}
          onRetry={() => setAttempt((value) => value + 1)}
          title="Could not load change-set diff"
        />
      ) : (
        <div className="zhs-diff-stack">
          {changeSet.entries.map((record) => {
            const entry = inline.get(record.path);
            return entry ? (
              <ChangeSetDiffEntry key={record.path} entry={entry} preferences={preferences} />
            ) : (
              <LazyChangeSetEntry
                key={record.path}
                stash={stash}
                id={changeSet.id}
                path={record.path}
                preferences={preferences}
              />
            );
          })}
        </div>
      )}
      {changeSet.status === "open" ? (
        <div className="zhs-decision-actions">
          <Button variant="danger" onClick={() => setDialog("reject")}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => setDialog("approve")}>
            Approve
          </Button>
        </div>
      ) : (
        <div className="zhs-decision-record">
          <strong>Decision: {changeSet.status}</strong>
          <p>
            {changeSet.decidedBy ? `By ${changeSet.decidedBy}` : ""}
            {changeSet.decidedAt ? ` at ${changeSet.decidedAt}` : ""}
          </p>
          {changeSet.decisionReason ? <p>{changeSet.decisionReason}</p> : null}
          {changeSet.commitId ? (
            <p>
              Applied as{" "}
              <Anchor href={hrefFor({ kind: "commit", stash, id: changeSet.commitId })}>
                {changeSet.commitId}
              </Anchor>
            </p>
          ) : null}
        </div>
      )}
      {dialog ? (
        <DecisionDialog
          kind={dialog}
          stash={stash}
          changeSet={changeSet}
          onClose={() => setDialog(null)}
          onDecision={decided}
        />
      ) : null}
    </section>
  );
}

export function ChangeSetReview(props: ChangeSetReviewProps) {
  return <ChangeSetReviewTarget key={`${props.stash}:${props.changeSet.id}`} {...props} />;
}
