import type { CommitRecord, CommitResult } from "@takazudo/zudo-history-stash";
import {
  Button,
  CommitDetail,
  Notice,
  RevertCommitDialog,
  useCanWrite,
  useStashHref,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner, clientValue } from "../components/error-banner.js";
import { useAsync } from "../hooks/use-async.js";

export const COMMIT_CREATED_FLASH = "commit-created" as const;
export type CommitCreatedSource = "revert" | "approval";

export interface CommitCreatedLocationState {
  commitFlash: typeof COMMIT_CREATED_FLASH;
  commitId: string;
  source: CommitCreatedSource;
}

export function commitCreatedLocationState(
  commitId: string,
  source: CommitCreatedSource,
): CommitCreatedLocationState {
  return { commitFlash: COMMIT_CREATED_FLASH, commitId, source };
}

function validCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/u.test(value);
}

function commitCreatedFlashFromState(state: unknown): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = state as Partial<CommitCreatedLocationState> & { flash?: unknown };
  if (value.commitFlash === COMMIT_CREATED_FLASH && validCommitId(value.commitId)) {
    if (value.source === "approval") return `Change set approved as commit ${value.commitId}.`;
    if (value.source === "revert") return `Revert complete. Created commit ${value.commitId}.`;
  }
  // Accept the Viewer’s own validated legacy string shape when a host restores a history entry.
  if (typeof value.flash === "string") {
    const match =
      /^(Revert complete\. Created commit|Change set approved as commit) ([A-Za-z0-9:_-]{1,256})\.$/u.exec(
        value.flash,
      );
    return match ? value.flash : null;
  }
  return null;
}

function stateWithoutCommitFlash(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const value = state as Record<string, unknown>;
  if (!("commitFlash" in value) && !("flash" in value)) return state;
  const next = { ...value };
  delete next.commitFlash;
  delete next.commitId;
  delete next.source;
  if (commitCreatedFlashFromState(state) !== null) delete next.flash;
  return Object.keys(next).length === 0 ? null : next;
}

function CommitCreatedFlashNotice({ flash, onDismiss }: { flash: string; onDismiss: () => void }) {
  return (
    <Notice aria-label="Commit creation confirmation" aria-live="polite" variant="success">
      <span>{flash}</span>
      <Button size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </Notice>
  );
}

export default function CommitPage() {
  const { stash, id } = useParams();
  const { client } = useStashClient();
  const hrefFor = useStashHref();
  const navigate = useNavigate();
  const location = useLocation();
  const capability = useCanWrite(stash ?? "");
  const incomingFlash = commitCreatedFlashFromState(location.state);
  const consumedLocationRef = useRef<string | null>(null);
  const [createdFlash, setCreatedFlash] = useState<string | null>(incomingFlash);
  const [revertOpen, setRevertOpen] = useState(false);

  useEffect(() => {
    setRevertOpen(false);
  }, [id, stash]);

  const commit = useAsync<CommitRecord | null>(
    async (signal) => {
      if (!client || !stash || !id) return null;
      return clientValue(client.withSignal(signal).commits(stash).get(id));
    },
    [client, id, stash],
  );
  const reloadCommit = commit.reload;

  useEffect(() => {
    if (incomingFlash !== null) {
      setCreatedFlash(incomingFlash);
      if (consumedLocationRef.current === location.key) return;
      consumedLocationRef.current = location.key;
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: stateWithoutCommitFlash(location.state) },
      );
      return;
    }
    if (consumedLocationRef.current !== null) {
      consumedLocationRef.current = null;
      return;
    }
    setCreatedFlash(null);
  }, [incomingFlash, location, navigate]);

  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        await reloadCommit(signal);
      },
      [reloadCommit],
    ),
  );

  function handleReverted(result: CommitResult) {
    if (!stash) return;
    setRevertOpen(false);
    navigate(hrefFor({ kind: "commit", stash, id: result.id }), {
      state: commitCreatedLocationState(result.id, "revert"),
    });
  }

  const detail = commit.state === "ready" ? commit.value : null;
  return (
    <Page
      title="Commit"
      description={stash ? `Inspect an atomic commit in ${stash}.` : "Inspect an atomic commit."}
      actions={
        stash ? (
          <Link
            className="zhs-button zhs-button--secondary"
            to={hrefFor({ kind: "commits", stash })}
          >
            All commits
          </Link>
        ) : null
      }
    >
      {createdFlash ? (
        <CommitCreatedFlashNotice flash={createdFlash} onDismiss={() => setCreatedFlash(null)} />
      ) : null}
      {!stash || !id ? (
        <ErrorBanner error={new Error("The stash name or commit id is missing from this URL.")} />
      ) : commit.state === "loading" ? (
        <p className="loading-copy" role="status">
          Loading commit…
        </p>
      ) : commit.state === "error" ? (
        <ErrorBanner
          error={commit.error}
          onRetry={() => void commit.reload().catch(() => undefined)}
          title="Could not load commit"
        />
      ) : detail === null ? (
        <ErrorBanner
          error={new Error("The commit response was empty.")}
          title="Could not load commit"
        />
      ) : (
        <>
          <CommitDetail
            key={`${stash}:${detail.id}`}
            stash={stash}
            commit={detail}
            onRevert={
              capability.ready && capability.canWrite ? () => setRevertOpen(true) : undefined
            }
          />
          {revertOpen && capability.ready && capability.canWrite ? (
            <RevertCommitDialog
              stash={stash}
              commit={detail}
              onClose={() => setRevertOpen(false)}
              onSuccess={handleReverted}
            />
          ) : null}
        </>
      )}
    </Page>
  );
}
