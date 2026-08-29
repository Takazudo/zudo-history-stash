import type { ChangeSetDiffResult, ChangeSetRecord } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import {
  ChangeSetReview,
  DiffControls,
  DiffPane,
  Notice,
  RelativeTime,
  useCanWrite,
  useDiffViewPreferences,
  useStashClientForSignal,
  useStashHref,
  type DiffViewPreferences,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { useAsync } from "../hooks/use-async.js";
import { commitCreatedLocationState } from "./commit.js";

type ReadOnlyDiffState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; value: ChangeSetDiffResult };

function ReadOnlyEntry({
  entry,
  preferences,
}: {
  entry: ChangeSetDiffResult["entries"][number];
  preferences: DiffViewPreferences;
}) {
  const model = entry.diff.state === "ready" ? buildDiffModel(entry.diff.hunks) : null;
  return (
    <article className="zhs-diff-entry" data-diff-path={entry.path}>
      <div className="zhs-diff-entry__heading">
        <h3>
          <span className="path-cell">{entry.path}</span>
        </h3>
        <span>
          {entry.op} {entry.stale ? <span className="zhs-stale-badge">stale</span> : null}
        </span>
      </div>
      <div className="zhs-diff-entry__body">
        {entry.candidate === null || entry.op === "delete" ? (
          <div className="zhs-diff-entry__tombstone">Candidate deletes this path</div>
        ) : entry.diff.state === "binary" || entry.op === "copy" ? (
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
        ) : entry.diff.state === "same" ? (
          <Notice variant="info">No line changes.</Notice>
        ) : (
          <Notice variant="warning">Diff preview is too large.</Notice>
        )}
      </div>
    </article>
  );
}

