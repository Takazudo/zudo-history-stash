import type { ChangeItem, MeResponse, StashSummary } from "@takazudo/zudo-history-stash";
import {
  Button,
  ChangeRow,
  CreateStashDialog,
  GcPanel,
  LoadMore,
  RelativeTime,
  useIsAdmin,
} from "@takazudo/zudo-history-stash-ui";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { Page } from "../app/shell/page.js";
import { Table } from "../app/shell/table.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { useAsync } from "../hooks/use-async.js";
import { usePagedData } from "./use-paged-data.js";

const stashKey = (stash: StashSummary) => stash.name;
const changeKey = (change: ChangeItem) => change.changeId;

function nextBefore(page: {
  nextBefore?: number | null;
  nextSince?: number | null;
}): number | null {
  return page.nextBefore ?? null;
}

function StashTable({
  stashes,
  isAdmin,
  restoring,
  onRestore,
}: {
  stashes: StashSummary[];
  isAdmin: boolean;
  restoring: string | null;
  onRestore: (stash: StashSummary) => void;
}) {
  return (
    <Table className="data-table data-table--stashes">
      <thead>
        <tr>
          <th className="data-table__name">Name</th>
          <th className="data-table__description data-table__mobile-optional">Description</th>
          <th className="data-table__count">Files</th>
          <th className="data-table__time">Last change</th>
          <th className="data-table__time data-table__mobile-optional">Created</th>
          <th className="data-table__status">Status</th>
          <th className="data-table__action">Action</th>
        </tr>
      </thead>
      <tbody>
        {stashes.map((stash) => (
          <tr className={stash.deletedAt ? "deleted-row" : undefined} key={stash.name}>
            <td className="data-table__name">
              {stash.deletedAt ? stash.name : <Link to={`/s/${stash.name}`}>{stash.name}</Link>}
            </td>
            <td className="data-table__description data-table__mobile-optional">
              {stash.description || <span className="muted">No description</span>}
            </td>
            <td className="data-table__count">
              <strong>{stash.fileCount}</strong>
              {stash.deletedFileCount > 0 ? (
                <span className="muted"> + {stash.deletedFileCount} deleted</span>
              ) : null}
            </td>
            <td className="data-table__time">
              {stash.lastChangeAt ? <RelativeTime value={stash.lastChangeAt} /> : "—"}
            </td>
            <td className="data-table__time data-table__mobile-optional">
              <RelativeTime value={stash.createdAt} />
            </td>
            <td className="data-table__status">
              {stash.deletedAt ? <span className="deleted-badge">deleted</span> : "live"}
            </td>
            <td className="data-table__action">
              {isAdmin && stash.deletedAt && stash.restorable ? (
                <Button
                  aria-label={`Restore ${stash.name}`}
                  disabled={restoring !== null}
                  size="sm"
                  onClick={() => onRestore(stash)}
                >
                  {restoring === stash.name ? "Restoring…" : "Restore"}
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function HomeContents({ me }: { me: MeResponse }) {
  const { client } = useStashClient();
  const admin = useIsAdmin();
  const [createOpen, setCreateOpen] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<unknown | null>(null);
  const restoreControllerRef = useRef<AbortController | null>(null);
  const restoreGenerationRef = useRef(0);
  const isAdmin = admin.ready && admin.isAdmin;
  const stashes = usePagedData<StashSummary, string>(
    async (signal, after) => {
      if (!client || !isAdmin) return { items: [], nextCursor: null };
      const page = await clientValue(
        client.withSignal(signal).stashes.list({
          includeDeleted: showDeleted,
          ...(after ? { after } : {}),
        }),
      );
      return { items: page.stashes, nextCursor: page.nextAfter };
    },
    [client, isAdmin, showDeleted],
    stashKey,
  );

  useEffect(
    () => () => {
      restoreGenerationRef.current += 1;
      restoreControllerRef.current?.abort();
      restoreControllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (isAdmin) return;
    restoreGenerationRef.current += 1;
    restoreControllerRef.current?.abort();
    restoreControllerRef.current = null;
    setRestoring(null);
  }, [isAdmin]);

  function handleShowDeleted(event: ChangeEvent<HTMLInputElement>) {
    setShowDeleted(event.currentTarget.checked);
    setRestoreError(null);
    stashes.reset();
  }

  async function handleRestore(stash: StashSummary) {
    if (!client || !admin.ready || !admin.isAdmin || !stash.restorable || restoring !== null)
      return;
    const controller = new AbortController();
    restoreControllerRef.current?.abort();
    restoreControllerRef.current = controller;
    const generation = ++restoreGenerationRef.current;
    setRestoring(stash.name);
    setRestoreError(null);
    try {
      await clientValue(client.withSignal(controller.signal).stashes.restore(stash.name));
      if (controller.signal.aborted || restoreGenerationRef.current !== generation) return;
      stashes.reset();
    } catch (error: unknown) {
      if (!controller.signal.aborted && restoreGenerationRef.current === generation) {
        setRestoreError(error);
      }
    } finally {
      if (!controller.signal.aborted && restoreGenerationRef.current === generation) {
        setRestoring(null);
        restoreControllerRef.current = null;
      }
    }
  }
  const changes = usePagedData<ChangeItem, number>(
    async (signal, before) => {
      if (!client || !isAdmin) return { items: [], nextCursor: null };
      const page = await clientValue(
        client.withSignal(signal).changes({ ...(before ? { before } : {}) }),
      );
      return { items: page.changes, nextCursor: nextBefore(page) };
    },
    [client, isAdmin],
    changeKey,
  );

  if (me.principal === "stash") return <Navigate replace to={`/s/${me.stash}`} />;

  const newestChanges = [...changes.items].sort((left, right) => right.changeId - left.changeId);
  return (
    <Page
      title="Stashes"
      description="Browse every stash and the latest activity."
      actions={
        isAdmin ? (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            New stash
          </Button>
        ) : null
      }
    >
      <div className="page-data-layout">
        <div className="page-data-main section-stack">
          <section className="section-card" aria-labelledby="stash-directory-title">
            <div className="section-card__heading">
              <div>
                <h2 id="stash-directory-title">Stash directory</h2>
                <p>Live and deleted file counts are shown separately.</p>
              </div>
              {isAdmin ? (
                <label className="toggle-field">
                  <input checked={showDeleted} type="checkbox" onChange={handleShowDeleted} />
                  Show deleted
                </label>
              ) : null}
            </div>
            {stashes.initialLoading ? <p className="loading-copy">Loading stashes…</p> : null}
            {stashes.error ? <ErrorBanner error={stashes.error} onRetry={stashes.retry} /> : null}
            {!stashes.initialLoading && !stashes.error && stashes.items.length === 0 ? (
              <p className="empty-copy">No stashes yet. Create the first one.</p>
            ) : null}
            {restoreError ? (
              <ErrorBanner error={restoreError} title="Could not restore this stash" />
            ) : null}
            {stashes.items.length > 0 ? (
              <StashTable
                isAdmin={isAdmin}
                restoring={restoring}
                stashes={stashes.items}
                onRestore={(stash) => void handleRestore(stash)}
              />
            ) : null}
            <LoadMore
              hasMore={stashes.hasMore}
              loading={stashes.loading}
              onLoadMore={stashes.loadMore}
            />
          </section>
        </div>
        <aside className="page-data-rail">
          <section className="section-card" aria-labelledby="recent-changes-title">
            <div className="section-card__heading">
              <div>
                <h2 id="recent-changes-title">Recent changes</h2>
                <p>Newest activity across all stashes.</p>
              </div>
            </div>
            {changes.initialLoading ? <p className="loading-copy">Loading changes…</p> : null}
            {changes.error ? <ErrorBanner error={changes.error} onRetry={changes.retry} /> : null}
            {!changes.initialLoading && !changes.error && newestChanges.length === 0 ? (
              <p className="empty-copy">No changes have been recorded.</p>
            ) : null}
            {newestChanges.length > 0 ? (
              <ul className="changes-list">
                {newestChanges.map((change) => (
                  <ChangeRow key={change.changeId} change={change} showStash />
                ))}
              </ul>
            ) : null}
            <div className="section-card__footer">
              <LoadMore
                hasMore={changes.hasMore}
                loading={changes.loading}
                onLoadMore={changes.loadMore}
              />
            </div>
          </section>
          {isAdmin ? <GcPanel /> : null}
        </aside>
      </div>
      <CreateStashDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          stashes.reset();
        }}
      />
    </Page>
  );
}

export default function HomePage() {
  const { client } = useStashClient();
  const me = useAsync(
    async (signal) => {
      if (!client) throw new Error("Sign in to browse stashes.");
      return clientValue(client.withSignal(signal).me());
    },
    [client],
  );

  if (me.state === "loading") {
    return (
      <Page title="Stashes" description="Browse every stash and the latest activity.">
        <p className="loading-copy">Checking access…</p>
      </Page>
    );
  }
  if (me.state === "error") {
    return (
      <Page title="Stashes" description="Browse every stash and the latest activity.">
        <ErrorBanner error={me.error} onRetry={me.reload} />
      </Page>
    );
  }
  return <HomeContents me={me.value} />;
}
