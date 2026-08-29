import { IDEMPOTENCY_KEY_MAX_CHARS, sha256Hex } from "@takazudo/zudo-history-stash-core";
import type {
  AbortUploadResult,
  CapabilitiesResponse,
  CompleteUploadResult,
  CreateUploadSessionInput,
  GetUploadSessionResult,
  Representation,
  RouteId,
  UploadMode,
  UploadPartRecord,
  UploadSessionRecord,
  PutResult,
} from "@takazudo/zudo-history-stash-core";
import { parseClientResponse, StashHttpError } from "./parse.js";
import type { ClientResult, NotModifiedResult } from "./client.js";
import type { Send } from "./transport.js";

export type ByteSource = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>;
export type UploadSource = string | ByteSource;
export type UploadTransferMode = "auto" | "json" | UploadMode;

export interface UploadProgress {
  /** Bytes read from the caller-owned source, not bytes acknowledged by the network. */
  observedBytes: number;
  totalBytes: number;
  partNumber?: number;
  durableParts?: number;
  phase: "source" | "part" | "complete";
}

export interface UploadOptions {
  expectedVersion: number | null;
  representation: Representation;
  contentType: string;
  /** Required for a one-shot ReadableStream. */
  size?: number;
  sha256?: string;
  mode?: UploadTransferMode;
  resumable?: boolean;
  skipIfUnchanged?: boolean;
  idempotencyKey?: string;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export interface RawDownloadOptions {
  version?: number;
  range?: string;
  ifRange?: string;
  ifNoneMatch?: string;
  signal?: AbortSignal;
}

export interface RawDownload {
  response: Response;
  body: ReadableStream<Uint8Array> | null;
  version: number;
  etag: string;
  contentType: string;
  size: number;
  contentRange: string | null;
  bytes(maxBytes: number): Promise<Uint8Array>;
  text(maxBytes: number, encoding?: string): Promise<string>;
}

export type RawDownloadResult = ClientResult<RawDownload> | NotModifiedResult;

export interface UploadSessionCreateOptions extends CreateUploadSessionInput {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface UploadChunkOptions {
  generation: number;
  size: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadSingleOptions extends UploadChunkOptions {
  idempotencyKey?: string;
}

export type UploadPartOptions = UploadChunkOptions;

export interface StashUploadSessionsClient {
  create(
    path: string,
    input: UploadSessionCreateOptions,
  ): Promise<ClientResult<UploadSessionRecord>>;
  status(sessionId: string, signal?: AbortSignal): Promise<ClientResult<GetUploadSessionResult>>;
  uploadSingle(
    sessionId: string,
    source: ByteSource,
    options: UploadSingleOptions,
  ): Promise<ClientResult<UploadSessionRecord>>;
  uploadPart(
    sessionId: string,
    partNumber: number,
    source: ByteSource,
    options: UploadPartOptions,
  ): Promise<ClientResult<GetUploadSessionResult>>;
  complete(
    sessionId: string,
    generation: number,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<ClientResult<CompleteUploadResult>>;
  resume(
    sessionId: string,
    generation: number,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<ClientResult<UploadSessionRecord>>;
  abort(
    sessionId: string,
    generation: number,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<ClientResult<AbortUploadResult>>;
}

export interface BinaryClientContext {
  send: Send;
  authorizationToken?: string;
  clientId?: string;
  mintKey(supplied?: string): Promise<string>;
}

interface NormalizedSource {
  size: number;
  replayable: boolean;
  text?: string;
  stream(start?: number, end?: number): ReadableStream<Uint8Array>;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function blobStream(blob: Blob): ReadableStream<Uint8Array> {
  if (typeof blob.stream === "function") return blob.stream();
  // Blob.stream() is available in supported browsers, but a few fetch/DOM
  // implementations (including older test environments) only expose
  // arrayBuffer(). Keep the source replayable without changing upload mode
  // selection; this fallback is used per slice, not for the whole file.
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function normalizeSource(source: UploadSource, declaredSize?: number): NormalizedSource {
  if (typeof source === "string") {
    const bytes = new TextEncoder().encode(source);
    return {
      size: bytes.byteLength,
      replayable: true,
      text: source,
      stream: (start = 0, end = bytes.byteLength) => byteStream(bytes.slice(start, end)),
    };
  }
  if (source instanceof Blob) {
    return {
      size: source.size,
      replayable: true,
      stream: (start = 0, end = source.size) => blobStream(source.slice(start, end)),
    };
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const bytes =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return {
      size: bytes.byteLength,
      replayable: true,
      stream: (start = 0, end = bytes.byteLength) => byteStream(bytes.slice(start, end)),
    };
  }
  if (source instanceof ReadableStream) {
    if (!Number.isSafeInteger(declaredSize) || (declaredSize ?? -1) < 0) {
      throw new TypeError("A one-shot ReadableStream upload requires an exact non-negative size");
    }
    let claimed = false;
    return {
      size: declaredSize!,
      replayable: false,
      stream() {
        if (claimed) throw new TypeError("The one-shot upload stream has already been consumed");
        claimed = true;
        return source;
      },
    };
  }
  throw new TypeError("Unsupported upload source");
}

export function selectUploadMode(
  source: { size: number; replayable: boolean; text: boolean },
  capabilities: CapabilitiesResponse,
  options: Pick<UploadOptions, "representation" | "mode" | "resumable">,
): Exclude<UploadTransferMode, "auto"> {
  const requested = options.mode ?? "auto";
  const eligibleJson =
    options.representation === "text" &&
    source.replayable &&
    source.text &&
    source.size <= capabilities.limits.jsonInlineMaxBytes;
  const automatic = eligibleJson
    ? "json"
    : !options.resumable && source.size <= capabilities.limits.singleUploadMaxBytes
      ? "single"
      : "multipart";
  const selected = requested === "auto" ? automatic : requested;
  if (!capabilities.transferModes.includes(selected)) {
    throw new TypeError(`Upload mode ${selected} is not supported by the server`);
  }
  if (selected === "json" && !eligibleJson) {
    throw new TypeError("JSON upload requires replayable UTF-8 text within jsonInlineMaxBytes");
  }
  if (options.resumable && selected !== "multipart") {
    throw new TypeError("A resumable upload must use multipart mode");
  }
  if (selected === "single" && source.size > capabilities.limits.singleUploadMaxBytes) {
    throw new TypeError("The source exceeds the server single-upload limit");
  }
  if (source.size > capabilities.limits.maxFileBytes) {
    throw new TypeError("The source exceeds the server maximum file size");
  }
  return selected;
}

function headers(context: BinaryClientContext, extra: HeadersInit = {}): Record<string, string> {
  const value: Record<string, string> = {};
  new Headers(extra).forEach((headerValue, name) => {
    value[name] = headerValue;
  });
  if (context.authorizationToken !== undefined)
    value.authorization = `Bearer ${context.authorizationToken}`;
  if (context.clientId !== undefined) value["x-stash-client-id"] = context.clientId;
  return value;
}

async function jsonResult<T>(response: Response, routeId: RouteId): Promise<ClientResult<T>> {
  return (await parseClientResponse<T>(response, routeId)) as ClientResult<T>;
}

async function sendJson<T>(
  context: BinaryClientContext,
  routeId: RouteId,
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  options: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<ClientResult<T>> {
  const key = await context.mintKey(options.idempotencyKey);
  try {
    return await jsonResult<T>(
      await context.send(
        method,
        path,
        undefined,
        headers(context, { "Content-Type": "application/json", "Idempotency-Key": key }),
        JSON.stringify(body),
        options.signal,
      ),
      routeId,
    );
  } catch (error) {
    if (error instanceof StashHttpError) throw error;
    throw new StashHttpError(0, undefined, undefined, error);
  }
}

function subkey(root: string, label: string): string {
  const suffix = `:${label}`;
  return `${root.slice(0, IDEMPOTENCY_KEY_MAX_CHARS - suffix.length)}${suffix}`;
}

function sessionPath(stash: string, sessionId?: string): string {
  return `/v1/stashes/${stash}/uploads${sessionId === undefined ? "" : `/${sessionId}`}`;
}

function observedStream(
  stream: ReadableStream<Uint8Array>,
  total: number,
  callback: UploadOptions["onProgress"],
  partNumber?: number,
): ReadableStream<Uint8Array> {
  if (callback === undefined) return stream;
  let observed = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed += chunk.byteLength;
        callback({ observedBytes: observed, totalBytes: total, partNumber, phase: "source" });
        controller.enqueue(chunk);
      },
    }),
  );
}

async function materialize(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new TypeError("maxBytes must be non-negative");
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        // Do not await cancellation of a cloned Response body. Some
        // ReadableStream tee implementations leave that promise pending even
        // after the limit has been observed; the caller needs the bounded
        // RangeError immediately and the rejection is still handled here.
        void reader.cancel("materialization limit exceeded").catch(() => undefined);
        throw new RangeError(`Download exceeds the ${maxBytes} byte materialization limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function downloadValue(response: Response): RawDownload {
  const version = Number(response.headers.get("X-Stash-Version"));
  const size = Number(response.headers.get("Content-Length"));
  const etag = response.headers.get("ETag") ?? "";
  const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
  const cloneFor = () => response.clone();
  return {
    response,
    body: response.body,
    version,
    etag,
    contentType,
    size,
    contentRange: response.headers.get("Content-Range"),
    bytes: (maxBytes) => materialize(cloneFor(), maxBytes),
    async text(maxBytes, encoding = "utf-8") {
      return new TextDecoder(encoding, { fatal: true }).decode(
        await materialize(cloneFor(), maxBytes),
      );
    },
  };
}

export async function getRaw(
  context: BinaryClientContext,
  stash: string,
  path: string,
  options: RawDownloadOptions = {},
  head = false,
): Promise<RawDownloadResult> {
  const historical = options.version !== undefined;
  const requestPath = historical
    ? `/v1/stashes/${stash}/versions/${options.version}/raw/${path}`
    : `/v1/stashes/${stash}/raw/${path}`;
  const routeId: RouteId = historical
    ? head
      ? "headRawVersion"
      : "getRawVersion"
    : head
      ? "headRawFile"
      : "getRawFile";
  let response: Response;
  try {
    response = await context.send(
      head ? "HEAD" : "GET",
      requestPath,
      undefined,
      headers(context, {
        ...(options.range === undefined ? {} : { Range: options.range }),
        ...(options.ifRange === undefined ? {} : { "If-Range": options.ifRange }),
        ...(options.ifNoneMatch === undefined ? {} : { "If-None-Match": options.ifNoneMatch }),
      }),
      undefined,
      options.signal,
    );
  } catch (error) {
    throw new StashHttpError(0, undefined, undefined, error);
  }
  if (response.status === 304) return { ok: true, notModified: true };
  if (!response.ok) return await jsonResult(response, routeId);
  return { ok: true, value: downloadValue(response) };
}

export function createUploadSessionsClient(
  context: BinaryClientContext,
  stash: string,
): StashUploadSessionsClient {
  const uploadBytes = async <T>(
    routeId: RouteId,
    path: string,
    source: ByteSource,
    options: UploadChunkOptions & { idempotencyKey?: string },
    query?: Record<string, string>,
    idempotent = false,
  ): Promise<ClientResult<T>> => {
    const normalized = normalizeSource(source, options.size);
    if (normalized.size !== options.size)
      throw new TypeError("Upload part size does not match its declaration");
    const key = idempotent ? await context.mintKey(options.idempotencyKey) : undefined;
    try {
      const response = await context.send(
        "PUT",
        path,
        query,
        headers(context, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(options.size),
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        }),
        observedStream(normalized.stream(), options.size, options.onProgress),
        options.signal,
      );
      return await jsonResult<T>(response, routeId);
    } catch (error) {
      if (error instanceof StashHttpError) throw error;
      throw new StashHttpError(0, undefined, undefined, error);
    }
  };

  return {
    create(path, input) {
      const { idempotencyKey, signal, ...body } = input;
      return sendJson(
        context,
        "createUploadSession",
        "POST",
        `${sessionPath(stash)}/${path}`,
        body,
        {
          idempotencyKey,
          signal,
        },
      );
    },
    async status(sessionId, signal) {
      const response = await context.send(
        "GET",
        sessionPath(stash, sessionId),
        undefined,
        headers(context),
        undefined,
        signal,
      );
      return await jsonResult<GetUploadSessionResult>(response, "getUploadSession");
    },
    uploadSingle(sessionId, source, options) {
      return uploadBytes(
        "uploadSingleContent",
        `${sessionPath(stash, sessionId)}/content`,
        source,
        options,
        undefined,
        true,
      );
    },
    uploadPart(sessionId, partNumber, source, options) {
      return uploadBytes(
        "uploadPart",
        `${sessionPath(stash, sessionId)}/parts/${partNumber}`,
        source,
        options,
        { generation: String(options.generation) },
      );
    },
    complete(sessionId, generation, options) {
      return sendJson(
        context,
        "completeUploadSession",
        "POST",
        `${sessionPath(stash, sessionId)}/complete`,
        { generation },
        options,
      );
    },
    resume(sessionId, generation, options) {
      return sendJson(
        context,
        "resumeUploadSession",
        "POST",
        `${sessionPath(stash, sessionId)}/resume`,
        { generation },
        options,
      );
    },
    abort(sessionId, generation, options) {
      return sendJson(
        context,
        "abortUploadSession",
        "DELETE",
        sessionPath(stash, sessionId),
        { generation },
        options,
      );
    },
  };
}

async function sourceText(source: NormalizedSource, limit: number): Promise<string | undefined> {
  if (source.text !== undefined) return source.text;
  if (!source.replayable || source.size > limit) return undefined;
  const response = new Response(source.stream());
  const bytes = await materialize(response, limit);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function attempt<T>(run: () => Promise<T>, retries: number): Promise<T> {
  let remaining = retries;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (remaining-- <= 0) throw error;
    }
  }
}

async function* splitOneShot(
  stream: ReadableStream<Uint8Array>,
  totalSize: number,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let part = new Uint8Array(Math.min(partSize, totalSize));
  let partOffset = 0;
  let observed = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      let chunkOffset = 0;
      observed += next.value.byteLength;
      if (observed > totalSize) throw new TypeError("The upload stream exceeds its declared size");
      while (chunkOffset < next.value.byteLength) {
        const copied = Math.min(part.byteLength - partOffset, next.value.byteLength - chunkOffset);
        part.set(next.value.subarray(chunkOffset, chunkOffset + copied), partOffset);
        partOffset += copied;
        chunkOffset += copied;
        if (partOffset === part.byteLength) {
          yield part;
          const remaining = totalSize - (observed - (next.value.byteLength - chunkOffset));
          part = new Uint8Array(Math.min(partSize, Math.max(remaining, 0)));
          partOffset = 0;
        }
      }
    }
    if (observed !== totalSize || partOffset !== 0) {
      throw new TypeError("The upload stream ended before its declared size");
    }
  } finally {
    if (observed < totalSize)
      await reader.cancel("multipart upload stopped").catch(() => undefined);
    reader.releaseLock();
  }
}

export async function upload(
  context: BinaryClientContext,
  stash: string,
  path: string,
  sourceValue: UploadSource,
  options: UploadOptions,
  capabilities: CapabilitiesResponse,
  putJson: (body: string, idempotencyKey: string) => Promise<ClientResult<PutResult>>,
): Promise<ClientResult<CompleteUploadResult>> {
  const source = normalizeSource(sourceValue, options.size);
  const text =
    options.representation === "text"
      ? await sourceText(source, capabilities.limits.jsonInlineMaxBytes)
      : undefined;
  const mode = selectUploadMode(
    { size: source.size, replayable: source.replayable, text: text !== undefined },
    capabilities,
    options,
  );
  const retries = Math.max(0, options.retries ?? 0);
  const key = await context.mintKey(options.idempotencyKey);
  if (mode === "json") {
    const result = await putJson(text!, key);
    if (!result.ok) return result;
    const hash = await sha256Hex(text!);
    return {
      ...result,
      value:
        "unchanged" in result.value
          ? {
              ...result.value,
              hash,
              size: source.size,
              representation: "text",
              contentType: options.contentType,
            }
          : {
              ...result.value,
              representation: "text",
              contentType: options.contentType,
            },
    };
  }

  const sessions = createUploadSessionsClient(context, stash);
  const created = await attempt(async () => {
    const value = await sessions.create(path, {
      expectedVersion: options.expectedVersion,
      size: source.size,
      ...(options.sha256 === undefined ? {} : { hash: options.sha256 }),
      representation: options.representation,
      contentType: options.contentType,
      mode,
      resumable: options.resumable,
      skipIfUnchanged: options.skipIfUnchanged,
      idempotencyKey: subkey(key, "create"),
      signal: options.signal,
    });
    if (!value.ok && value.error.status >= 500)
      throw new StashHttpError(value.error.status, value.error.code, value);
    return value;
  }, retries);
  if (!created.ok) return created;
  const session = created.value;
  const generation = session.attemptGeneration;
  if (mode === "single") {
    const result = await attempt(
      async () => {
        const value = await sessions.uploadSingle(session.id, source.stream(), {
          generation,
          size: source.size,
          idempotencyKey: subkey(key, "content"),
          signal: options.signal,
          onProgress: options.onProgress,
        });
        if (!value.ok && value.error.status >= 500)
          throw new StashHttpError(value.error.status, value.error.code, value);
        return value;
      },
      source.replayable ? retries : 0,
    );
    if (!result.ok) return result;
  } else {
    const partSize = session.partSize;
    if (partSize === null) throw new TypeError("The server did not return a multipart part size");
    const totalParts = Math.ceil(source.size / partSize);
    const oneShotParts = source.replayable
      ? undefined
      : splitOneShot(source.stream(), source.size, partSize);
    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, source.size);
        const oneShotPart =
          oneShotParts === undefined ? undefined : (await oneShotParts.next()).value;
        if (!source.replayable && oneShotPart === undefined) {
          throw new TypeError("The upload stream ended before its declared size");
        }
        const part = await attempt(
          async () => {
            const partSource = source.replayable ? source.stream(start, end) : oneShotPart!;
            const value = await sessions.uploadPart(session.id, partNumber, partSource, {
              generation,
              size: end - start,
              signal: options.signal,
              onProgress:
                options.onProgress === undefined
                  ? undefined
                  : (progress) =>
                      options.onProgress?.({
                        ...progress,
                        observedBytes: start + progress.observedBytes,
                        totalBytes: source.size,
                        partNumber,
                      }),
            });
            if (!value.ok && value.error.status >= 500)
              throw new StashHttpError(value.error.status, value.error.code, value);
            return value;
          },
          source.replayable ? retries : 0,
        );
        if (!part.ok) return part;
        options.onProgress?.({
          observedBytes: end,
          totalBytes: source.size,
          partNumber,
          durableParts: part.value.parts.filter(
            (entry: UploadPartRecord) => entry.generation === generation,
          ).length,
          phase: "part",
        });
      }
    } finally {
      await oneShotParts?.return(undefined);
    }
  }
  const completed = await attempt(async () => {
    const value = await sessions.complete(session.id, generation, {
      idempotencyKey: subkey(key, "complete"),
      signal: options.signal,
    });
    if (!value.ok && value.error.status >= 500)
      throw new StashHttpError(value.error.status, value.error.code, value);
    return value;
  }, retries);
  if (completed.ok) {
    options.onProgress?.({
      observedBytes: source.size,
      totalBytes: source.size,
      phase: "complete",
    });
  }
  return completed;
}
