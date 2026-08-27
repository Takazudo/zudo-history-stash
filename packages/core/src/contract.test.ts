import { describe, expect, it } from "vitest";
import { StashError, statusForCode } from "./errors.js";
import {
  BODY_LIMIT_BYTES,
  DIFF_MAX_BYTES,
  DIFF_MAX_EDIT_LENGTH,
  DIFF_TIMEOUT_MS,
  IDEMPOTENCY_KEY_MAX_CHARS,
  IDEMPOTENCY_TTL_DAYS,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_AUTHOR_BYTES,
  MAX_BODY_BYTES,
  MAX_IMPORT_VERSIONS,
  MAX_MESSAGE_BYTES,
  MAX_META_BYTES,
  MAX_PATH_BYTES,
} from "./limits.js";

it("pins every architecture limit", () => {
  expect({
    MAX_BODY_BYTES,
    MAX_PATH_BYTES,
    MAX_META_BYTES,
    MAX_AUTHOR_BYTES,
    MAX_MESSAGE_BYTES,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    DIFF_MAX_BYTES,
    DIFF_TIMEOUT_MS,
    DIFF_MAX_EDIT_LENGTH,
    IDEMPOTENCY_KEY_MAX_CHARS,
    IDEMPOTENCY_TTL_DAYS,
    BODY_LIMIT_BYTES,
    MAX_IMPORT_VERSIONS,
  }).toEqual({
    MAX_BODY_BYTES: 1_000_000,
    MAX_PATH_BYTES: 512,
    MAX_META_BYTES: 4_096,
    MAX_AUTHOR_BYTES: 200,
    MAX_MESSAGE_BYTES: 2_000,
    LIST_LIMIT_DEFAULT: 50,
    LIST_LIMIT_MAX: 200,
    DIFF_MAX_BYTES: 524_288,
    DIFF_TIMEOUT_MS: 2_000,
    DIFF_MAX_EDIT_LENGTH: 50_000,
    IDEMPOTENCY_KEY_MAX_CHARS: 200,
    IDEMPOTENCY_TTL_DAYS: 7,
    BODY_LIMIT_BYTES: 8_388_608,
    MAX_IMPORT_VERSIONS: 20,
  });
});

describe("typed errors", () => {
  it.each([
    ["validation", 400],
    ["unauthorized", 401],
    ["scope", 403],
    ["not-found", 404],
    ["stale", 409],
    ["already-rotated", 409],
    ["token-expired", 409],
    ["payload-too-large", 413],
    ["rate-limited", 429],
    ["idempotency-key-reused", 422],
    ["internal", 500],
  ] as const)("maps %s", (code, status) => expect(statusForCode(code)).toBe(status));

  it("constructs a StashError with its HTTP status", () => {
    const error = new StashError("file-deleted", "deleted");
    expect(error).toMatchObject({ name: "StashError", code: "file-deleted", status: 404 });
    expect(error.successorId).toBeUndefined();

    const rotated = new StashError(
      "already-rotated",
      "Token was already rotated.",
      undefined,
      "tok_successor",
    );
    expect(rotated).toMatchObject({ status: 409, successorId: "tok_successor" });
  });
});
