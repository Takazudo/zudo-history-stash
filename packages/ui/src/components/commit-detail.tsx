import type { CommitDiffEntry, CommitDiffResult, CommitRecord } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDiffViewPreferences } from "../hooks/use-diff-view-preferences.js";
import { Anchor, useStashClientForSignal, useStashHref } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Notice } from "../primitives/notice.js";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

export interface CommitDetailProps {
  stash: string;
  commit: CommitRecord;
  onRevert?: () => void;
}

type DiffState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; value: CommitDiffResult };

function DiffEntryView({
  entry,
  commit,
  preferences,
}: {
  entry: CommitDiffEntry;
  commit: CommitRecord;
  preferences: ReturnType<typeof useDiffViewPreferences>;
}) {
  const record = commit.entries.find((candidate) => candidate.path === entry.path);
  const isCopy = record?.op === "copy";
  const diff = entry.diff;
  const model = diff.state === "ready" ? buildDiffModel(diff.hunks) : null;
  const fromLabel = entry.from ? `v${entry.from.version}` : "empty";
  const toLabel = `v${entry.to.version}`;
  return (
    <article className="zhs-diff-entry" data-diff-path={entry.path}>
      <div className="zhs-diff-entry__heading">
        <h3>
          <PathText value={entry.path} />
        </h3>
        <span>
          {entry.op}
          {entry.from === null ? " · created" : ""}
        </span>
      </div>
      <div className="zhs-diff-entry__body">
        {entry.op === "delete" ? (
          <div className="zhs-diff-entry__tombstone">Deleted at v{entry.to.version}</div>
        ) : isCopy || diff.state === "binary" ? (
          <div className="zhs-diff-entry__metadata">
            <strong>{isCopy ? "Copied file" : "Binary file"}</strong>
            {record?.copiedFrom ? (
              <p>
                From {record.copiedFrom.path} at v{record.copiedFrom.version}
              </p>
            ) : null}
            <p>
              {record?.contentType ?? "Unknown content type"} · {record?.size ?? 0} bytes
            </p>
          </div>
        ) : model ? (
          <DiffPane
            fromLabel={fromLabel}
            toLabel={toLabel}
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

function LazyCommitEntry({
  stash,
  commit,
  path,
  preferences,
}: {
  stash: string;
  commit: CommitRecord;
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
      .commits(stash)
      .diff(commit.id, { path })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) setState({ state: "error", error: result });
        else setState({ state: "ready", value: result.value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [clientForSignal, commit.id, path, stash, visible]);
  const entry = state.state === "ready" ? state.value.entries[0] : undefined;
  return (
    <div ref={ref} data-lazy-diff-path={path}>
      {entry ? (
        <DiffEntryView entry={entry} commit={commit} preferences={preferences} />
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

function CommitDetailForTarget({ stash, commit, onRevert }: CommitDetailProps) {
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const preferences = useDiffViewPreferences();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DiffState>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: "loading" });
    // The unfiltered request is deliberately shared by every inline entry.
    void clientForSignal(controller.signal)
      .commits(stash)
      .diff(commit.id)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) setState({ state: "error", error: result });
        else setState({ state: "ready", value: result.value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [attempt, clientForSignal, commit.id, stash]);

  const inlineByPath = useMemo(
    () =>
      new Map(
        state.state === "ready" ? state.value.entries.map((entry) => [entry.path, entry]) : [],
      ),
    [state],
  );
  return (
    <section className="zhs-section-card zhs-diff-page" aria-labelledby="commit-detail-title">
      <header className="zhs-diff-page__header">
        <h2 id="commit-detail-title">{commit.message || "Untitled commit"}</h2>
        <p>
          {commit.author || commit.createdBy || "Unknown author"} ·{" "}
          <RelativeTime value={commit.createdAt} /> ·{" "}
          <span className="zhs-source-badge">{commit.source}</span>
        </p>
        <p>
          {commit.entryCount} {commit.entryCount === 1 ? "entry" : "entries"} ·{" "}
          <code>{commit.id}</code>
        </p>
        {commit.revertsCommitId ? (
          <p>
            Reverts{" "}
            <Anchor href={hrefFor({ kind: "commit", stash, id: commit.revertsCommitId })}>
              {commit.revertsCommitId}
            </Anchor>
          </p>
        ) : null}
        {onRevert ? (
          <div>
            <Button variant="danger" onClick={onRevert}>
              Revert commit
            </Button>
          </div>
        ) : null}
      </header>
      <div className="zhs-diff-page__toolbar">
        <DiffControls {...preferences} />
      </div>
      {state.state === "error" ? (
        <ErrorBanner
          error={state.error}
          onRetry={() => setAttempt((value) => value + 1)}
          title="Could not load commit diff"
        />
      ) : state.state === "loading" ? (
        <p className="zhs-record-list__empty" role="status">
          Loading commit diff…
        </p>
      ) : (
        <div className="zhs-diff-stack">
          {commit.entries.map((record) => {
            const entry = inlineByPath.get(record.path);
            return entry ? (
              <DiffEntryView
                key={record.path}
                entry={entry}
                commit={commit}
                preferences={preferences}
              />
            ) : (
              <LazyCommitEntry
                key={record.path}
                stash={stash}
                commit={commit}
                path={record.path}
                preferences={preferences}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

export function CommitDetail(props: CommitDetailProps) {
  return <CommitDetailForTarget key={`${props.stash}:${props.commit.id}`} {...props} />;
}
