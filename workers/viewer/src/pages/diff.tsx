import type { GetDiffResult, GetHistoryResult, VersionRecord } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import {
  DiffControls,
  DiffPane,
  KindBadge,
  useDiffViewPreferences,
} from "@takazudo/zudo-history-stash-ui";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { Button } from "../app/shell/button.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { useAsync } from "../hooks/use-async.js";

const CONTEXT_VALUES = [0, 3, 10] as const;

type ContextLines = (typeof CONTEXT_VALUES)[number];
type ToVersion = number | "head";
type CopyState = "idle" | "copied" | "error";

interface VersionChoice {
  version: number;
  record?: VersionRecord;
}

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toVersion(value: string | null): ToVersion | null {
  if (value === "head") return "head";
  return positiveInteger(value);
}

function contextLines(value: string | null): ContextLines {
  const parsed = positiveInteger(value);
  if (value === "0") return 0;
  return parsed === 10 ? 10 : 3;
}

function optionLabel(record: VersionRecord): string {
  const rollback =
    record.kind === "rollback" && record.rollbackOf ? ` → v${record.rollbackOf}` : "";
  return `v${record.version} · ${record.kind}${rollback}`;
}

function versionChoices(
  history: GetHistoryResult | undefined,
  required: number[],
): VersionChoice[] {
  const records = new Map(
    Array.isArray(history?.versions)
      ? history.versions.map((record) => [record.version, record] as const)
      : [],
  );
  const versions = new Set(records.keys());
  for (const version of required) versions.add(version);
  return [...versions]
    .sort((left, right) => right - left)
    .map((version) => ({ version, record: records.get(version) }));
}

function selectedRecord(
  history: GetHistoryResult | undefined,
  selected: ToVersion,
): VersionRecord | undefined {
  const version = selected === "head" ? history?.headVersion : selected;
  return Array.isArray(history?.versions)
    ? history.versions.find((record) => record.version === version)
    : undefined;
}

function comparisonLabel(result: GetDiffResult, selectedTo: ToVersion): string {
  const fromDeleted = result.from.deleted ? " (deleted)" : "";
  const head = selectedTo === "head" ? " (head)" : "";
  const toDeleted = result.to.deleted ? " (deleted)" : "";
  return `v${result.from.version}${fromDeleted} → v${result.to.version}${head}${toDeleted}`;
}

function VersionKind({ record }: { record: VersionRecord | undefined }) {
  return record ? <KindBadge kind={record.kind} rollbackOf={record.rollbackOf} /> : null;
}

function RawVersionLinks({
  result,
  stash,
  path,
}: {
  result: GetDiffResult;
  stash: string;
  path: string;
}) {
  return (
    <div className="diff-state-card__links">
      <Link to={`/s/${stash}/f/${path}?version=${result.from.version}`}>
        Open v{result.from.version} raw{result.from.deleted ? " (deleted)" : ""}
      </Link>
      <Link to={`/s/${stash}/f/${path}?version=${result.to.version}`}>
        Open v{result.to.version} raw{result.to.deleted ? " (deleted)" : ""}
      </Link>
    </div>
  );
}

type ReadyDiffResult = Extract<GetDiffResult, { state: "ready" }>;

function crlfNotice(crlf: { old: boolean; new: boolean }): string | null {
  if (crlf.old && crlf.new) return "CRLF line endings are shown normalized";
  if (crlf.old) return "CRLF line endings on the old side are shown normalized";
  if (crlf.new) return "CRLF line endings on the new side are shown normalized";
  return null;
}

function ReadyDiff({
  diff,
  effectiveLayout,
  marks,
  wrap,
}: {
  diff: ReadyDiffResult;
  effectiveLayout: "unified" | "split";
  marks: boolean;
  wrap: boolean;
}) {
  const model = useMemo(() => buildDiffModel(diff.hunks), [diff.hunks]);
  const lineEndingNotice = crlfNotice(model.crlf);

  return (
    <>
      {diff.truncated ? (
        <section className="diff-notice" role="status">
          <strong>Unified output was truncated</strong>
          <p>The structured hunk table below still includes every changed line.</p>
        </section>
      ) : null}
      {lineEndingNotice ? (
        <section className="diff-notice" role="status">
          <strong>{lineEndingNotice}</strong>
        </section>
      ) : null}
      {model.intralineSkipped > 0 ? (
        <section className="diff-notice" role="status">
          <strong>
            Word-level marks were skipped on {model.intralineSkipped} long line
            {model.intralineSkipped === 1 ? "" : "s"}
          </strong>
        </section>
      ) : null}
      <DiffPane
        fromLabel={`v${diff.from.version}`}
        layout={effectiveLayout}
        marks={marks}
        model={model}
        toLabel={`v${diff.to.version}`}
        wrap={wrap}
      />
    </>
  );
}