function ReadOnlyLazyEntry({
  stash,
  id,
  path,
  preferences,
}: {
  stash: string;
  id: string;
  path: string;
  preferences: DiffViewPreferences;
}) {
  const clientForSignal = useStashClientForSignal();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadOnlyDiffState>({ state: "loading" });

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.target === node && entry.isIntersecting)) {
        setVisible(true);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setState({ state: "loading" });
    void clientForSignal(controller.signal)
      .changeSets(stash)
      .diff(id, { path })
      .then((result) => {
        if (!controller.signal.aborted) {
          setState(
            result.ok ? { state: "ready", value: result.value } : { state: "error", error: result },
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [attempt, clientForSignal, id, path, stash, visible]);

  const entry = state.state === "ready" ? state.value.entries[0] : undefined;
  return (
    <div ref={ref} data-lazy-diff-path={path}>
      {entry ? (
        <ReadOnlyEntry entry={entry} preferences={preferences} />
      ) : state.state === "error" ? (
        <ErrorBanner
          error={state.error}
          onRetry={() => setAttempt((value) => value + 1)}
          title={`Could not load ${path}`}
        />
      ) : state.state === "ready" ? (
        <Notice variant="warning">No diff was returned for {path}.</Notice>
      ) : (
        <p role="status">Loading diff for {path}…</p>
      )}
    </div>
  );
}

function DecisionRecord({ stash, changeSet }: { stash: string; changeSet: ChangeSetRecord }) {
  const hrefFor = useStashHref();
  if (changeSet.status === "open") {
    return (
      <Notice variant="info">Write access is required to approve or reject this change set.</Notice>
    );
  }
  return (
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
          <Link to={hrefFor({ kind: "commit", stash, id: changeSet.commitId })}>
            {changeSet.commitId}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function ReadOnlyChangeSetReview({
  stash,
  changeSet,
}: {
  stash: string;
  changeSet: ChangeSetRecord;
}) {
  const clientForSignal = useStashClientForSignal();
  const preferences = useDiffViewPreferences();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadOnlyDiffState>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: "loading" });
    void clientForSignal(controller.signal)
      .changeSets(stash)
      .diff(changeSet.id)
      .then((result) => {
        if (!controller.signal.aborted) {
          setState(
            result.ok ? { state: "ready", value: result.value } : { state: "error", error: result },
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ state: "error", error });
      });
    return () => controller.abort();
  }, [attempt, changeSet.id, clientForSignal, stash]);
  const stale =
    changeSet.entries.some((entry) => entry.stale) ||
    (state.state === "ready" && state.value.stale);
  const inlineEntries = useMemo(
    () =>
      new Map(
        state.state === "ready" ? state.value.entries.map((entry) => [entry.path, entry]) : [],
      ),
    [state],
  );
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
            const entry = inlineEntries.get(record.path);
            return entry ? (
              <ReadOnlyEntry key={record.path} entry={entry} preferences={preferences} />
            ) : (
              <ReadOnlyLazyEntry
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
      <DecisionRecord stash={stash} changeSet={changeSet} />
    </section>
  );
}

function writableReviewKey(stash: string, record: ChangeSetRecord): string {
  return `${stash}:${record.id}:${JSON.stringify({
    status: record.status,
    decidedAt: record.decidedAt,
    entries: record.entries.map((entry) => ({
      path: entry.path,
      op: entry.op,
      baseVersion: entry.baseVersion,
      currentVersion: entry.current?.version ?? null,
      currentHash: entry.current?.hash ?? null,
      currentDeleted: entry.current?.deleted ?? null,
      stale: entry.stale,
    })),
  })}`;
}

export default function ChangeSetPage() {
  const { stash, id } = useParams();
  const { client } = useStashClient();
  const hrefFor = useStashHref();
  const navigate = useNavigate();
  const capability = useCanWrite(stash ?? "");
  const changeSet = useAsync<ChangeSetRecord | null>(
    async (signal) => {
      if (!client || !stash || !id) return null;
      return clientValue(client.withSignal(signal).changeSets(stash).get(id));
    },
    [client, id, stash],
  );
  const reloadChangeSet = changeSet.reload;

  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        await reloadChangeSet(signal);
      },
      [reloadChangeSet],
    ),
  );

  function handleDecision(record: ChangeSetRecord) {
    if (record.status === "applied" && record.commitId && stash) {
      navigate(hrefFor({ kind: "commit", stash, id: record.commitId }), {
        state: commitCreatedLocationState(record.commitId, "approval"),
      });
      return;
    }
    void changeSet.reload().catch(() => undefined);
  }

  const target = stash && id ? `${stash}:${id}` : null;
  const [retainedRecord, setRetainedRecord] = useState<{
    target: string;
    value: ChangeSetRecord;
  } | null>(null);
  const readyRecord = changeSet.state === "ready" ? changeSet.value : null;
  useEffect(() => {
    if (readyRecord !== null && target !== null) {
      setRetainedRecord({ target, value: readyRecord });
    }
  }, [readyRecord, target]);
  const record =
    changeSet.state === "ready"
      ? changeSet.value
      : retainedRecord?.target === target
        ? retainedRecord.value
        : null;
  return (
    <Page
      title="Change set"
      description={
        stash ? `Review a staged change set in ${stash}.` : "Review a staged change set."
      }
      actions={
        stash ? (
          <Link
            className="zhs-button zhs-button--secondary"
            to={hrefFor({ kind: "change-sets", stash })}
          >
            All change sets
          </Link>
        ) : null
      }
    >
      {!stash || !id ? (
        <ErrorBanner
          error={new Error("The stash name or change-set id is missing from this URL.")}
        />
      ) : changeSet.state === "loading" && record === null ? (
        <p className="loading-copy" role="status">
          Loading change set…
        </p>
      ) : changeSet.state === "error" ? (
        <ErrorBanner
          error={changeSet.error}
          onRetry={() => void changeSet.reload().catch(() => undefined)}
          title="Could not load change set"
        />
      ) : record === null ? (
        <ErrorBanner
          error={new Error("The change-set response was empty.")}
          title="Could not load change set"
        />
      ) : !capability.ready ? (
        <p className="loading-copy" role="status">
          Checking change-set access…
        </p>
      ) : capability.canWrite ? (
        <ChangeSetReview
          key={writableReviewKey(stash, record)}
          stash={stash}
          changeSet={record}
          onDecision={handleDecision}
        />
      ) : (
        <ReadOnlyChangeSetReview
          key={`${stash}:${record.id}:${record.status}:${record.decidedAt ?? ""}`}
          stash={stash}
          changeSet={record}
        />
      )}
    </Page>
  );
}
