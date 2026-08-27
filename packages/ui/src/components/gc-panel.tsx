import type { GcKind, GcRunResult, RunGcBody } from "@takazudo/zudo-history-stash";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Select } from "../primitives/select.js";
import { useIsAdmin, useStashClientForSignal } from "../provider/hooks.js";
import { ErrorBanner, stashErrorDetails } from "./error-banner.js";

const RECENT_LIMIT = 10;

export interface GcPanelProps {
  className?: string;
}

function maxObjectsValue(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
}

function mergeRecentRuns(
  kind: GcKind,
  pinned: GcRunResult | null,
  runs: readonly GcRunResult[],
): GcRunResult[] {
  const merged = pinned?.kind === kind ? [pinned, ...runs] : [...runs];
  const seen = new Set<string>();
  return merged
    .filter((run) => run.kind === kind)
    .filter((run) => {
      if (seen.has(run.runId)) return false;
      seen.add(run.runId);
      return true;
    })
    .slice(0, RECENT_LIMIT);
}

function RunDetails({ run, title }: { run: GcRunResult; title: string }) {
  return (
    <section className="zhs-gc-panel__result" aria-label={title}>
      <div className="zhs-gc-panel__result-heading">
        <strong>{title}</strong>
        <span>{run.dryRun ? "Dry run" : "Live run"}</span>
      </div>
      <dl className="zhs-gc-panel__facts">
        <div>
          <dt>Run ID</dt>
          <dd>
            <code>{run.runId}</code>
          </dd>
        </div>
        <div>
          <dt>Job ID</dt>
          <dd>
            <code>{run.jobId}</code>
          </dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{run.kind}</dd>
        </div>
        <div>
          <dt>Scanned</dt>
          <dd>{run.scanned}</dd>
        </div>
        <div>
          <dt>Eligible</dt>
          <dd>{run.eligible}</dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>{run.deleted}</dd>
        </div>
        <div>
          <dt>Cursor</dt>
          <dd>
            <code>{run.cursor ?? "complete"}</code>
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            <time dateTime={run.startedAt}>{run.startedAt}</time>
          </dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>
            {run.finishedAt ? (
              <time dateTime={run.finishedAt}>{run.finishedAt}</time>
            ) : (
              "unfinished"
            )}
          </dd>
        </div>
        <div>
          <dt>Error</dt>
          <dd>{run.error ?? "none"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function GcPanel({ className }: GcPanelProps) {
  const { ready, isAdmin } = useIsAdmin();
  const clientForSignal = useStashClientForSignal();
  const maxId = useId();
  const maxErrorId = useId();
  const cursorId = useId();
  const titleId = useId();
  const historyTitleId = useId();
  const [kind, setKind] = useState<GcKind>("r2-orphans");
  const [dryRun, setDryRun] = useState(true);
  const [maxObjects, setMaxObjects] = useState("100");
  const [cursor, setCursor] = useState("");
  const [running, setRunning] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [currentRun, setCurrentRun] = useState<GcRunResult | null>(null);
  const [recentRuns, setRecentRuns] = useState<GcRunResult[]>([]);
  const [runError, setRunError] = useState<unknown | null>(null);
  const [runsError, setRunsError] = useState<unknown | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const runControllerRef = useRef<AbortController | null>(null);
  const runGenerationRef = useRef(0);
  const historyControllerRef = useRef<AbortController | null>(null);
  const historyGenerationRef = useRef(0);
  const pinnedRecentRunRef = useRef<GcRunResult | null>(null);
  const parsedMax = maxObjectsValue(maxObjects);
  const maxError = parsedMax === null ? "Enter a whole number from 1 through 500." : null;

  useEffect(() => {
    if (!ready || !isAdmin) {
      historyGenerationRef.current += 1;
      historyControllerRef.current?.abort();
      historyControllerRef.current = null;
      pinnedRecentRunRef.current = null;
      setRecentRuns([]);
      setRunsError(null);
      setLoadingRuns(false);
      return;
    }
    const controller = new AbortController();
    historyControllerRef.current?.abort();
    historyControllerRef.current = controller;
    const generation = ++historyGenerationRef.current;
    setLoadingRuns(true);
    setRunsError(null);
    void clientForSignal(controller.signal)
      .admin.gc.runs({ kind, limit: RECENT_LIMIT })
      .then(
        (result) => {
          if (controller.signal.aborted || historyGenerationRef.current !== generation) return;
          if (result.ok) {
            setRecentRuns(mergeRecentRuns(kind, pinnedRecentRunRef.current, result.value.runs));
          } else setRunsError(result);
          setLoadingRuns(false);
          historyControllerRef.current = null;
        },
        (error: unknown) => {
          if (controller.signal.aborted || historyGenerationRef.current !== generation) return;
          setRunsError(error);
          setLoadingRuns(false);
          historyControllerRef.current = null;
        },
      );
    return () => {
      controller.abort();
      if (historyControllerRef.current === controller) historyControllerRef.current = null;
    };
  }, [clientForSignal, historyRefresh, isAdmin, kind, ready]);

  useEffect(() => {
    if (ready && isAdmin) return;
    runGenerationRef.current += 1;
    runControllerRef.current?.abort();
    runControllerRef.current = null;
    setRunning(false);
  }, [isAdmin, ready]);

  useEffect(
    () => () => {
      runGenerationRef.current += 1;
      runControllerRef.current?.abort();
      runControllerRef.current = null;
    },
    [],
  );

  async function handleRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !isAdmin || parsedMax === null || running) return;
    const controller = new AbortController();
    runControllerRef.current?.abort();
    runControllerRef.current = controller;
    const generation = ++runGenerationRef.current;
    historyGenerationRef.current += 1;
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
    setRunning(true);
    setLoadingRuns(false);
    setRunError(null);
    setRunsError(null);
    const input: RunGcBody = {
      kind,
      dryRun,
      maxObjects: parsedMax,
      ...(cursor.trim() ? { cursor: cursor.trim() } : {}),
    };

    try {
      const result = await clientForSignal(controller.signal).admin.gc.run(input);
      if (controller.signal.aborted || runGenerationRef.current !== generation) return;
      if (!result.ok) {
        setRunError(result);
        return;
      }
      setCurrentRun(result.value);
      pinnedRecentRunRef.current = result.value;
      setRecentRuns((runs) => mergeRecentRuns(kind, result.value, runs));
    } catch (error: unknown) {
      if (!controller.signal.aborted && runGenerationRef.current === generation) setRunError(error);
    } finally {
      if (!controller.signal.aborted && runGenerationRef.current === generation) {
        setRunning(false);
        runControllerRef.current = null;
        setHistoryRefresh((value) => value + 1);
      }
    }
  }

  if (!ready || !isAdmin) return null;
  const runErrorDetails = runError === null ? null : stashErrorDetails(runError);
  const busy = runErrorDetails?.status === 409 || runErrorDetails?.code === "gc-busy";
  const invalid = runErrorDetails?.status === 400 || runErrorDetails?.code === "validation";

  return (
    <section
      className={["zhs-gc-panel", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
    >
      <header className="zhs-gc-panel__header">
        <h2 id={titleId}>Maintenance</h2>
        <p>Run one bounded garbage-collection page and inspect recent results.</p>
      </header>

      <form
        className="zhs-gc-panel__form"
        aria-busy={running || undefined}
        noValidate
        onSubmit={(event) => void handleRun(event)}
      >
        <div className="zhs-gc-panel__field">
          <label htmlFor={`${maxId}-kind`}>Kind</label>
          <Select
            id={`${maxId}-kind`}
            value={kind}
            disabled={running}
            onChange={(event) => {
              historyGenerationRef.current += 1;
              historyControllerRef.current?.abort();
              historyControllerRef.current = null;
              pinnedRecentRunRef.current = null;
              setRecentRuns([]);
              setRunsError(null);
              setLoadingRuns(false);
              setKind(event.currentTarget.value as GcKind);
              setCursor("");
              setCurrentRun(null);
              setRunError(null);
            }}
          >
            <option value="r2-orphans">R2 orphans</option>
            <option value="ledger">Expired ledger rows</option>
          </Select>
        </div>

        <div className="zhs-gc-panel__field">
          <label htmlFor={maxId}>Max objects</label>
          <Input
            aria-describedby={maxError ? maxErrorId : undefined}
            aria-invalid={maxError ? "true" : undefined}
            disabled={running}
            id={maxId}
            inputMode="numeric"
            max={500}
            min={1}
            step={1}
            type="number"
            value={maxObjects}
            onChange={(event) => {
              setMaxObjects(event.currentTarget.value);
              setRunError(null);
            }}
          />
          {maxError ? (
            <p className="zhs-gc-panel__field-error" id={maxErrorId} role="alert">
              {maxError}
            </p>
          ) : null}
        </div>

        <label className="zhs-gc-panel__check">
          <input
            checked={dryRun}
            disabled={running}
            type="checkbox"
            onChange={(event) => setDryRun(event.currentTarget.checked)}
          />
          Dry run (report only; do not delete or advance saved progress)
        </label>

        <details className="zhs-gc-panel__advanced">
          <summary>Advanced cursor</summary>
          <div className="zhs-gc-panel__field">
            <label htmlFor={cursorId}>Opaque cursor override</label>
            <Input
              id={cursorId}
              disabled={running}
              spellCheck={false}
              value={cursor}
              onChange={(event) => {
                setCursor(event.currentTarget.value);
                setRunError(null);
              }}
            />
            <p>
              Paste only a cursor returned for the selected kind. Leave blank to use saved progress.
            </p>
          </div>
        </details>

        <div className="zhs-gc-panel__actions">
          <Button disabled={running || parsedMax === null} type="submit" variant="primary">
            {running ? "Running…" : "Run"}
          </Button>
        </div>
      </form>

      {busy ? (
        <Notice variant="warning">
          <strong>Garbage collection is already running.</strong>
          <p>
            Wait for the active page to finish. If it crashed, retry after its five-minute lease
            expires.
          </p>
        </Notice>
      ) : null}
      {invalid ? (
        <Notice variant="error">
          <strong>Review the maintenance input.</strong>
          <p>
            Choose a supported kind, enter 1–500 max objects, and use only an opaque cursor returned
            for that same kind.
          </p>
        </Notice>
      ) : null}
      {runError && !busy && !invalid ? (
        <ErrorBanner error={runError} title="Could not run garbage collection" />
      ) : null}

      {currentRun ? <RunDetails run={currentRun} title="Current run" /> : null}

      <section className="zhs-gc-panel__history" aria-labelledby={historyTitleId}>
        <div className="zhs-gc-panel__history-heading">
          <h3 id={historyTitleId}>Recent runs</h3>
          <span>{kind}</span>
        </div>
        {loadingRuns ? <p>Loading recent runs…</p> : null}
        {runsError ? <ErrorBanner error={runsError} title="Could not load recent runs" /> : null}
        {!loadingRuns && !runsError && recentRuns.length === 0 ? (
          <p>No recent runs for this kind.</p>
        ) : null}
        {recentRuns.length > 0 ? (
          <div className="zhs-gc-panel__run-list">
            {recentRuns.map((run) => (
              <RunDetails key={run.runId} run={run} title={`Run ${run.runId}`} />
            ))}
          </div>
        ) : null}
      </section>
    </section>
  );
}
