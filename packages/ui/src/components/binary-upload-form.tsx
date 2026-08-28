import type {
  CapabilitiesResponse,
  CompleteUploadResult,
  StashUploadSessionsClient,
  UploadProgress,
  UploadSessionRecord,
  UploadTransferMode,
} from "@takazudo/zudo-history-stash";
import { selectUploadMode, validatePath } from "@takazudo/zudo-history-stash";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { useCanWrite, useStashClient, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Select } from "../primitives/select.js";
import { ErrorBanner } from "./error-banner.js";

const TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/xml",
  "application/x-sh",
  "application/yaml",
  "application/x-yaml",
  "image/svg+xml",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/x-component",
  "text/x-shellscript",
  "text/yaml",
]);

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".gql",
  ".graphql",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".markdown",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".svg",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".tsv",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

type ChosenMode = Exclude<UploadTransferMode, "auto">;

export interface BinaryUploadCreated {
  path: string;
  version: number;
  result: CompleteUploadResult;
}

export interface BinaryUploadFormProps {
  stash: string;
  /** Initial path shown before a file is selected. */
  initialPath?: string;
  /** `null` means create a new path; a number fences an existing head. */
  initialExpectedVersion?: number | null;
  onUploaded: (created: BinaryUploadCreated) => void;
}

interface UploadSessionState {
  key: string;
  record: UploadSessionRecord;
  idempotencyKey: string;
}

type OperationState =
  | { state: "idle" }
  | { state: "uploading"; progress: UploadProgress | null; mode: ChosenMode }
  | { state: "paused"; progress: UploadProgress | null; mode: "multipart" }
  | { state: "success"; result: CompleteUploadResult }
  | { state: "error"; error: unknown; retryable: boolean; progress: UploadProgress | null };

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

/** Conservative defaults only; selecting text is always an explicit user-visible choice. */
export function defaultUploadRepresentation(file: Pick<File, "name" | "type">): "text" | "binary" {
  const mime = file.type.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(extension(file.name))) return "text";
  return "binary";
}

function contentTypeFor(file: File): string {
  const supplied = file.type.trim();
  if (supplied !== "") return supplied;
  const byExtension: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".yaml": "application/yaml; charset=utf-8",
    ".yml": "application/yaml; charset=utf-8",
  };
  return byExtension[extension(file.name)] ?? "application/octet-stream";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatConfiguredBytes(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return "unknown";
  return `${value.toLocaleString("en-US")} B`;
}

function uploadError(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const detail = (error as { error?: unknown }).error;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  if (error instanceof Error) return error.message;
  return "The upload could not be completed.";
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted")))
  );
}

function sessionKey(
  file: File,
  path: string,
  expectedVersion: number | null,
  representation: "text" | "binary",
  contentType: string,
): string {
  return [
    path,
    file.name,
    file.size,
    file.lastModified,
    expectedVersion ?? "new",
    representation,
    contentType,
  ].join("\u0000");
}

function progressLabel(
  progress: UploadProgress | null,
  mode: ChosenMode | null,
  partSize: number | null,
): string {
  if (progress === null)
    return mode === "multipart" ? "Preparing durable parts…" : "Preparing upload…";
  const source = `${formatBytes(progress.observedBytes)} / ${formatBytes(progress.totalBytes)}`;
  if (progress.phase === "complete") return "Upload finalized and verified.";
  if (mode === "multipart" && progress.phase === "part") {
    const durable = progress.durableParts ?? 0;
    const totalParts = Math.ceil(progress.totalBytes / (partSize || progress.totalBytes || 1));
    return `Server recorded ${durable} of ${totalParts} durable parts (${source}).`;
  }
  if (mode === "multipart") {
    const durable = progress.durableParts ?? 0;
    return `Reading part ${progress.partNumber ?? "next"} (${source}); ${durable} durable parts are recorded on the server.`;
  }
  if (mode === "single") return `Read ${source}; this does not acknowledge network receipt.`;
  return `Read ${source}.`;
}

function resultVersion(result: CompleteUploadResult): number {
  return result.version;
}

function resultSize(result: CompleteUploadResult): number {
  return result.size;
}

