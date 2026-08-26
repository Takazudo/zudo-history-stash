import { formatEtag } from "@takazudo/zudo-history-stash-core";
import type {
  ApiError,
  Current,
  ErrorCode,
  FileRecord,
  RouteId,
} from "@takazudo/zudo-history-stash-core";
import type {
  ClientResult,
  ClientSuccess,
  FileRecordWithEtag,
  NotModifiedResult,
} from "./client.js";

type ErrorBody = {
  error?: { code?: unknown; message?: unknown };
  current?: unknown;
};

/** A request or transport failure that is not a business outcome. */
export class StashHttpError extends Error {
  override readonly name = "StashHttpError";
  readonly status: number;
  readonly code?: ErrorCode;
  readonly body?: unknown;

  constructor(status: number, code?: ErrorCode, body?: unknown, cause?: unknown) {
    super(`History Stash request failed${status ? ` (${status})` : ""}`, { cause });
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) return undefined;
  if (typeof response.text !== "function") {
    if (typeof response.json === "function") return response.json();
    return undefined;
  }
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getErrorBody(body: unknown): ErrorBody {
  return isRecord(body) ? (body as ErrorBody) : {};
}

function getErrorCode(body: unknown, fallback: string): string {
  const error = getErrorBody(body).error;
  return error && typeof error.code === "string" ? error.code : fallback;
}

function getErrorMessage(body: unknown, fallback: string): string {
  const error = getErrorBody(body).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

function getCurrent(body: unknown): Current | undefined {
  const current = getErrorBody(body).current;
  return current === undefined ? undefined : (current as Current);
}

function withReplay<T>(value: T, replayed: boolean): ClientSuccess<T> {
  return replayed ? { ok: true, value, replayed: true } : { ok: true, value };
}

function mapFailure<T>(status: number, body: unknown): ClientResult<T> {
  const fallback = status >= 400 && status < 500 ? "validation" : "internal";
  const current = getCurrent(body);
  return {
    ok: false,
    error: {
      code: getErrorCode(body, fallback) as ApiError["code"],
      message: getErrorMessage(body, `History Stash request failed (${status})`),
      status,
    },
    ...(current === undefined ? {} : { current }),
  };
}

/** Parses a route response into the same business-result union used by every client transport. */
export async function parseClientResponse<T>(
  response: Response,
  routeId: RouteId,
): Promise<ClientResult<T> | NotModifiedResult> {
  let body: unknown;
  try {
    body = await parseBody(response);
  } catch (error) {
    throw new StashHttpError(0, undefined, undefined, error);
  }

  if (response.status >= 500) {
    throw new StashHttpError(response.status, getErrorCode(body, "internal") as ErrorCode, body);
  }
  if (response.status === 304) return { ok: true, notModified: true };
  if (response.status < 200 || response.status >= 300) {
    return mapFailure<T>(response.status, body);
  }

  const replayed =
    (response.status === 200 || response.status === 201) &&
    response.headers.get("Idempotent-Replayed")?.toLowerCase() === "true";
  if (routeId !== "getFile") return withReplay(body as T, replayed);

  const record = body as FileRecord;
  const value: FileRecordWithEtag = {
    ...record,
    etag:
      response.headers.get("ETag") ??
      (record.deleted
        ? formatEtag({ version: record.version, hash: null, deleted: true })
        : formatEtag({
            version: record.version,
            hash: record.hash ?? "",
            deleted: false,
          })),
  };
  return withReplay(value as T, replayed);
}
