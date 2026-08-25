import type { HistoryPage, VersionRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { Button } from "../app/shell/button.js";
import { Table } from "../app/shell/table.js";
import { Bytes } from "./bytes.js";
import { clientValue, ErrorBanner } from "./error-banner.js";
import { KindBadge } from "./kind-badge.js";
import { LoadMore } from "./load-more.js";
import { RelativeTime } from "./relative-time.js";
import { RollbackDialog, type RollbackSuccess } from "./rollback-dialog.js";
import "./history-list.css";

interface HistoryListProps {
  client: ViewerStashClient;
  stash: string;
  path: string;
  page: HistoryPage;
  viewedVersion?: number;
}

type DiffStatsState =
  | { state: "idle" | "loading" | "initial" | "oversized" | "error" }
  | { state: "ready"; added: number; removed: number };

function newestFirst(versions: VersionRecord[]): VersionRecord[] {
  return [...versions].sort((left, right) => right.version - left.version);
}

function mergeVersions(current: VersionRecord[], incoming: VersionRecord[]): VersionRecord[] {
  const byVersion = new Map(current.map((version) => [version.version, version]));
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

function LazyDiffStats({
  client,
  stash,
  path,
  version,
}: {
  client: ViewerStashClient;
  stash: string;
  path: string;
  version: number;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const completedRef = useRef(false);
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
    setStats({ state: "loading" });

    void client
      .withSignal(controller.signal)
      .files(stash)
      .diff(path, { from: version - 1, to: version })
      .then((result) => {
        if (controller.signal.aborted) return;
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
        if (!controller.signal.aborted) setStats({ state: "error" });
      });

    return () => controller.abort();
  }, [client, path, stash, version, visible]);

  let label = "Not requested";
  if (stats.state === "loading") label = "Loading change stats";
  if (stats.state === "initial") label = "Initial version";
  if (stats.state === "oversized") label = "Diff too large";
  if (stats.state === "error") label = "Stats unavailable";
  if (stats.state === "ready") label = `+${stats.added} −${stats.removed}`;

  return (
    <span
      aria-label={`Change stats for v${version}: ${label}`}
      className={`history-diff-stats history-diff-stats--${stats.state}`}
      ref={elementRef}
    >
      {stats.state === "idle" ? "—" : label}
    </span>
  );
}

function HistoryRow({
  client,
  stash,
  path,
  version,
  fromVersion,
  toVersion,
  viewedVersion,
  onFromChange,
  onToChange,
  onRollback,
}: {
  client: ViewerStashClient;
  stash: string;
  path: string;
  version: VersionRecord;
  fromVersion: number | null;
  toVersion: number | null;
  viewedVersion?: number;
  onFromChange: (version: number) => void;
  onToChange: (version: number) => void;
  onRollback: (version: VersionRecord) => void;
}) {
  const fileUrl = `/s/${stash}/f/${path}`;
  const diffUrl = `/s/${stash}/diff/${path}`;

  return (
    <tr
      aria-current={viewedVersion === version.version ? "true" : undefined}
      data-history-version={version.version}
    >
      <td className="history-table__choice">
        <input
          aria-label={`Use v${version.version} as from version`}
          checked={fromVersion === version.version}
          name={`history-from-${stash}-${path}`}
          type="radio"
          value={version.version}
          onChange={() => onFromChange(version.version)}
        />
      </td>
      <td className="history-table__choice">
        <input
          aria-label={`Use v${version.version} as to version`}
          checked={toVersion === version.version}
          name={`history-to-${stash}-${path}`}
          type="radio"
          value={version.version}
          onChange={() => onToChange(version.version)}
        />
      </td>
      <td className="history-table__version">v{version.version}</td>
      <td className="history-table__kind">
        <div className="history-table__kind-content">
          <KindBadge kind={version.kind} rollbackOf={version.rollbackOf} />
          {version.kind === "delete" ? (
            <span className="history-table__deleted-label">deleted</span>
          ) : null}
        </div>
      </td>
      <td className="history-table__stats">
        <LazyDiffStats client={client} path={path} stash={stash} version={version.version} />
      </td>
      <td className="history-table__author">{version.author || "—"}</td>
      <td className="history-table__message">
        {version.message || <span className="muted">No message</span>}
      </td>
      <td className="history-table__size">
        <Bytes value={version.size} />
      </td>
      <td className="history-table__time">
        <RelativeTime value={version.createdAt} />
      </td>
      <td className="history-table__actions">
        <div className="history-row-actions">
          <Link to={`${fileUrl}?version=${version.version}`}>View this version</Link>
          <Link to={`${diffUrl}?from=${version.version}&to=head`}>Diff vs head</Link>
          <Button
            aria-label={`Rollback to v${version.version}`}
            compact
            onClick={() => onRollback(version)}
          >
            Rollback to this version
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function HistoryList({ client, stash, path, page, viewedVersion }: HistoryListProps) {
  const navigate = useNavigate();
  const controllerRef = useRef<AbortController | null>(null);
  const initialComparison = defaultComparison(page);
  const [versions, setVersions] = useState(() => newestFirst(page.versions));
  const [nextBefore, setNextBefore] = useState(page.nextBefore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagingError, setPagingError] = useState<unknown | null>(null);
  const [fromVersion, setFromVersion] = useState<number | null>(initialComparison.from);
  const [toVersion, setToVersion] = useState<number | null>(initialComparison.to);
  const [total, setTotal] = useState(page.total);
  const [rollbackTarget, setRollbackTarget] = useState<VersionRecord | null>(null);
  const [rollbackToast, setRollbackToast] = useState<string | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    setVersions(newestFirst(page.versions));
    setNextBefore(page.nextBefore);
    setLoadingMore(false);
    setPagingError(null);
    setTotal(page.total);
    const comparison = defaultComparison(page);
    setFromVersion(comparison.from);
    setToVersion(comparison.to);
  }, [page]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function loadMore() {
    if (nextBefore === null || loadingMore) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    setPagingError(null);

    try {
      const nextPage = await clientValue(
        client.withSignal(controller.signal).files(stash).history(path, { before: nextBefore }),
      );
      if (controller.signal.aborted) return;
      setVersions((current) => mergeVersions(current, nextPage.versions));
      setNextBefore(nextPage.nextBefore);
    } catch (error) {
      if (!controller.signal.aborted) setPagingError(error);
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  function compare() {
    if (fromVersion === null || toVersion === null) return;
    const search = new URLSearchParams({ from: String(fromVersion), to: String(toVersion) });
    navigate(`/s/${stash}/diff/${path}?${search.toString()}`);
  }

  const closeRollback = useCallback(() => setRollbackTarget(null), []);

  function completeRollback({ result, message }: RollbackSuccess) {
    const target = rollbackTarget;
    if (!target) return;
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
    navigate(`/s/${stash}/f/${path}`);
  }

  return (
    <section className="section-card history-list" aria-labelledby="file-history-title">
      <div className="section-card__heading history-list__heading">
        <div>
          <h2 id="file-history-title">History</h2>
          <p>
            {total} {total === 1 ? "version" : "versions"}, newest first.
          </p>
        </div>
        <Button compact disabled={fromVersion === null || toVersion === null} onClick={compare}>
          Compare
        </Button>
      </div>

      {rollbackToast ? (
        <div aria-live="polite" className="rollback-toast" role="status">
          <span>{rollbackToast}</span>
          <Button compact onClick={() => setRollbackToast(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {versions.length === 0 ? (
        <p className="empty-copy">No versions have been recorded for this file.</p>
      ) : (
        <Table className="history-table">
          <thead>
            <tr>
              <th className="history-table__choice" scope="col">
                From
              </th>
              <th className="history-table__choice" scope="col">
                To
              </th>
              <th className="history-table__version" scope="col">
                Version
              </th>
              <th className="history-table__kind" scope="col">
                Kind
              </th>
              <th className="history-table__stats" scope="col">
                Change
              </th>
              <th className="history-table__author" scope="col">
                Author
              </th>
              <th className="history-table__message" scope="col">
                Message
              </th>
              <th className="history-table__size" scope="col">
                Size
              </th>
              <th className="history-table__time" scope="col">
                Time
              </th>
              <th className="history-table__actions" scope="col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <HistoryRow
                client={client}
                fromVersion={fromVersion}
                key={`${stash}:${path}:${version.version}`}
                path={path}
                stash={stash}
                toVersion={toVersion}
                version={version}
                viewedVersion={viewedVersion}
                onFromChange={setFromVersion}
                onRollback={setRollbackTarget}
                onToChange={setToVersion}
              />
            ))}
          </tbody>
        </Table>
      )}

      {pagingError ? (
        <div className="history-list__paging-error">
          <ErrorBanner error={pagingError} onRetry={loadMore} title="Could not load more history" />
        </div>
      ) : null}
      <div className="section-card__footer">
        <LoadMore hasMore={nextBefore !== null} loading={loadingMore} onLoadMore={loadMore} />
      </div>
      {rollbackTarget ? (
        <RollbackDialog
          client={client}
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
