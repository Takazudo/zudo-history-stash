import type {
  FileGetResult,
  FileRecordWithEtag,
  HistoryPage,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { Button } from "../app/shell/button.js";
import { Page } from "../app/shell/page.js";
import { Bytes, clientValue, ErrorBanner, KindBadge, RelativeTime } from "../components/index.js";
import { HistoryList } from "../components/history-list.js";
import { useAsync } from "../hooks/use-async.js";

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

function isHistoryPage(value: unknown): value is HistoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<HistoryPage>;
  return (
    typeof page.path === "string" &&
    typeof page.headVersion === "number" &&
    typeof page.deleted === "boolean" &&
    typeof page.total === "number" &&
    Array.isArray(page.versions) &&
    page.versions.every(
      (version) =>
        typeof version.version === "number" &&
        isVersionKind(version.kind) &&
        typeof version.author === "string" &&
        typeof version.message === "string" &&
        typeof version.createdAt === "string",
    ) &&
    (typeof page.nextBefore === "number" || page.nextBefore === null)
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

function FileDetails({
  file,
  stash,
  path,
  headVersion,
  requestedVersion,
  lastLiveVersion,
}: {
  file: FileRecordWithEtag;
  stash: string;
  path: string;
  headVersion?: number;
  requestedVersion: number | null;
  lastLiveVersion?: VersionRecord;
}) {
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    setWrapLongLines(false);
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
  return (
    <>
      {viewingHistoricalVersion ? (
        <div className="file-version-banner" role="status">
          <p>
            Viewing v{file.version}
            {headVersion ? ` — head is v${headVersion}.` : "."}
          </p>
          <Link to={`/s/${stash}/f/${path}`}>Return to head</Link>
        </div>
      ) : null}

      {file.deleted ? (
        <div className="file-tombstone-state" role="status">
          <p>
            <strong>Deleted at v{file.version}</strong> by {author}.
          </p>
          {lastLiveVersion ? (
            <Link to={`/s/${stash}/f/${path}?version=${lastLiveVersion.version}`}>
              View last live version v{lastLiveVersion.version}
            </Link>
          ) : null}
        </div>
      ) : null}

      <section className="section-card" aria-labelledby="file-metadata-title">
        <div className="section-card__heading">
          <div>
            <h2 id="file-metadata-title">File metadata</h2>
            <p>{file.deleted ? "Tombstone representation." : "Stored text representation."}</p>
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
                  <Button compact onClick={copyHash}>
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
            <dt>Size</dt>
            <dd>
              <Bytes value={file.size} />
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
              {file.deleted
                ? "Deleted versions do not contain text."
                : "Stored exactly as written."}
            </p>
          </div>
          {!file.deleted ? (
            <label className="toggle-field">
              <input
                checked={wrapLongLines}
                type="checkbox"
                onChange={(event) => setWrapLongLines(event.currentTarget.checked)}
              />
              Wrap long lines
            </label>
          ) : null}
        </div>
        {file.deleted ? (
          <p className="file-body-empty">This version is a tombstone; it has no body.</p>
        ) : (
          <pre
            className={`file-body-pane${wrapLongLines ? " file-body-pane--wrap" : ""}`}
            data-wrap-long-lines={wrapLongLines ? "true" : "false"}
            tabIndex={0}
          >
            {file.body ?? ""}
          </pre>
        )}
      </section>
    </>
  );
}

export default function FilePage() {
  const { stash, "*": path } = useParams();
  const [searchParams] = useSearchParams();
  const { client } = useStashClient();
  const versionParam = searchParams.get("version");
  const requestedVersion =
    versionParam && /^[1-9]\d*$/u.test(versionParam) ? Number.parseInt(versionParam, 10) : null;
  const invalidVersion = versionParam !== null && requestedVersion === null;

  const file = useAsync(
    async (signal) => {
      if (!client) throw new Error("Sign in to inspect this file.");
      if (!stash || !path) throw new Error("The stash name or file path is missing from this URL.");
      if (invalidVersion) throw new Error("The version query must be a positive integer.");
      return loadFile(client.withSignal(signal).files(stash), path, requestedVersion);
    },
    [client, invalidVersion, path, requestedVersion, stash],
  );
  const history = useAsync<HistoryPage>(
    async (signal) => {
      if (!client) throw new Error("Sign in to inspect this file.");
      if (!stash || !path) throw new Error("The stash name or file path is missing from this URL.");
      const value = await clientValue(client.withSignal(signal).files(stash).history(path));
      if (!isHistoryPage(value)) throw new Error("The history response was malformed.");
      return value;
    },
    [client, path, stash],
  );

  const lastLiveVersion =
    file.state === "ready" && file.value.deleted && history.state === "ready"
      ? history.value.versions.find(
          (version) => version.version < file.value.version && version.kind !== "delete",
        )
      : undefined;

  return (
    <Page title={path ?? "File"} description="File content and append-only version history.">
      <div className="file-detail-layout">
        {file.state === "loading" ? <p className="loading-copy">Loading file…</p> : null}
        {file.state === "error" ? (
          <ErrorBanner error={file.error} onRetry={file.reload} title="Could not load file" />
        ) : null}
        {file.state === "ready" && stash && path ? (
          <FileDetails
            file={file.value}
            headVersion={history.state === "ready" ? history.value.headVersion : undefined}
            lastLiveVersion={lastLiveVersion}
            path={path}
            requestedVersion={requestedVersion}
            stash={stash}
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
            onRetry={history.reload}
            title="Could not load history"
          />
        ) : null}
        {history.state === "ready" && client && stash && path ? (
          <HistoryList
            client={client}
            key={`${stash}:${path}`}
            onRollbackComplete={file.reload}
            page={history.value}
            path={path}
            stash={stash}
            viewedVersion={
              file.state === "ready" ? file.value.version : (requestedVersion ?? undefined)
            }
          />
        ) : null}
      </div>
    </Page>
  );
}
