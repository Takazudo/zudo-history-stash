import type { ChangeItem, MeResponse, StashSummary } from "@takazudo/zudo-history-stash";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { Button } from "../app/shell/button.js";
import { Page } from "../app/shell/page.js";
import { Table } from "../app/shell/table.js";
import {
  ChangeRow,
  ErrorBanner,
  LoadMore,
  RelativeTime,
  clientValue,
  stashErrorMessage,
} from "../components/index.js";
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

function StashTable({ stashes }: { stashes: StashSummary[] }) {
  return (
    <Table className="data-table data-table--stashes">
      <thead>
        <tr>
          <th className="data-table__name">Name</th>
          <th className="data-table__description data-table__mobile-optional">Description</th>
          <th className="data-table__count">Files</th>
          <th className="data-table__time">Last change</th>
          <th className="data-table__time data-table__mobile-optional">Created</th>
        </tr>
      </thead>
      <tbody>
        {stashes.map((stash) => (
          <tr key={stash.name}>
            <td className="data-table__name">
              <Link to={`/s/${stash.name}`}>{stash.name}</Link>
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
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function NewStashForm({ onCreated }: { onCreated: () => void }) {
  const { client } = useStashClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !name.trim()) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSubmitting(true);
    setError(null);

    try {
      const result = await client.withSignal(controller.signal).stashes.create({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setName("");
      setDescription("");
      onCreated();
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError);
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <section className="section-card" aria-labelledby="new-stash-title">
      <div className="section-card__heading">
        <div>
          <h2 id="new-stash-title">New stash</h2>
          <p>Create an empty namespace for versioned files.</p>
        </div>
      </div>
      <div className="section-card__body">
        <form className="new-stash-form" onSubmit={handleSubmit}>
          <label className="form-field">
            <span className="form-field__label">Name</span>
            <input
              className="form-field__input"
              name="name"
              pattern="[a-z0-9][a-z0-9-]{0,62}"
              required
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-field__label">Description</span>
            <input
              className="form-field__input"
              name="description"
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <div className="form-actions">
            <Button disabled={submitting} type="submit" variant="primary">
              {submitting ? "Creating…" : "Create stash"}
            </Button>
          </div>
        </form>
        {error ? (
          <div className="form-error" role="alert">
            {stashErrorMessage(error)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function HomeContents({ me }: { me: MeResponse }) {
  const { client } = useStashClient();
  const isAdmin = me.principal === "admin";
  const stashes = usePagedData<StashSummary, string>(
    async (signal, after) => {
      if (!client || !isAdmin) return { items: [], nextCursor: null };
      const page = await clientValue(
        client.withSignal(signal).stashes.list({ ...(after ? { after } : {}) }),
      );
      return { items: page.stashes, nextCursor: page.nextAfter };
    },
    [client, isAdmin],
    stashKey,
  );
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
    <Page title="Stashes" description="Browse every stash and the latest activity.">
      <div className="page-data-layout">
        <div className="page-data-main section-stack">
          <NewStashForm onCreated={stashes.reset} />
          <section className="section-card" aria-labelledby="stash-directory-title">
            <div className="section-card__heading">
              <div>
                <h2 id="stash-directory-title">Stash directory</h2>
                <p>Live and deleted file counts are shown separately.</p>
              </div>
            </div>
            {stashes.initialLoading ? <p className="loading-copy">Loading stashes…</p> : null}
            {stashes.error ? <ErrorBanner error={stashes.error} onRetry={stashes.retry} /> : null}
            {!stashes.initialLoading && !stashes.error && stashes.items.length === 0 ? (
              <p className="empty-copy">No stashes yet. Create the first one above.</p>
            ) : null}
            {stashes.items.length > 0 ? <StashTable stashes={stashes.items} /> : null}
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
        </aside>
      </div>
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
