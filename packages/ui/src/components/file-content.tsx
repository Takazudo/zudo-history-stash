import type { FileRecordWithEtag, RawDownload } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Notice } from "../primitives/notice.js";
import { ErrorBanner } from "./error-banner.js";

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DEFAULT_TEXT_PREVIEW_BYTES = 1_048_576;
const DEFAULT_IMAGE_PREVIEW_BYTES = 16 * 1_048_576;
/** Keep the compatibility download path bounded when the File System Access API is absent. */
export const MAX_BLOB_DOWNLOAD_BYTES = 32 * 1_048_576;

interface SaveFileWritable extends WritableStream<Uint8Array> {
  close(): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<SaveFileWritable>;
}

type SaveFilePicker = (options: { suggestedName: string }) => Promise<SaveFileHandle>;

export type FileRepresentation = "text" | "binary";
export type FileContentAccess = "inline" | "raw" | "deleted";

export interface FileContentProps {
  file: FileRecordWithEtag;
  stash: string;
  path: string;
  /** Omit for the current head; provide this only when viewing a historical route. */
  version?: number;
  /** Bound text materialization so raw oversized text never fills the page or heap unchecked. */
  maxTextPreviewBytes?: number;
  /** Raster previews are deliberately bounded independently from upload capabilities. */
  maxImagePreviewBytes?: number;
}

type RawContentState =
  | { state: "loading" }
  | { state: "text"; text: string; contentType: string; truncated: false }
  | { state: "text-too-large"; contentType: string; limit: number }
  | {
      state: "binary";
      contentType: string;
      previewUrl: string | null;
      previewBlocked: boolean;
    }
  | { state: "error"; error: unknown };

function normalizedType(value: string | undefined): string {
  return (
    (value ?? "application/octet-stream").split(";", 1)[0]?.trim().toLowerCase() ??
    "application/octet-stream"
  );
}

export function fileRepresentation(
  file: Pick<FileRecordWithEtag, "body" | "deleted" | "representation">,
): FileRepresentation {
  if (file.representation === "binary") return "binary";
  return file.representation === "text" || file.body !== null || file.deleted ? "text" : "binary";
}

export function fileContentAccess(
  file: Pick<FileRecordWithEtag, "body" | "deleted" | "contentAccess">,
): FileContentAccess {
  if (file.deleted) return "deleted";
  if (file.contentAccess === "raw" || file.body === null) return "raw";
  return "inline";
}

function filename(path: string): string {
  const last = path.split("/").pop() || "download";
  const safe = [...last]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character === '"' || character === "\\"
        ? "_"
        : character;
    })
    .join("");
  return safe || "download";
}

function closeResponseBody(value: RawDownload): void {
  void value.response.body?.cancel().catch(() => undefined);
}

