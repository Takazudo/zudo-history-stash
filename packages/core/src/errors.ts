import type { Current, ErrorCode } from "./types.js";

export const ERROR_CODES = [
  "validation",
  "invalid-path",
  "body-not-well-formed",
  "unauthorized",
  "scope",
  "not-found",
  "file-deleted",
  "version-not-found",
  "stale",
  "exists",
  "already-deleted",
  "gc-busy",
  "already-rotated",
  "token-expired",
  "proposal-expired",
  "proposal-closed",
  "rate-limited",
  "payload-too-large",
  "idempotency-key-reused",
  "rollback-target-tombstone",
  "unsupported-representation",
  "upload-session-not-open",
  "upload-session-expired",
  "upload-size-mismatch",
  "upload-hash-mismatch",
  "range-not-satisfiable",
  "internal",
] as const satisfies readonly ErrorCode[];

type _AssertNever<T extends never> = T;
type _NoMissingErrorCodes = _AssertNever<Exclude<ErrorCode, (typeof ERROR_CODES)[number]>>;
type _NoUnexpectedErrorCodes = _AssertNever<Exclude<(typeof ERROR_CODES)[number], ErrorCode>>;

const STATUSES: Record<(typeof ERROR_CODES)[number], number> = {
  validation: 400,
  "invalid-path": 400,
  "body-not-well-formed": 400,
  unauthorized: 401,
  scope: 403,
  "not-found": 404,
  "file-deleted": 404,
  "version-not-found": 404,
  stale: 409,
  exists: 409,
  "already-deleted": 409,
  "gc-busy": 409,
  "already-rotated": 409,
  "token-expired": 409,
  "proposal-expired": 409,
  "proposal-closed": 409,
  "rate-limited": 429,
  "payload-too-large": 413,
  "idempotency-key-reused": 422,
  "rollback-target-tombstone": 422,
  "unsupported-representation": 422,
  "upload-session-not-open": 409,
  "upload-session-expired": 410,
  "upload-size-mismatch": 422,
  "upload-hash-mismatch": 422,
  "range-not-satisfiable": 416,
  internal: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUSES[code];
}

export class StashError extends Error {
  override readonly name = "StashError";
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: Current;
  readonly successorId?: string;

  constructor(code: ErrorCode, message: string, current?: Current, successorId?: string) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
    this.current = current;
    this.successorId = successorId;
  }
}