export function BinaryUploadForm({
  stash,
  initialPath = "",
  initialExpectedVersion = null,
  onUploaded,
}: BinaryUploadFormProps) {
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const capability = useCanWrite(stash);
  const titleId = useId();
  const fileId = useId();
  const pathId = useId();
  const typeId = useId();
  const representationId = useId();
  const modeId = useId();
  const expectedId = useId();
  const operationControllerRef = useRef<AbortController | null>(null);
  const headControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<UploadSessionState | null>(null);
  const idempotencyRef = useRef<{ key: string; value: string } | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState<unknown | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState(initialPath);
  const [contentType, setContentType] = useState("application/octet-stream");
  const [representation, setRepresentation] = useState<"text" | "binary">("binary");
  const [mode, setMode] = useState<UploadTransferMode>("auto");
  const [expectedVersion, setExpectedVersion] = useState<number | null>(initialExpectedVersion);
  const [headState, setHeadState] = useState<"idle" | "loading" | "ready" | "missing" | "error">(
    "idle",
  );
  const [resumable, setResumable] = useState(false);
  const [operation, setOperation] = useState<OperationState>({ state: "idle" });

  useEffect(() => {
    if (!capability.ready || !capability.canWrite) return;
    const controller = new AbortController();
    void clientForSignal(controller.signal)
      .capabilities()
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.ok &&
          result.value !== null &&
          typeof result.value === "object" &&
          "limits" in result.value &&
          result.value.limits !== null &&
          typeof result.value.limits === "object"
        ) {
          setCapabilities(result.value);
          setCapabilityError(null);
        } else {
          setCapabilities(null);
          setCapabilityError(
            result.ok ? new Error("The server returned malformed upload capabilities.") : result,
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setCapabilityError(error);
      });
    return () => controller.abort();
  }, [capability.canWrite, capability.ready, clientForSignal]);

  useEffect(() => {
    return () => {
      operationControllerRef.current?.abort();
      headControllerRef.current?.abort();
    };
  }, []);

  const pathValidation = useMemo(() => {
    if (path === "") return { ok: false as const, message: "Choose a path for this upload." };
    return validatePath(path).ok
      ? { ok: true as const }
      : { ok: false as const, message: "Use a valid slash-separated file path." };
  }, [path]);

  const modePlan = useMemo<{ mode: ChosenMode | null; error: string | null }>(() => {
    if (!file || !capabilities || !pathValidation.ok) return { mode: null, error: null };
    if (contentType.trim() === "") {
      return { mode: null, error: "Enter a content type before uploading." };
    }
    if (
      expectedVersion !== null &&
      (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    ) {
      return { mode: null, error: "Expected current version must be a positive integer or blank." };
    }
    try {
      const requestedMode = mode === "auto" && resumable ? "multipart" : mode;
      const selected = selectUploadMode(
        { size: file.size, replayable: true, text: representation === "text" },
        capabilities,
        {
          representation,
          mode: requestedMode,
          resumable: requestedMode === "multipart" ? false : resumable,
        },
      );
      return { mode: selected, error: null };
    } catch (error: unknown) {
      return { mode: null, error: uploadError(error) };
    }
  }, [
    capabilities,
    contentType,
    expectedVersion,
    file,
    mode,
    pathValidation.ok,
    representation,
    resumable,
  ]);

  const plannedMode = modePlan.mode;

  function chooseFile(next: File | null): void {
    if (!next) return;
    operationControllerRef.current?.abort();
    sessionRef.current = null;
    idempotencyRef.current = null;
    setFile(next);
    setPath((current) => current || next.name);
    setContentType(contentTypeFor(next));
    setRepresentation(defaultUploadRepresentation(next));
    setOperation({ state: "idle" });
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    chooseFile(event.currentTarget.files?.[0] ?? null);
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    if (operation.state === "uploading") return;
    chooseFile(event.dataTransfer.files[0] ?? null);
  }

  async function readCurrentHead(): Promise<void> {
    if (!pathValidation.ok) return;
    headControllerRef.current?.abort();
    const controller = new AbortController();
    headControllerRef.current = controller;
    setHeadState("loading");
    try {
      const result = await clientForSignal(controller.signal).files(stash).get(path);
      if (controller.signal.aborted || headControllerRef.current !== controller) return;
      if (result.ok && !("notModified" in result)) {
        setExpectedVersion(result.value.version);
        setHeadState("ready");
      } else if (!result.ok && result.error.code === "not-found") {
        setExpectedVersion(null);
        setHeadState("missing");
      } else if (!result.ok && result.error.code === "file-deleted" && result.current) {
        setExpectedVersion(result.current.version);
        setHeadState("ready");
      } else {
        setHeadState("error");
      }
    } catch {
      if (!controller.signal.aborted && headControllerRef.current === controller) {
        setHeadState("error");
      }
    } finally {
      if (headControllerRef.current === controller) headControllerRef.current = null;
    }
  }

  function progressFor(progress: UploadProgress): void {
    setOperation((current) =>
      current.state === "uploading" || current.state === "paused"
        ? { ...current, progress }
        : current,
    );
  }

  function keyForCurrentFile(): string | null {
    if (!file) return null;
    return sessionKey(file, path, expectedVersion, representation, contentType);
  }

  function idempotencyKeyFor(key: string): string {
    const current = idempotencyRef.current;
    if (current?.key === key) return current.value;
    const value = globalThis.crypto.randomUUID();
    idempotencyRef.current = { key, value };
    return value;
  }

  function operationKey(root: string, suffix: string): string {
    return `${root}:${suffix}`;
  }

  async function uploadMultipart(
    uploads: StashUploadSessionsClient,
    signal: AbortSignal,
  ): Promise<CompleteUploadResult> {
    if (!file) throw new Error("Choose a file before uploading.");
    if (file.size === 0) throw new Error("Empty files must use single upload mode.");
    const key = keyForCurrentFile();
    if (key === null) throw new Error("Choose a file before uploading.");
    const idempotencyKey = idempotencyKeyFor(key);
    let sessionState = sessionRef.current?.key === key ? sessionRef.current : null;
    let session = sessionState?.record ?? null;
    if (session === null) {
      const created = await uploads.create(path, {
        expectedVersion,
        size: file.size,
        representation,
        contentType,
        mode: "multipart",
        resumable: true,
        idempotencyKey,
        signal,
      });
      if (!created.ok) throw created;
      session = created.value;
      sessionState = { key, record: session, idempotencyKey };
      sessionRef.current = sessionState;
    }

    const current = await uploads.status(session.id, signal);
    if (!current.ok) throw current;
    let record: UploadSessionRecord = current.value;
    let parts = current.value.parts;
    if (record.state === "committed" && record.result !== null) return record.result;
    if (record.state !== "open") {
      const resumed = await uploads.resume(record.id, record.attemptGeneration, {
        idempotencyKey: operationKey(idempotencyKey, `complete-${record.attemptGeneration}`),
        signal,
      });
      if (!resumed.ok) throw resumed;
      record = resumed.value;
      // A resumed attempt has a new generation; ask the next upload call to establish
      // durable-part state for that generation instead of reusing stale records.
      parts = [];
      if (record.state === "committed" && record.result !== null) return record.result;
    }
    if (record.state !== "open" || record.partSize === null) {
      throw new Error(`This upload session is ${record.state} and cannot accept more parts.`);
    }
    sessionRef.current = { key, record, idempotencyKey };
    const sessionPartSize = record.partSize;
    const totalParts = Math.ceil(file.size / sessionPartSize);
    const durable = new Set(
      parts
        .filter((part) => part.generation === record.attemptGeneration)
        .map((part) => part.partNumber),
    );
    const durableBytes = parts
      .filter((part) => part.generation === record.attemptGeneration)
      .reduce((total, part) => total + part.size, 0);
    progressFor({
      observedBytes: durableBytes,
      totalBytes: file.size,
      durableParts: durable.size,
      phase: "part",
    });
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (durable.has(partNumber)) continue;
      const start = (partNumber - 1) * sessionPartSize;
      const end = Math.min(file.size, start + sessionPartSize);
      const uploaded = await uploads.uploadPart(record.id, partNumber, file.slice(start, end), {
        generation: record.attemptGeneration,
        size: end - start,
        idempotencyKey: operationKey(
          idempotencyKey,
          `part-${record.attemptGeneration}-${partNumber}`,
        ),
        signal,
        onProgress: (partProgress) =>
          progressFor({
            ...partProgress,
            observedBytes: start + partProgress.observedBytes,
            totalBytes: file.size,
            partNumber,
            durableParts: durable.size,
          }),
      });
      if (!uploaded.ok) throw uploaded;
      record = uploaded.value;
      parts = uploaded.value.parts;
      durable.add(partNumber);
      sessionRef.current = { key, record, idempotencyKey };
      const nextDurable = parts.filter(
        (part) => part.generation === record.attemptGeneration,
      ).length;
      progressFor({
        observedBytes: end,
        totalBytes: file.size,
        partNumber,
        durableParts: nextDurable,
        phase: "part",
      });
    }
    const completed = await uploads.complete(record.id, record.attemptGeneration, {
      idempotencyKey: operationKey(idempotencyKey, `complete-${record.attemptGeneration}`),
      signal,
    });
    if (!completed.ok) throw completed;
    return completed.value;
  }

  async function performUpload(): Promise<void> {
    if (!file || !capabilities || !pathValidation.ok || plannedMode === null) return;
    operationControllerRef.current?.abort();
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setOperation({ state: "uploading", progress: null, mode: plannedMode });
    try {
      const files = clientForSignal(controller.signal).files(stash);
      let result: CompleteUploadResult;
      if (plannedMode === "multipart") {
        result = await uploadMultipart(files.uploads, controller.signal);
      } else {
        const uploaded = await files.upload(path, file, {
          expectedVersion,
          representation,
          contentType,
          mode: mode === "auto" ? "auto" : plannedMode,
          resumable: false,
          signal: controller.signal,
          onProgress: progressFor,
        });
        if (!uploaded.ok) throw uploaded;
        result = uploaded.value;
      }
      if (controller.signal.aborted) {
        setOperation((current) =>
          current.state === "uploading" && plannedMode === "multipart"
            ? { state: "paused", mode: "multipart", progress: current.progress }
            : { state: "idle" },
        );
        return;
      }
      setOperation({ state: "success", result });
      sessionRef.current = null;
      idempotencyRef.current = null;
      onUploaded({ path, version: resultVersion(result), result });
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbort(error)) {
        setOperation((current) =>
          current.state === "uploading" && plannedMode === "multipart"
            ? { state: "paused", mode: "multipart", progress: current.progress }
            : { state: "idle" },
        );
      } else {
        setOperation((current) => ({
          state: "error",
          error,
          retryable: plannedMode === "multipart" || file !== null,
          progress: current.state === "uploading" ? current.progress : null,
        }));
      }
    } finally {
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
    }
  }

  function cancelUpload(): void {
    operationControllerRef.current?.abort();
  }

  async function discardSession(): Promise<void> {
    const session = sessionRef.current?.record;
    if (!session) {
      setOperation({ state: "idle" });
      return;
    }
    try {
      const result = await client.files(stash).uploads.abort(session.id, session.attemptGeneration);
      if (!result.ok) throw result;
      sessionRef.current = null;
      idempotencyRef.current = null;
      setOperation({ state: "idle" });
    } catch (error: unknown) {
      setOperation({ state: "error", error, retryable: true, progress: null });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (operation.state === "uploading") return;
    void performUpload();
  }

  if (!capability.ready) {
    return (
      <section className="zhs-binary-upload-not-available" role="status">
        <h2>Checking write access…</h2>
      </section>
    );
  }
  if (!capability.canWrite) {
    return (
      <section className="zhs-binary-upload-not-available" role="status">
        <h2>Raw upload is not available</h2>
        <p>A write-capable token for this stash is required to upload binary or large files.</p>
      </section>
    );
  }

  const maxFile = capabilities?.limits.maxFileBytes ?? null;
  const singleMax = capabilities?.limits.singleUploadMaxBytes ?? null;
  const partSize = capabilities?.limits.multipartPartBytes ?? null;
  const progress =
    operation.state === "uploading" || operation.state === "paused" ? operation.progress : null;
  const activeMode = operation.state === "uploading" ? operation.mode : plannedMode;
  const uploadInFlight = operation.state === "uploading";
  const uploadLocked = uploadInFlight || operation.state === "paused";
  const plannedCopy =
    modePlan.error !== null
      ? "Resolve the transfer-mode issue before uploading."
      : plannedMode === null
        ? "Select a file and a valid path to see the server-selected transfer mode."
        : plannedMode === "json"
          ? "The eligible small text source will use the legacy JSON request; the server still validates UTF-8."
          : plannedMode === "single"
            ? "This source fits one raw request. Progress reports bytes read from the source, not network acknowledgement."
            : "This source uses resumable multipart transfer. Each completed part is durable on the server.";

  return (
    <section className="zhs-binary-upload-form" aria-labelledby={titleId}>
      <header className="zhs-binary-upload-form__header">
        <div>
          <h2 id={titleId}>Upload raw file</h2>
          <p>Send text, images, archives, or other bytes without base64 encoding.</p>
        </div>
        {file ? (
          <span className="zhs-binary-upload-form__file-size">{formatBytes(file.size)}</span>
        ) : null}
      </header>
      <form aria-busy={operation.state === "uploading" ? "true" : undefined} onSubmit={submit}>
        <div className="zhs-binary-upload-form__body">
          <label
            className="zhs-binary-upload-form__drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <span className="zhs-binary-upload-form__drop-title">
              Choose a file or drop it here
            </span>
            <span className="zhs-binary-upload-form__drop-copy">
              The file name becomes the initial path. You can edit it before uploading.
            </span>
            <Input
              aria-describedby={`${fileId}-hint`}
              className="zhs-binary-upload-form__file-input"
              disabled={uploadLocked}
              id={fileId}
              type="file"
              onChange={handleFileChange}
            />
            <span className="zhs-binary-upload-form__file-name" aria-live="polite">
              {file ? `${file.name} selected` : "No file selected"}
            </span>
          </label>
          <p className="zhs-binary-upload-form__hint" id={`${fileId}-hint`}>
            Text is only the default for a conservative known-text MIME/extension list. The server
            remains authoritative.
          </p>

          <div className="zhs-binary-upload-form__grid">
            <label className="zhs-binary-upload-form__field">
              <span>Path</span>
              <Input
                aria-invalid={path !== "" && !pathValidation.ok ? true : undefined}
                autoComplete="off"
                disabled={uploadLocked}
                id={pathId}
                value={path}
                onChange={(event) => {
                  headControllerRef.current?.abort();
                  headControllerRef.current = null;
                  setPath(event.currentTarget.value);
                  sessionRef.current = null;
                  setOperation({ state: "idle" });
                }}
              />
              {!pathValidation.ok ? <small>{pathValidation.message}</small> : null}
            </label>
            <label className="zhs-binary-upload-form__field">
              <span>Content type</span>
              <Input
                disabled={uploadLocked}
                id={typeId}
                value={contentType}
                onChange={(event) => {
                  setContentType(event.currentTarget.value);
                  sessionRef.current = null;
                  setOperation({ state: "idle" });
                }}
              />
              <small>Used as metadata; it never enables active inline content.</small>
            </label>
            <fieldset className="zhs-binary-upload-form__field zhs-binary-upload-form__choice-group">
              <legend>Representation</legend>
              <label>
                <input
                  checked={representation === "text"}
                  disabled={uploadLocked}
                  name={representationId}
                  type="radio"
                  value="text"
                  onChange={() => {
                    setRepresentation("text");
                    sessionRef.current = null;
                    setOperation({ state: "idle" });
                  }}
                />{" "}
                Text (UTF-8)
              </label>
              <label>
                <input
                  checked={representation === "binary"}
                  disabled={uploadLocked}
                  name={representationId}
                  type="radio"
                  value="binary"
                  onChange={() => {
                    setRepresentation("binary");
                    sessionRef.current = null;
                    setOperation({ state: "idle" });
                  }}
                />{" "}
                Binary bytes
              </label>
              <small>
                Selected: <strong>{representation}</strong>. A text upload with invalid UTF-8 is
                rejected.
              </small>
            </fieldset>
            <label className="zhs-binary-upload-form__field">
              <span>Transfer mode</span>
              <Select
                disabled={uploadLocked}
                id={modeId}
                value={mode}
                onChange={(event) => {
                  setMode(event.currentTarget.value as UploadTransferMode);
                  sessionRef.current = null;
                  setOperation({ state: "idle" });
                }}
              >
                <option value="auto">Automatic (recommended)</option>
                {capabilities?.transferModes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
              <small>{plannedCopy}</small>
              {modePlan.error ? (
                <small className="zhs-binary-upload-form__field-error" role="alert">
                  {modePlan.error}
                </small>
              ) : null}
            </label>
            <label className="zhs-binary-upload-form__field">
              <span>Expected current version</span>
              <Input
                disabled={uploadLocked}
                id={expectedId}
                inputMode="numeric"
                min={1}
                placeholder="blank = create new path"
                type="number"
                value={expectedVersion ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setExpectedVersion(value === "" ? null : Number(value));
                  sessionRef.current = null;
                }}
              />
              <span className="zhs-binary-upload-form__inline-actions">
                <Button
                  disabled={uploadLocked}
                  size="sm"
                  type="button"
                  onClick={() => void readCurrentHead()}
                >
                  Read current head
                </Button>
                {headState === "loading" ? <small role="status">Reading…</small> : null}
                {headState === "ready" ? (
                  <small role="status">CAS set to v{expectedVersion}.</small>
                ) : null}
                {headState === "missing" ? (
                  <small role="status">No current file; create mode selected.</small>
                ) : null}
                {headState === "error" ? (
                  <small role="alert">Could not read the current head.</small>
                ) : null}
              </span>
            </label>
          </div>

          <label className="zhs-binary-upload-form__check">
            <input
              checked={resumable}
              disabled={uploadLocked}
              type="checkbox"
              onChange={(event) => {
                setResumable(event.currentTarget.checked);
                sessionRef.current = null;
                setOperation({ state: "idle" });
              }}
            />
            <span>Use resumable multipart when the selected mode needs it</span>
          </label>

          {capabilityError ? (
            <ErrorBanner error={capabilityError} title="Could not read upload capabilities" />
          ) : null}
          {capabilities ? (
            <Notice className="zhs-binary-upload-form__limits" variant="info">
              <strong>Server limits</strong>
              <span>Maximum file: {formatConfiguredBytes(maxFile)}.</span>
              <span>Single raw boundary: {formatConfiguredBytes(singleMax)}.</span>
              <span>
                Inline D1 threshold: {formatConfiguredBytes(capabilities.limits.d1InlineMaxBytes)};
                larger content is stored in the raw tier.
              </span>
              <span>
                Multipart parts: {formatConfiguredBytes(partSize)} each; progress is durable after
                each part.
              </span>
              <span>
                Multipart allows at most {capabilities.limits.maxMultipartParts.toLocaleString()}{" "}
                parts; finalization verifies every part before committing.
              </span>
              <span>
                Open upload sessions expire after{" "}
                {Math.round(capabilities.limits.uploadSessionTtlSeconds / 60)} minutes.
              </span>
              <span>
                Reservation quota:{" "}
                {formatConfiguredBytes(capabilities.limits.maxReservedUploadBytesPerStash)} per
                stash; open sessions: {capabilities.limits.maxOpenUploadSessionsPerStash}.
              </span>
            </Notice>
          ) : (
            <p className="zhs-binary-upload-form__hint" role="status">
              Reading server transfer capabilities…
            </p>
          )}

          {operation.state === "uploading" || operation.state === "paused" ? (
            <div className="zhs-binary-upload-form__progress" aria-live="polite">
              <div className="zhs-binary-upload-form__progress-heading">
                <strong>{operation.state === "paused" ? "Upload paused" : "Uploading"}</strong>
                <span>{progressLabel(progress, activeMode, partSize)}</span>
              </div>
              {file ? <progress max={file.size} value={progress?.observedBytes ?? 0} /> : null}
              {operation.state === "uploading" ? (
                <Button type="button" onClick={cancelUpload}>
                  {operation.mode === "multipart" ? "Cancel (keep durable parts)" : "Cancel upload"}
                </Button>
              ) : null}
              {operation.state === "paused" ? (
                <span className="zhs-binary-upload-form__inline-actions">
                  <Button type="button" variant="primary" onClick={() => void performUpload()}>
                    Resume upload
                  </Button>
                  <Button type="button" onClick={() => void discardSession()}>
                    Discard upload
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
          {operation.state === "success" ? (
            <Notice className="zhs-binary-upload-form__outcome" variant="success">
              <strong>Upload complete: v{resultVersion(operation.result)}</strong>
              <span>
                {formatBytes(resultSize(operation.result))} committed as {representation}.
              </span>
            </Notice>
          ) : null}
          {operation.state === "error" ? (
            <div className="zhs-binary-upload-form__outcome">
              <ErrorBanner error={operation.error} title="Upload failed" />
              {operation.retryable ? (
                <Button type="button" onClick={() => void performUpload()}>
                  Retry or resume
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <footer className="zhs-binary-upload-form__actions">
          <Button
            disabled={
              !file || !capabilities || !pathValidation.ok || plannedMode === null || uploadLocked
            }
            type="submit"
            variant="primary"
          >
            {operation.state === "uploading" ? "Uploading…" : "Upload file"}
          </Button>
        </footer>
      </form>
    </section>
  );
}