function createOwnedBlobUrl(blob: Blob): string {
  if (typeof URL.createObjectURL !== "function") {
    throw new Error("Blob downloads are unavailable in this browser.");
  }
  return URL.createObjectURL(blob);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function saveFilePicker(): SaveFilePicker | null {
  const candidate = (globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  return typeof candidate === "function" ? candidate : null;
}

function requestSaveFile(suggestedName: string): Promise<SaveFileHandle> | null {
  const picker = saveFilePicker();
  return picker === null ? null : picker({ suggestedName });
}

async function boundedBlob(response: Response, size: number, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw abortError(signal);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_DOWNLOAD_BYTES) {
    throw new RangeError(
      `This browser cannot buffer a raw download larger than ${MAX_BLOB_DOWNLOAD_BYTES} bytes.`,
    );
  }
  const body = response.body;
  if (body === null) {
    if (size === 0) return new Blob([]);
    throw new Error("This browser cannot stream the raw download.");
  }
  const reader = body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BLOB_DOWNLOAD_BYTES) {
        void reader.cancel("download materialization limit exceeded").catch(() => undefined);
        throw new RangeError(
          `This browser cannot buffer a raw download larger than ${MAX_BLOB_DOWNLOAD_BYTES} bytes.`,
        );
      }
      const copy = new ArrayBuffer(next.value.byteLength);
      new Uint8Array(copy).set(next.value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw abortError(signal);
  return new Blob(chunks);
}

/**
 * Save a raw response without buffering R2-scale objects in browser memory.
 * Returns an owned object URL only for the deliberately bounded compatibility path.
 */
export async function saveRawDownload(
  value: RawDownload,
  suggestedName: string,
  signal: AbortSignal,
  selectedHandle?: SaveFileHandle | null,
): Promise<string | null> {
  const body = value.body ?? value.response.body;
  try {
    const handle =
      selectedHandle === undefined
        ? await (requestSaveFile(suggestedName) ?? Promise.resolve(null))
        : selectedHandle;
    if (handle !== null && (body !== null || value.size === 0)) {
      const writable = await handle.createWritable();
      try {
        if (signal.aborted) throw abortError(signal);
        if (body === null) await writable.close();
        else await body.pipeTo(writable, { signal });
      } catch (error: unknown) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
      return null;
    }

    const blob = await boundedBlob(value.response, value.size, signal);
    return createOwnedBlobUrl(blob);
  } catch (error: unknown) {
    closeResponseBody(value);
    throw error;
  }
}

function isRangeLimit(error: unknown): boolean {
  return error instanceof RangeError;
}

function inlineTextBody(file: FileRecordWithEtag, wrapLongLines: boolean): ReactElement {
  return (
    <pre
      className={`file-body-pane${wrapLongLines ? " file-body-pane--wrap" : ""}`}
      data-wrap-long-lines={wrapLongLines ? "true" : "false"}
      tabIndex={0}
    >
      {file.body ?? ""}
    </pre>
  );
}

function RawFileBody({
  file,
  stash,
  path,
  version,
  maxTextPreviewBytes,
  maxImagePreviewBytes,
}: FileContentProps) {
  const clientForSignal = useStashClientForSignal();
  const [raw, setRaw] = useState<RawContentState>({ state: "loading" });
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");
  const previewUrlRef = useRef<string | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const downloadControllerRef = useRef<AbortController | null>(null);
  const textLimit = maxTextPreviewBytes ?? DEFAULT_TEXT_PREVIEW_BYTES;
  const imageLimit = maxImagePreviewBytes ?? DEFAULT_IMAGE_PREVIEW_BYTES;
  const representation = fileRepresentation(file);
  const historicalVersion = version;

  const revokePreviewUrl = useCallback(() => {
    const url = previewUrlRef.current;
    previewUrlRef.current = null;
    if (url !== null && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  }, []);

  const revokeDownloadUrl = useCallback(() => {
    const url = downloadUrlRef.current;
    downloadUrlRef.current = null;
    if (url !== null && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    revokePreviewUrl();
    setRaw({ state: "loading" });
    setWrapLongLines(false);
    const files = clientForSignal(controller.signal).files(stash);
    const options =
      historicalVersion === undefined
        ? { signal: controller.signal }
        : { version: historicalVersion, signal: controller.signal };
    void files.raw
      .get(path, options)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) throw result;
        if ("notModified" in result)
          throw new Error("The raw content was unexpectedly not modified.");
        const contentType =
          result.value.contentType || file.contentType || "application/octet-stream";
        if (representation === "text") {
          try {
            const text = await result.value.text(textLimit);
            if (controller.signal.aborted) return;
            closeResponseBody(result.value);
            setRaw({ state: "text", text, contentType, truncated: false });
          } catch (error: unknown) {
            closeResponseBody(result.value);
            if (controller.signal.aborted) return;
            if (isRangeLimit(error))
              setRaw({ state: "text-too-large", contentType, limit: textLimit });
            else setRaw({ state: "error", error });
          }
          return;
        }

        const declaredType = normalizedType(file.contentType);
        const responseType = normalizedType(contentType);
        const previewable = RASTER_TYPES.has(declaredType) && declaredType === responseType;
        if (!previewable) {
          closeResponseBody(result.value);
          setRaw({ state: "binary", contentType, previewUrl: null, previewBlocked: true });
          return;
        }
        try {
          const bytes = await result.value.bytes(imageLimit);
          if (controller.signal.aborted) return;
          closeResponseBody(result.value);
          if (typeof URL.createObjectURL !== "function") {
            setRaw({ state: "binary", contentType, previewUrl: null, previewBlocked: true });
            return;
          }
          // Copy into an owned ArrayBuffer so this remains a valid BlobPart with
          // TypeScript's SharedArrayBuffer-aware typed-array definitions.
          const buffer = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buffer).set(bytes);
          const url = URL.createObjectURL(new Blob([buffer], { type: contentType }));
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          previewUrlRef.current = url;
          setRaw({ state: "binary", contentType, previewUrl: url, previewBlocked: false });
        } catch {
          closeResponseBody(result.value);
          if (controller.signal.aborted) return;
          setRaw({ state: "binary", contentType, previewUrl: null, previewBlocked: true });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRaw({ state: "error", error });
      });

    return () => {
      controller.abort();
      downloadControllerRef.current?.abort();
      revokePreviewUrl();
      revokeDownloadUrl();
    };
  }, [
    clientForSignal,
    file.contentType,
    file.etag,
    file.hash,
    historicalVersion,
    imageLimit,
    path,
    representation,
    revokeDownloadUrl,
    revokePreviewUrl,
    stash,
    textLimit,
  ]);

  useEffect(() => {
    return () => downloadControllerRef.current?.abort();
  }, []);

  async function download(): Promise<void> {
    downloadControllerRef.current?.abort();
    revokeDownloadUrl();
    const controller = new AbortController();
    downloadControllerRef.current = controller;
    setDownloadState("loading");
    let downloaded: RawDownload | null = null;
    try {
      const suggestedName = filename(path);
      // Request the native save destination before the first network await so Chromium's
      // transient user activation is still available to showSaveFilePicker().
      const saveHandleRequest = requestSaveFile(suggestedName);
      const selectedHandle = saveHandleRequest === null ? null : await saveHandleRequest;
      const files = clientForSignal(controller.signal).files(stash);
      const options =
        historicalVersion === undefined
          ? { signal: controller.signal }
          : { version: historicalVersion, signal: controller.signal };
      const result = await files.raw.get(path, options);
      if (!result.ok) throw result;
      if ("notModified" in result)
        throw new Error("The raw content was unexpectedly not modified.");
      downloaded = result.value;
      const url = await saveRawDownload(
        result.value,
        suggestedName,
        controller.signal,
        selectedHandle,
      );
      if (controller.signal.aborted) {
        if (url !== null && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
        return;
      }
      // File System Access downloads are written directly from the authenticated response
      // stream; only the bounded compatibility path returns an object URL.
      if (url === null) {
        setDownloadState("idle");
        return;
      }
      downloadUrlRef.current = url;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename(path);
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => {
        if (downloadUrlRef.current === url) revokeDownloadUrl();
      }, 1_000);
      setDownloadState("idle");
    } catch (error: unknown) {
      if (downloaded !== null) closeResponseBody(downloaded);
      if (!controller.signal.aborted) {
        if (isAbortError(error)) {
          setDownloadState("idle");
          return;
        }
        revokeDownloadUrl();
        setDownloadState("error");
        setRaw({ state: "error", error });
      }
    } finally {
      if (downloadControllerRef.current === controller) downloadControllerRef.current = null;
    }
  }

  const downloadButton = (
    <Button disabled={downloadState === "loading"} onClick={() => void download()}>
      {downloadState === "loading"
        ? "Preparing download…"
        : `Download ${historicalVersion === undefined ? "current " : `v${historicalVersion} `}raw content`}
    </Button>
  );

  return (
    <>
      {raw.state === "loading" ? (
        <p className="file-body-empty" role="status">
          Loading raw content…
        </p>
      ) : null}
      {raw.state === "error" ? (
        <div className="file-content__error">
          <ErrorBanner error={raw.error} title="Could not load raw content" />
          {downloadButton}
        </div>
      ) : null}
      {raw.state === "text" ? (
        <>
          <div className="file-content__toolbar">
            <span>Raw UTF-8 text · {raw.contentType}</span>
            <label className="toggle-field">
              <input
                checked={wrapLongLines}
                type="checkbox"
                onChange={(event) => setWrapLongLines(event.currentTarget.checked)}
              />
              Wrap long lines
            </label>
            {downloadButton}
          </div>
          {inlineTextBody({ ...file, body: raw.text }, wrapLongLines)}
        </>
      ) : null}
      {raw.state === "text-too-large" ? (
        <div className="file-content__download-only">
          <Notice variant="info">
            <strong>Raw text is too large to preview</strong>
            <span>
              Download the UTF-8 content to inspect it. The preview is bounded at{" "}
              {formatBytes(raw.limit)}.
            </span>
          </Notice>
          {downloadButton}
        </div>
      ) : null}
      {raw.state === "binary" ? (
        <div className="file-content__download-only">
          {raw.previewUrl && !raw.previewBlocked ? (
            <figure className="file-content__preview">
              <img
                alt={`Preview of ${path}`}
                src={raw.previewUrl}
                onError={() => {
                  revokePreviewUrl();
                  setRaw({ ...raw, previewUrl: null, previewBlocked: true });
                }}
              />
              <figcaption>{raw.contentType} preview. Active content is never embedded.</figcaption>
            </figure>
          ) : (
            <Notice variant="info">
              <strong>Binary content is download-only</strong>
              <span>
                {raw.previewBlocked
                  ? `${raw.contentType} is not an allowlisted raster preview.`
                  : "Preview unavailable."}{" "}
                No active content is embedded.
              </span>
            </Notice>
          )}
          {downloadButton}
        </div>
      ) : null}
    </>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function InlineTextBody({
  file,
  path,
  version,
}: {
  file: FileRecordWithEtag;
  path: string;
  version?: number;
}) {
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "error">("idle");
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    setWrapLongLines(false);
    setDownloadState("idle");
    return () => {
      if (urlRef.current !== null && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(urlRef.current);
      }
      urlRef.current = null;
    };
  }, [file.etag, file.hash, path, version]);

  function download(): void {
    if (urlRef.current !== null && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    try {
      const url = createOwnedBlobUrl(
        new Blob([file.body ?? ""], { type: file.contentType || "text/plain; charset=utf-8" }),
      );
      urlRef.current = url;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename(path);
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => {
        if (urlRef.current === url && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(url);
          urlRef.current = null;
        }
      }, 1_000);
      setDownloadState("idle");
    } catch {
      if (urlRef.current !== null && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      setDownloadState("error");
    }
  }

  return (
    <>
      <div className="file-content__toolbar">
        <span>Inline UTF-8 text · {file.contentType || "text/plain"}</span>
        <label className="toggle-field">
          <input
            checked={wrapLongLines}
            type="checkbox"
            onChange={(event) => setWrapLongLines(event.currentTarget.checked)}
          />
          Wrap long lines
        </label>
        <Button onClick={download}>
          Download {version === undefined ? "current " : `v${version} `}raw content
        </Button>
      </div>
      {downloadState === "error" ? (
        <Notice variant="error">This browser could not create a text download.</Notice>
      ) : null}
      {inlineTextBody(file, wrapLongLines)}
    </>
  );
}

export function FileContent({
  file,
  stash,
  path,
  version,
  maxTextPreviewBytes,
  maxImagePreviewBytes,
}: FileContentProps) {
  const access = fileContentAccess(file);
  const representation = fileRepresentation(file);

  if (access === "deleted") {
    return <p className="file-body-empty">This version is a tombstone; it has no body.</p>;
  }
  if (access === "inline" && representation === "text") {
    return <InlineTextBody file={file} path={path} version={version} />;
  }
  return (
    <RawFileBody
      file={file}
      maxImagePreviewBytes={maxImagePreviewBytes}
      maxTextPreviewBytes={maxTextPreviewBytes}
      path={path}
      stash={stash}
      version={version}
    />
  );
}
