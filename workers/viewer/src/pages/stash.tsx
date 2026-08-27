import type { ChangeItem, FileSummary } from "@takazudo/zudo-history-stash";
import {
  Bytes,
  Button,
  ChangeRow,
  DeleteStashDialog,
  LoadMore,
  PathCell,
  RelativeTime,
  useCanWrite,
  useIsAdmin,
  useStashHref,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { proposalListHref } from "../app/proposal-routes.js";
import { Page } from "../app/shell/page.js";
import { Table } from "../app/shell/table.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { useOpenProposalCount } from "../hooks/use-open-proposal-count.js";
import { usePagedData } from "./use-paged-data.js";

const fileKey = (file: FileSummary) => file.path;
const changeKey = (change: ChangeItem) => change.changeId;

function nextBefore(page: {
  nextBefore?: number | null;
  nextSince?: number | null;
}): number | null {
  return page.nextBefore ?? null;
}

function FileTable({ files, stash }: { files: FileSummary[]; stash: string }) {
  return (
    <Table className="data-table data-table--files">
      <thead>
        <tr>
          <th className="data-table__path">Path</th>
          <th className="data-table__version">Head</th>
          <th className="data-table__size data-table__mobile-optional">Size</th>
          <th className="data-table__time data-table__mobile-optional">Updated</th>
          <th className="data-table__status">Status</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr className={file.deleted ? "deleted-row" : undefined} key={file.path}>
            <PathCell
              className="data-table__path"
              path={file.path}
              route={{ kind: "file", stash, path: file.path }}
            />
            <td className="data-table__version">v{file.headVersion}</td>
            <td className="data-table__size data-table__mobile-optional">
              <Bytes value={file.size} />
            </td>
            <td className="data-table__time data-table__mobile-optional">
              <RelativeTime value={file.updatedAt} />
            </td>
            <td className="data-table__status">
              {file.deleted ? <span className="deleted-badge">deleted</span> : "live"}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function StashPage() {
  const { stash } = useParams();
  const navigate = useNavigate();
  const { client } = useStashClient();
  const write = useCanWrite(stash ?? "");
  const admin = useIsAdmin();
  const hrefFor = useStashHref();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const openProposals = useOpenProposalCount(client, stash);
  const files = usePagedData<FileSummary, string>(
    async (signal, after) => {
      if (!client || !stash) return { items: [], nextCursor: null };
      const page = await clientValue(
        client
          .withSignal(signal)
          .files(stash)
          .list({
            includeDeleted,
            ...(after ? { after } : {}),
          }),
      );
      return { items: page.files, nextCursor: page.nextAfter };
    },
    [client, includeDeleted, stash],
    fileKey,
  );
  const changes = usePagedData<ChangeItem, number>(
    async (signal, before) => {
      if (!client || !stash) return { items: [], nextCursor: null };
      const page = await clientValue(
        client
          .withSignal(signal)
          .files(stash)
          .changes({ ...(before ? { before } : {}) }),
      );
      return { items: page.changes, nextCursor: nextBefore(page) };
    },
    [client, stash],
    changeKey,
  );
  const resetFiles = files.reset;
  const resetChanges = changes.reset;
  const reloadOpenProposals = openProposals.reload;
  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        const results = await Promise.allSettled([
          resetFiles(signal),
          resetChanges(signal),
          reloadOpenProposals(signal),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed !== undefined) throw failed.reason;
      },
      [reloadOpenProposals, resetChanges, resetFiles],
    ),
  );

  function handleIncludeDeleted(event: ChangeEvent<HTMLInputElement>) {
    setIncludeDeleted(event.currentTarget.checked);
  }

  const newestChanges = [...changes.items].sort((left, right) => right.changeId - left.changeId);
  return (
    <Page
      title={stash ?? "Stash"}
      description="Files and recent changes in this stash."
      actions={
        stash ? (
          <div className="page-actions">
            <Link className="zhs-button zhs-button--secondary" to={proposalListHref(stash)}>
              {openProposals.state === "ready" && openProposals.value !== null
                ? `Proposals (${openProposals.value} open)`
                : "Proposals"}
            </Link>
            {write.ready && write.canWrite ? (
              <Link
                className="zhs-button zhs-button--primary"
                to={hrefFor({ kind: "new-file", stash })}
              >
                New file
              </Link>
            ) : null}
            {admin.ready && admin.isAdmin ? (
              <>
                <Link
                  className="zhs-button zhs-button--secondary"
                  to={hrefFor({ kind: "tokens", stash })}
                >
                  Tokens
                </Link>
                <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                  Delete stash
                </Button>
              </>
            ) : null}
          </div>
        ) : null
      }
    >
      {!stash ? (
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      ) : null}
      {stash ? (
        <div className="page-data-layout">
          <div className="page-data-main">
            <section className="section-card" aria-labelledby="file-list-title">
              <div className="section-card__heading">
                <div>
                  <h2 id="file-list-title">Files</h2>
                  <p>Open a path to inspect its current body and history.</p>
                </div>
                <label className="toggle-field">
                  <input checked={includeDeleted} onChange={handleIncludeDeleted} type="checkbox" />
                  Include deleted
                </label>
              </div>
              {files.initialLoading ? <p className="loading-copy">Loading files…</p> : null}
              {files.error ? (
                <ErrorBanner
                  error={files.error}
                  onRetry={() => void files.retry().catch(() => undefined)}
                />
              ) : null}
              {!files.initialLoading && !files.error && files.items.length === 0 ? (
                <p className="empty-copy">
                  {includeDeleted ? "This stash has no files." : "This stash has no live files."}
                </p>
              ) : null}
              {files.items.length > 0 ? <FileTable files={files.items} stash={stash} /> : null}
              <div className="section-card__footer">
                <LoadMore
                  hasMore={files.hasMore}
                  loading={files.loading}
                  onLoadMore={files.loadMore}
                />
              </div>
            </section>
          </div>
          <aside className="page-data-rail">
            <section className="section-card" aria-labelledby="stash-changes-title">
              <div className="section-card__heading">
                <div>
                  <h2 id="stash-changes-title">Recent changes</h2>
                  <p>Newest activity in {stash}.</p>
                </div>
              </div>
              {changes.initialLoading ? <p className="loading-copy">Loading changes…</p> : null}
              {changes.error ? (
                <ErrorBanner
                  error={changes.error}
                  onRetry={() => void changes.retry().catch(() => undefined)}
                />
              ) : null}
              {!changes.initialLoading && !changes.error && newestChanges.length === 0 ? (
                <p className="empty-copy">No changes have been recorded.</p>
              ) : null}
              {newestChanges.length > 0 ? (
                <ul className="changes-list">
                  {newestChanges.map((change) => (
                    <ChangeRow key={change.changeId} change={change} />
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
          </aside>
        </div>
      ) : null}
      {stash ? (
        <DeleteStashDialog
          open={deleteOpen}
          stash={stash}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => navigate("/")}
        />
      ) : null}
    </Page>
  );
}
