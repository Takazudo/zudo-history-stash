import type { HistoryPage, VersionRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useRef, useState } from "react";
import { Anchor, useCanWrite, useStashClientForSignal, useStashHref } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { Bytes } from "./bytes.js";
import { ErrorBanner } from "./error-banner.js";
import { KindBadge } from "./kind-badge.js";
import { LoadMore } from "./load-more.js";
import { RelativeTime } from "./relative-time.js";
import { RollbackDialog, type RollbackSuccess } from "./rollback-dialog.js";

export interface HistoryListProps {
  stash: string;
  path: string;
  page: HistoryPage;
  viewedVersion?: number;
  loadingMore?: boolean;
  loadMoreError?: unknown | null;
  onLoadMore: () => void;
  onRollbackComplete?: (success: RollbackSuccess) => void;
}

type DiffStatsState =
  | { state: "idle" | "loading" | "initial" | "oversized" | "error" }
  | { state: "ready"; added: number; removed: number };

function newestFirst(versions: readonly VersionRecord[]): VersionRecord[] {
  return [...versions].sort((left, right) => right.version - left.version);
}

function mergeVersions(current: readonly VersionRecord[], incoming: readonly VersionRecord[]) {
  const byVersion = new Map(current.map((version) => [version.version, version] as const));
  for (const version of incoming) byVersion.set(version.version, version);
  return newestFirst([...byVersion.values()]);
}

function defaultComparison(page: HistoryPage): { from: number | null; to: number | null } {
  const versions = newestFirst(page.versions);
  if (versions.length === 0) return { from: null, to: null };
  const available = new Set(versions.map((version) => version.version));
  const to = available.has(page.headVersion) ? page.headVersion : (versions[0]?.version ?? null);
  if (to === null) return { from: null, to: null };
  const preferredFrom = to - 1;
  const from = available.has(preferredFrom)
    ? preferredFrom
    : (versions.find((version) => version.version < to)?.version ?? to);
  return { from, to };
}

function LazyDiffStats({ stash, path, version }: { stash: string; path: string; version: number }) {
  const clientForSignal = useStashClientForSignal();
  const elementRef = useRef<HTMLSpanElement>(null);
  const completedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState<DiffStatsState>(() =>
    version === 1 ? { state: "initial" } : { state: "idle" },
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || version === 1 || completedRef.current) return;
    const controller = new AbortController();
    const sequence = ++requestSequenceRef.current;
    setStats({ state: "loading" });

    void clientForSignal(controller.signal)
      .files(stash)
      .diff(path, { from: version - 1, to: version })
      .then((result) => {
        if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
        if (!result.ok) {
          setStats({ state: "error" });
          return;
        }
        completedRef.current = true;
        if (result.value.state === "ready") {
          setStats({
            state: "ready",
            added: result.value.stats.added,
            removed: result.value.stats.removed,
          });
        } else if (result.value.state === "same") {
          setStats({ state: "ready", added: 0, removed: 0 });
        } else {
          setStats({ state: "oversized" });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
          setStats({ state: "error" });
        }
      });

    return () => controller.abort();
  }, [clientForSignal, path, stash, version, visible]);

  let label = "Not requested";
  if (stats.state === "loading") label = "Loading change stats";
  if (stats.state === "initial") label = "Initial version";
  if (stats.state === "oversized") label = "Diff too large";
  if (stats.state === "error") label = "Stats unavailable";
  if (stats.state === "ready") label = `+${stats.added} −${stats.removed}`;

  return (
    <span
      aria-label={`Change stats for v${version}: ${label}`}
      className={`zhs-history-diff-stats zhs-history-diff-stats--${stats.state}`}
      ref={elementRef}
    >
      {stats.state === "idle" ? "—" : label}
    </span>
  );
}

interface HistoryRowProps {
  stash: string;
  path: string;
  version: VersionRecord;
  fromVersion: number | null;
  toVersion: number | null;
  viewedVersion?: number;
  rollbackReady: boolean;
  rollbackAllowed: boolean;
  onFromChange: (version: number) => void;
  onToChange: (version: number) => void;
  onRollback: (version: VersionRecord) => void;
}

