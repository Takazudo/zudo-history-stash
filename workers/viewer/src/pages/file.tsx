import type {
  FileGetResult,
  FileRecordWithEtag,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import {
  Button,
  FileContent,
  fileContentAccess,
  fileRepresentation,
  Bytes,
  DeleteFileDialog,
  HistoryList,
  KindBadge,
  Notice,
  RelativeTime,
  TombstoneRestore,
  useCanWrite,
  useFileHistory,
  useStashHref,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { useViewerLiveRefresh } from "../app/live-updates.js";
import { proposalListHref } from "../app/proposal-routes.js";
import { Badge } from "../app/shell/badge.js";
import { Page } from "../app/shell/page.js";
import { ErrorBanner } from "../components/error-banner.js";
import { useAsync } from "../hooks/use-async.js";
import { useOpenProposalCount } from "../hooks/use-open-proposal-count.js";

function isVersionKind(value: unknown): value is FileRecordWithEtag["kind"] {
  return value === "put" || value === "delete" || value === "rollback";
}

function isFileRecord(value: unknown): value is FileRecordWithEtag {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FileRecordWithEtag>;
  return (
    typeof record.path === "string" &&
    typeof record.version === "number" &&
    isVersionKind(record.kind) &&
    typeof record.size === "number" &&
    typeof record.author === "string" &&
    typeof record.message === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.deleted === "boolean" &&
    (typeof record.hash === "string" || record.hash === null) &&
    (typeof record.body === "string" || record.body === null)
  );
}

function fileResultValue(result: FileGetResult): FileRecordWithEtag {
  if (!result.ok) throw result;
  if ("notModified" in result) {
    throw new Error("The file response was unexpectedly not modified.");
  }
  if (!isFileRecord(result.value)) throw new Error("The file response was malformed.");
  return result.value;
}

async function loadFile(
  files: StashFilesClient,
  path: string,
  requestedVersion: number | null,
): Promise<FileRecordWithEtag> {
  if (requestedVersion !== null) {
    return fileResultValue(await files.get(path, { version: requestedVersion }));
  }

  const head = await files.get(path);
  if (
    !head.ok &&
    head.error.code === "file-deleted" &&
    head.current &&
    Number.isInteger(head.current.version)
  ) {
    return fileResultValue(await files.get(path, { version: head.current.version }));
  }
  return fileResultValue(head);
}

function shortHash(hash: string): string {
  const prefix = "sha256-";
  if (!hash.startsWith(prefix)) return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash;
  const digest = hash.slice(prefix.length);
  return digest.length > 12 ? `${prefix}${digest.slice(0, 12)}…` : hash;
}

function FileActions({
  file,
  stash,
  path,
  versions,
  currentHead,
  onChanged,
}: {
  file: FileRecordWithEtag;
  stash: string;
  path: string;
  versions: readonly VersionRecord[];
  currentHead: boolean;
  onChanged: () => void;
}) {
  const capability = useCanWrite(stash);
  const hrefFor = useStashHref();
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => setDeleteOpen(false), [file.version, path, stash]);

  if (!capability.ready || !capability.canWrite) return null;

  if (currentHead && file.deleted) {
    return (
      <div className="form-actions">
        <TombstoneRestore
          head={file}
          path={path}
          stash={stash}
          versions={versions}
          onChanged={onChanged}
        />
      </div>
    );
  }

  if (file.deleted) return null;

  const textEditorAvailable =
    file.representation !== "binary" && file.contentAccess !== "raw" && file.body !== null;

  return (
    <div className="form-actions">
      {textEditorAvailable ? (
        <Link
          className="zhs-button zhs-button--primary"
          to={hrefFor({
            kind: "edit",
            stash,
            path,
            from: currentHead ? undefined : file.version,
          })}
        >
          {currentHead ? "Edit" : "Edit from this version"}
        </Link>
      ) : null}
      {currentHead ? (
        <>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete…
          </Button>
          <DeleteFileDialog
            headVersion={file.version}
            open={deleteOpen}
            path={path}
            stash={stash}
            onChanged={() => {
              setDeleteOpen(false);
              onChanged();
            }}
            onClose={() => setDeleteOpen(false)}
          />
        </>
      ) : null}
    </div>
  );
}

function FileDetails({
  file,
  stash,
  path,
  headVersion,
  requestedVersion,
  lastLiveVersion,
  versions,
  onChanged,
}: {
  file: FileRecordWithEtag;
  stash: string;
  path: string;
  headVersion?: number;
  requestedVersion: number | null;
  lastLiveVersion?: VersionRecord;
  versions: readonly VersionRecord[];
  onChanged: () => void;
}) {
  const hrefFor = useStashHref();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [file.hash, file.version, path]);

  async function copyHash() {
    if (!file.hash) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(file.hash);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const author = file.author || "unknown author";
  const viewingHistoricalVersion = requestedVersion !== null;
  const representation = fileRepresentation(file);
  const contentAccess = fileContentAccess(file);
  const contentType = file.contentType || "unknown";
  return (
    <>
      {viewingHistoricalVersion ? (
        <div className="file-version-banner" role="status">
          <p>
            Viewing v{file.version}
            {headVersion ? ` — head is v${headVersion}.` : "."}
          </p>
          <Link to={hrefFor({ kind: "file", stash, path })}>Return to head</Link>
        </div>
      ) : null}

      {file.deleted ? (
        <div className="file-tombstone-state" role="status">
          <p>
            <strong>Deleted at v{file.version}</strong> by {author}.
          </p>
          {lastLiveVersion ? (
            <Link
              to={hrefFor({
                kind: "file",
                stash,
                path,
                version: lastLiveVersion.version,
              })}
            >
              View last live version v{lastLiveVersion.version}
            </Link>
          ) : null}
        </div>
      ) : null}

      <FileActions
        currentHead={!viewingHistoricalVersion}
        file={file}
        path={path}
        stash={stash}
        versions={versions}
        onChanged={onChanged}
      />

      <section className="section-card" aria-labelledby="file-metadata-title">
        <div className="section-card__heading">
          <div>
            <h2 id="file-metadata-title">File metadata</h2>
            <p>
              {contentAccess === "deleted"
                ? "Tombstone representation."
                : contentAccess === "raw"
                  ? `Raw ${representation} content is fetched only when requested.`
                  : "Inline text representation."}
            </p>
          </div>
        </div>
        <dl className="file-metadata">
          <div className="file-metadata__item file-metadata__item--path">
            <dt>Path</dt>
            <dd className="path-cell file-metadata__path">{file.path}</dd>
          </div>
          <div className="file-metadata__item">
            <dt>Version</dt>
            <dd>
              v{file.version} <KindBadge kind={file.kind} />
            </dd>
          </div>
          <div className="file-metadata__item">
            <dt>Hash</dt>
            <dd className="file-metadata__hash">
              {file.hash ? (
                <>
                  <code title={file.hash}>{shortHash(file.hash)}</code>
                  <Button size="sm" onClick={() => void copyHash()}>
                    {copyState === "copied"
                      ? "Copied"
                      : copyState === "error"
                        ? "Copy failed"
                        : "Copy hash"}
                  </Button>
                </>
              ) : (
                <span className="muted">Deleted</span>
              )}
            </dd>
          </div>
          <div className="file-metadata__item">
            <dt>Representation</dt>
            <dd>{representation}</dd>
          </div>
          <div className="file-metadata__item">
            <dt>Content access</dt>
            <dd>{contentAccess}</dd>
          </div>
          <div className="file-metadata__item">
            <dt>Content type</dt>
            <dd>{contentType}</dd>
          </div>
          <div className="file-metadata__item">
            <dt>ETag</dt>
            <dd>
              <code>{file.etag || "—"}</code>
            </dd>
          </div>
          <div className="file-metadata__item">
            <dt>Size</dt>
            <dd>
              <Bytes value={file.byteSize ?? file.size} />
            </dd>
          </div>
          <div className="file-metadata__item">
            <dt>Author</dt>
            <dd>{file.author || "—"}</dd>
          </div>
          <div className="file-metadata__item">
            <dt>Updated</dt>
            <dd>
              <RelativeTime value={file.createdAt} />
            </dd>
          </div>
          <div className="file-metadata__item file-metadata__item--message">
            <dt>Message</dt>
            <dd className="file-metadata__message">
              {file.message || <span className="muted">No message</span>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="section-card file-body-card" aria-labelledby="file-body-title">
        <div className="section-card__heading">
          <div>
            <h2 id="file-body-title">Body</h2>
            <p>
              {contentAccess === "deleted"
                ? "Deleted versions do not contain content."
                : contentAccess === "raw"
                  ? representation === "text"
                    ? "Raw UTF-8 text is bounded before preview."
                    : "Binary content is never decoded as text."
                  : "Stored exactly as written."}
            </p>
          </div>
        </div>
        <FileContent
          file={file}
          path={path}
          stash={stash}
          version={viewingHistoricalVersion ? file.version : undefined}
        />
      </section>
    </>
  );
}

function FileRouteContent({
  stash,
  path,
  requestedVersion,
}: {
  stash: string;
  path: string;
  requestedVersion: number | null;
}) {
  const { client } = useStashClient();
  const navigate = useNavigate();
  const hrefFor = useStashHref();
  const openProposals = useOpenProposalCount(client, stash, path);
  const file = useAsync(
    async (signal) => {
      if (!client) throw new Error("Sign in to inspect this file.");
      return loadFile(client.withSignal(signal).files(stash), path, requestedVersion);
    },
    [client, path, requestedVersion, stash],
  );
  const history = useFileHistory(stash, path);
  const reloadFile = file.reload;
  const reloadHistory = history.reload;
  const reloadOpenProposals = openProposals.reload;
  useViewerLiveRefresh(
    useCallback(
      async ({ signal }) => {
        const results = await Promise.allSettled([
          reloadFile(signal),
          reloadHistory(signal),
          reloadOpenProposals(signal),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed !== undefined) throw failed.reason;
      },
      [reloadFile, reloadHistory, reloadOpenProposals],
    ),
  );
  const historyPage = history.state === "ready" ? history.page : null;
  const lastLiveVersion =
    file.state === "ready" && file.value.deleted && historyPage
      ? historyPage.versions.find(
          (version) => version.version < file.value.version && version.kind !== "delete",
        )
      : undefined;

  function refreshAfterChange() {
    void file.reload().catch(() => undefined);
    void history.reload().catch(() => undefined);
  }

  function refreshAfterRollback() {
    // HistoryList has already appended the successful rollback and its toast. Reload only the
    // representation here so that local confirmation remains visible while the new head arrives.
    if (requestedVersion === null) {
      void file.reload().catch(() => undefined);
      return;
    }
    navigate(hrefFor({ kind: "file", stash, path }), { replace: true });
  }

  return (
    <div className="file-detail-layout">
      {openProposals.state === "ready" &&
      openProposals.value !== null &&
      openProposals.value > 0 ? (
        <div>
          <Link
            aria-label={`${openProposals.value} open ${openProposals.value === 1 ? "proposal" : "proposals"} for ${path}`}
            to={proposalListHref(stash, { path })}
          >
            <Badge>
              {openProposals.value} open {openProposals.value === 1 ? "proposal" : "proposals"}
            </Badge>
          </Link>
        </div>
      ) : null}
      {file.state === "loading" ? <p className="loading-copy">Loading file…</p> : null}
      {file.state === "error" ? (
        <ErrorBanner
          error={file.error}
          onRetry={() => void file.reload().catch(() => undefined)}
          title="Could not load file"
        />
      ) : null}
      {file.state === "ready" ? (
        <FileDetails
          file={file.value}
          headVersion={historyPage?.headVersion}
          lastLiveVersion={lastLiveVersion}
          path={path}
          requestedVersion={requestedVersion}
          stash={stash}
          versions={historyPage?.versions ?? []}
          onChanged={refreshAfterChange}
        />
      ) : null}

      {history.state === "loading" ? (
        <section className="section-card" aria-label="History">
          <p className="loading-copy">Loading history…</p>
        </section>
      ) : null}
      {history.state === "error" ? (
        <ErrorBanner
          error={history.error}
          onRetry={() => void history.reload().catch(() => undefined)}
          title="Could not load history"
        />
      ) : null}
      {history.state === "ready" ? (
        <HistoryList
          key={`${stash}:${path}`}
          loadMoreError={history.loadMoreError}
          loadingMore={history.loadingMore}
          page={history.page}
          path={path}
          stash={stash}
          viewedVersion={
            file.state === "ready" ? file.value.version : (requestedVersion ?? undefined)
          }
          onLoadMore={history.loadMore}
          onRollbackComplete={refreshAfterRollback}
        />
      ) : null}
    </div>
  );
}

function positiveVersion(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function saveFlashFromState(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("flash" in state)) return null;
  const flash = (state as { flash?: unknown }).flash;
  if (typeof flash !== "string") return null;
  return /^(?:Saved v[1-9]\d*|No write was needed; the file already matches v[1-9]\d*)\.$/u.test(
    flash,
  )
    ? flash
    : null;
}

function stateWithoutFlash(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("flash" in state)) {
    return state;
  }
  const next = { ...(state as Record<string, unknown>) };
  delete next.flash;
  return Object.keys(next).length === 0 ? null : next;
}

export default function FilePage() {
  const { stash, "*": path } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const incomingSaveFlash = saveFlashFromState(location.state);
  const consumedLocationRef = useRef<string | null>(null);
  const [saveFlash, setSaveFlash] = useState<string | null>(incomingSaveFlash);
  const versionParam = searchParams.get("version");
  const requestedVersion = positiveVersion(versionParam);
  const invalidVersion = versionParam !== null && requestedVersion === null;

  useEffect(() => {
    if (incomingSaveFlash !== null) {
      setSaveFlash(incomingSaveFlash);
      consumedLocationRef.current = location.key;
      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
        { replace: true, state: stateWithoutFlash(location.state) },
      );
      return;
    }

    // The replace above produces a new location key. Keep the visible confirmation for that one
    // transition, then clear it normally when a later navigation reaches this route without one.
    if (consumedLocationRef.current !== null) {
      consumedLocationRef.current = null;
      return;
    }
    setSaveFlash(null);
  }, [
    incomingSaveFlash,
    location.hash,
    location.key,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  return (
    <Page title={path ?? "File"} description="File content and append-only version history.">
      {saveFlash ? (
        <Notice aria-label="Save confirmation" aria-live="polite" variant="success">
          <span>{saveFlash}</span>
          <Button size="sm" onClick={() => setSaveFlash(null)}>
            Dismiss
          </Button>
        </Notice>
      ) : null}
      {!stash || !path ? (
        <ErrorBanner error={new Error("The stash name or file path is missing from this URL.")} />
      ) : invalidVersion ? (
        <ErrorBanner error={new Error("The version query must be a positive integer.")} />
      ) : (
        <FileRouteContent path={path} requestedVersion={requestedVersion} stash={stash} />
      )}
    </Page>
  );
}