export default function DiffPage() {
  const { stash, "*": path } = useParams();
  const { client } = useStashClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromVersion = positiveInteger(searchParams.get("from")) ?? 1;
  const selectedTo = toVersion(searchParams.get("to")) ?? "head";
  const context = contextLines(searchParams.get("context"));
  const preferences = useDiffViewPreferences();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const history = useAsync(
    async (signal) => {
      if (!client) throw new Error("Sign in to inspect file history.");
      if (!stash || !path) throw new Error("The stash name or file path is missing from this URL.");
      return clientValue(
        client.withSignal(signal).files(stash).history(path, {
          limit: 200,
        }),
      );
    },
    [client, path, stash],
  );

  const diff = useAsync(
    async (signal) => {
      if (!client) throw new Error("Sign in to compare file versions.");
      if (!stash || !path) throw new Error("The stash name or file path is missing from this URL.");
      return clientValue(
        client.withSignal(signal).files(stash).diff(path, {
          from: fromVersion,
          to: selectedTo,
          context,
        }),
      );
    },
    [client, context, fromVersion, path, selectedTo, stash],
  );

  const historyValue = history.state === "ready" ? history.value : undefined;
  const resolvedToVersion =
    diff.state === "ready" && diff.value.to
      ? diff.value.to.version
      : selectedTo === "head"
        ? historyValue?.headVersion
        : selectedTo;
  const choices = useMemo(
    () =>
      versionChoices(
        historyValue,
        [fromVersion, resolvedToVersion].filter((value): value is number => value !== undefined),
      ),
    [fromVersion, historyValue, resolvedToVersion],
  );
  const fromRecord = selectedRecord(historyValue, fromVersion);
  const toRecord = selectedRecord(historyValue, selectedTo);
  const unified =
    diff.state === "ready" && diff.value.state === "ready" ? diff.value.unified : undefined;

  useEffect(() => setCopyState("idle"), [context, fromVersion, selectedTo, unified]);

  function updateSearch(values: { from?: number; to?: ToVersion; context?: ContextLines }) {
    const next = new URLSearchParams(searchParams);
    if (values.from !== undefined) next.set("from", String(values.from));
    if (values.to !== undefined) next.set("to", String(values.to));
    if (values.context !== undefined) next.set("context", String(values.context));
    setSearchParams(next, { replace: true });
  }

  function handleFromChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = positiveInteger(event.currentTarget.value);
    if (next !== null) updateSearch({ from: next });
  }

  function handleToChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = toVersion(event.currentTarget.value);
    if (next !== null) updateSearch({ to: next });
  }

  function handleContextChange(event: ChangeEvent<HTMLSelectElement>) {
    updateSearch({ context: contextLines(event.currentTarget.value) });
  }

  function handleSwap() {
    if (resolvedToVersion === undefined) return;
    updateSearch({ from: resolvedToVersion, to: fromVersion });
  }

  async function handleCopy() {
    if (unified === undefined) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(unified);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const visibleComparison =
    diff.state === "ready" && diff.value.from && diff.value.to
      ? comparisonLabel(diff.value, selectedTo)
      : `v${fromVersion} → ${selectedTo === "head" ? "head" : `v${selectedTo}`}`;

  return (
    <Page title={`Diff: ${path ?? "file"}`} description="Compare two immutable file versions.">
      <div className="diff-view">
        <section className="diff-view__header" aria-labelledby="diff-path-title">
          <div className="diff-view__identity">
            <h2 id="diff-path-title">{path ?? "File path unavailable"}</h2>
            <p>{visibleComparison}</p>
          </div>
          <div className="diff-controls" aria-label="Diff controls" role="group">
            <label className="diff-control">
              <span className="diff-control__label">From</span>
              <span className="diff-control__value">
                <select aria-label="From version" onChange={handleFromChange} value={fromVersion}>
                  {choices.map((choice) => (
                    <option key={choice.version} value={choice.version}>
                      {choice.record ? optionLabel(choice.record) : `v${choice.version}`}
                    </option>
                  ))}
                </select>
                <VersionKind record={fromRecord} />
              </span>
            </label>
            <label className="diff-control">
              <span className="diff-control__label">To</span>
              <span className="diff-control__value">
                <select aria-label="To version" onChange={handleToChange} value={selectedTo}>
                  <option value="head">
                    head{historyValue ? ` · v${historyValue.headVersion}` : ""}
                    {toRecord ? ` · ${toRecord.kind}` : ""}
                  </option>
                  {choices.map((choice) => (
                    <option key={choice.version} value={choice.version}>
                      {choice.record ? optionLabel(choice.record) : `v${choice.version}`}
                    </option>
                  ))}
                </select>
                <VersionKind record={toRecord} />
              </span>
            </label>
            <Button compact disabled={resolvedToVersion === undefined} onClick={handleSwap}>
              Swap
            </Button>
            <label className="diff-control">
              <span className="diff-control__label">Context</span>
              <select aria-label="Context lines" onChange={handleContextChange} value={context}>
                {CONTEXT_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value} lines
                  </option>
                ))}
              </select>
            </label>
            <DiffControls
              isNarrow={preferences.isNarrow}
              marks={preferences.marks}
              preferredLayout={preferences.preferredLayout}
              setMarks={preferences.setMarks}
              setPreferredLayout={preferences.setPreferredLayout}
              setWrap={preferences.setWrap}
              wrap={preferences.wrap}
            />
            {diff.state === "ready" && diff.value.state === "ready" ? (
              <span
                className="diff-stats"
                aria-label={`${diff.value.stats.added} lines added and ${diff.value.stats.removed} lines removed`}
              >
                <span className="diff-stats__add">+{diff.value.stats.added}</span>
                <span className="diff-stats__remove">−{diff.value.stats.removed}</span>
              </span>
            ) : null}
            <span className="diff-copy-group">
              <Button compact disabled={unified === undefined} onClick={() => void handleCopy()}>
                Copy unified
              </Button>
              <span className="diff-copy-status" role="status">
                {copyState === "copied"
                  ? "Copied to clipboard."
                  : copyState === "error"
                    ? "Clipboard access failed."
                    : ""}
              </span>
            </span>
          </div>
        </section>

        {history.state === "loading" ? <p className="loading-copy">Loading versions…</p> : null}
        {history.state === "error" ? (
          <ErrorBanner
            error={history.error}
            onRetry={() => void history.reload().catch(() => undefined)}
            title="Could not load version history"
          />
        ) : null}
        {diff.state === "loading" ? <p className="loading-copy">Loading comparison…</p> : null}
        {diff.state === "error" ? (
          <ErrorBanner
            error={diff.error}
            onRetry={() => void diff.reload().catch(() => undefined)}
          />
        ) : null}

        {diff.state === "ready" && diff.value.state === "same" ? (
          <section className="diff-state-card" role="status">
            <h3>
              No differences between v{diff.value.from.version} and v{diff.value.to.version}
            </h3>
            <p>Both versions contain the same text.</p>
          </section>
        ) : null}

        {diff.state === "ready" && diff.value.state === "oversized" && stash && path ? (
          <section className="diff-state-card" role="status">
            <h3>Diff unavailable for this comparison</h3>
            <p>
              {diff.value.reason === "bytes"
                ? "One or both versions exceed the 512 KiB per-side diff limit."
                : "The comparison exceeded the diff time or edit-complexity limit."}
            </p>
            <RawVersionLinks path={path} result={diff.value} stash={stash} />
          </section>
        ) : null}

        {diff.state === "ready" && diff.value.state === "ready" ? (
          <ReadyDiff
            diff={diff.value}
            effectiveLayout={preferences.effectiveLayout}
            marks={preferences.marks}
            wrap={preferences.wrap}
          />
        ) : null}
      </div>
    </Page>
  );
}