function HistoryRow({
  stash,
  path,
  version,
  fromVersion,
  toVersion,
  viewedVersion,
  rollbackReady,
  rollbackAllowed,
  onFromChange,
  onToChange,
  onRollback,
}: HistoryRowProps) {
  const hrefFor = useStashHref();
  const rollbackDisabled = !rollbackReady || !rollbackAllowed || version.kind === "delete";
  const rollbackTitle = !rollbackReady
    ? "Checking write access"
    : !rollbackAllowed
      ? "Write access is required"
      : version.kind === "delete"
        ? "Rollback to a deletion is not allowed"
        : undefined;

  return (
    <TableRow
      aria-current={viewedVersion === version.version ? "true" : undefined}
      data-history-version={version.version}
    >
      <TableCell className="zhs-history-table__choice">
        <input
          aria-label={`Use v${version.version} as from version`}
          checked={fromVersion === version.version}
          name={`history-from-${stash}-${path}`}
          type="radio"
          value={version.version}
          onChange={() => onFromChange(version.version)}
        />
      </TableCell>
      <TableCell className="zhs-history-table__choice">
        <input
          aria-label={`Use v${version.version} as to version`}
          checked={toVersion === version.version}
          name={`history-to-${stash}-${path}`}
          type="radio"
          value={version.version}
          onChange={() => onToChange(version.version)}
        />
      </TableCell>
      <TableCell className="zhs-history-table__version">v{version.version}</TableCell>
      <TableCell className="zhs-history-table__kind">
        <div className="zhs-history-table__kind-content">
          <KindBadge kind={version.kind} rollbackOf={version.rollbackOf} />
          {version.kind === "delete" ? (
            <span className="zhs-history-table__deleted-label">deleted</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="zhs-history-table__stats">
        <LazyDiffStats path={path} stash={stash} version={version.version} />
      </TableCell>
      <TableCell className="zhs-history-table__author">{version.author || "—"}</TableCell>
      <TableCell className="zhs-history-table__message">
        {version.message || <span className="zhs-muted">No message</span>}
      </TableCell>
      <TableCell className="zhs-history-table__size">
        <Bytes value={version.size} />
      </TableCell>
      <TableCell className="zhs-history-table__time">
        <RelativeTime value={version.createdAt} />
      </TableCell>
      <TableCell className="zhs-history-table__actions">
        <div className="zhs-history-row-actions">
          <Anchor href={hrefFor({ kind: "file", stash, path, version: version.version })}>
            View this version
          </Anchor>
          <Anchor
            href={hrefFor({
              kind: "diff",
              stash,
              path,
              from: version.version,
              to: "head",
            })}
          >
            Diff vs head
          </Anchor>
          <Button
            aria-label={`Rollback to v${version.version}`}
            disabled={rollbackDisabled}
            size="sm"
            title={rollbackTitle}
            onClick={() => onRollback(version)}
          >
            Rollback to this version
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function HistoryList({
  stash,
  path,
  page,
  viewedVersion,
  loadingMore = false,
  loadMoreError = null,
  onLoadMore,
  onRollbackComplete,
}: HistoryListProps) {
  const hrefFor = useStashHref();
  const capability = useCanWrite(stash);
  const initialComparison = defaultComparison(page);
  const [versions, setVersions] = useState(() => newestFirst(page.versions));
  const [fromVersion, setFromVersion] = useState<number | null>(initialComparison.from);
  const [toVersion, setToVersion] = useState<number | null>(initialComparison.to);
  const [total, setTotal] = useState(page.total);
  const [rollbackTarget, setRollbackTarget] = useState<VersionRecord | null>(null);
  const [rollbackToast, setRollbackToast] = useState<string | null>(null);

  useEffect(() => {
    const nextVersions = newestFirst(page.versions);
    const available = new Set(nextVersions.map((version) => version.version));
    const comparison = defaultComparison(page);
    setVersions(nextVersions);
    setTotal(page.total);
    setFromVersion((current) =>
      current !== null && available.has(current) ? current : comparison.from,
    );
    setToVersion((current) =>
      current !== null && available.has(current) ? current : comparison.to,
    );
  }, [page]);

  const closeRollback = useCallback(() => setRollbackTarget(null), []);

  function completeRollback(success: RollbackSuccess) {
    const target = rollbackTarget;
    if (!target) return;
    const { result, message } = success;
    const effectiveMessage = message || `Rollback to v${target.version}`;
    const created: VersionRecord = {
      version: result.version,
      kind: "rollback",
      hash: result.hash,
      size: target.size,
      rollbackOf: target.version,
      author: "viewer",
      message: effectiveMessage,
      meta: {},
      createdAt: result.createdAt,
    };
    setVersions((current) => mergeVersions(current, [created]));
    setTotal((current) => Math.max(current + 1, result.version));
    setFromVersion(target.version);
    setToVersion(result.version);
    setRollbackToast(
      `Rollback complete. Created v${result.version} as rollback to v${target.version}.`,
    );
    setRollbackTarget(null);
    onRollbackComplete?.(success);
  }

  const compareHref =
    fromVersion === null || toVersion === null
      ? null
      : hrefFor({ kind: "diff", stash, path, from: fromVersion, to: toVersion });

  return (
    <section className="zhs-section-card zhs-history-list" aria-labelledby="file-history-title">
      <div className="zhs-section-card__heading zhs-history-list__heading">
        <div>
          <h2 id="file-history-title">History</h2>
          <p>
            {total} {total === 1 ? "version" : "versions"}, newest first.
          </p>
        </div>
        {compareHref ? (
          <Anchor
            className="zhs-button zhs-button--secondary zhs-button--sm zhs-history-list__compare"
            href={compareHref}
          >
            Compare
          </Anchor>
        ) : (
          <Button size="sm" disabled>
            Compare
          </Button>
        )}
      </div>

      {rollbackToast ? (
        <div aria-live="polite" className="zhs-rollback-toast" role="status">
          <span>{rollbackToast}</span>
          <Button size="sm" onClick={() => setRollbackToast(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {versions.length === 0 ? (
        <p className="zhs-history-list__empty">No versions have been recorded for this file.</p>
      ) : (
        <div className="zhs-history-list__table-scroll">
          <Table className="zhs-history-table">
            <TableHead>
              <TableRow>
                <TableHeader className="zhs-history-table__choice" scope="col">
                  From
                </TableHeader>
                <TableHeader className="zhs-history-table__choice" scope="col">
                  To
                </TableHeader>
                <TableHeader className="zhs-history-table__version" scope="col">
                  Version
                </TableHeader>
                <TableHeader className="zhs-history-table__kind" scope="col">
                  Kind
                </TableHeader>
                <TableHeader className="zhs-history-table__stats" scope="col">
                  Change
                </TableHeader>
                <TableHeader className="zhs-history-table__author" scope="col">
                  Author
                </TableHeader>
                <TableHeader className="zhs-history-table__message" scope="col">
                  Message
                </TableHeader>
                <TableHeader className="zhs-history-table__size" scope="col">
                  Size
                </TableHeader>
                <TableHeader className="zhs-history-table__time" scope="col">
                  Time
                </TableHeader>
                <TableHeader className="zhs-history-table__actions" scope="col">
                  Actions
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {versions.map((version) => (
                <HistoryRow
                  fromVersion={fromVersion}
                  key={`${stash}:${path}:${version.version}`}
                  path={path}
                  rollbackAllowed={capability.canWrite}
                  rollbackReady={capability.ready}
                  stash={stash}
                  toVersion={toVersion}
                  version={version}
                  viewedVersion={viewedVersion}
                  onFromChange={setFromVersion}
                  onRollback={setRollbackTarget}
                  onToChange={setToVersion}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {loadMoreError ? (
        <div className="zhs-history-list__paging-error">
          <ErrorBanner
            error={loadMoreError}
            onRetry={onLoadMore}
            title="Could not load more history"
          />
        </div>
      ) : null}
      <div className="zhs-section-card__footer">
        <LoadMore
          hasMore={page.nextBefore !== null}
          loading={loadingMore}
          onLoadMore={onLoadMore}
        />
      </div>
      {rollbackTarget ? (
        <RollbackDialog
          path={path}
          stash={stash}
          target={rollbackTarget}
          onClose={closeRollback}
          onSuccess={completeRollback}
        />
      ) : null}
    </section>
  );
}
