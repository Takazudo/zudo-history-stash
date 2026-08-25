import type { Current, ErrorCode } from "./types.js";

const STATUSES: Record<ErrorCode, number> = {
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
  "payload-too-large": 413,
  "idempotency-key-reused": 422,
  "rollback-target-tombstone": 422,
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

  constructor(code: ErrorCode, message: string, current?: Current) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
    this.current = current;
  }
}
