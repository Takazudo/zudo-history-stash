export const MAX_BODY_BYTES = 5_000_000;
/** Maximum exact UTF-8 content bytes accepted/embedded by the compatibility JSON API. */
export const JSON_INLINE_MAX_BYTES = MAX_BODY_BYTES;
/** Storage-only D1 byte threshold. This is intentionally independent of JSON embedding. */
export const D1_INLINE_MAX_BYTES = 524_288;
export const D1_INLINE_MAX_BYTES_CEILING = 1_500_000;
/** Operator-declared request ceiling; the Worker plan limit is not runtime-discoverable. */
export const HTTP_REQUEST_MAX_BYTES = 100_000_000;
export const SINGLE_UPLOAD_MAX_BYTES = 32 * 1_024 * 1_024;
export const MAX_FILE_BYTES = 100_000_000;
export const MAX_FILE_BYTES_CEILING = 1_024 * 1_024 * 1_024;
export const MAX_PATH_BYTES = 512;
export const MAX_META_BYTES = 4_096;
export const MAX_AUTHOR_BYTES = 200;
export const MAX_MESSAGE_BYTES = 2_000;
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const DIFF_MAX_BYTES = 524_288;
export const R2_SPILL_BYTES = DIFF_MAX_BYTES;
export const DIFF_TIMEOUT_MS = 2_000;
export const DIFF_MAX_EDIT_LENGTH = 50_000;
export const DIFF_MAX_INTRALINE_LENGTH = 800;
export const DIFF_MAX_INTRALINE_CHARS = 200_000;
export const IDEMPOTENCY_KEY_MAX_CHARS = 200;
export const IDEMPOTENCY_TTL_DAYS = 7;
export const BODY_LIMIT_BYTES = 32 * 1_024 * 1_024;
export const MULTIPART_PART_BYTES = 8 * 1_024 * 1_024;
export const MULTIPART_PRODUCTION_MIN_PART_BYTES = 5 * 1_024 * 1_024;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_OPEN_UPLOAD_SESSIONS = 8;
export const MAX_RESERVED_UPLOAD_BYTES = 500_000_000;
export const UPLOAD_SESSION_TTL_SECONDS = 86_400;
export const MAX_IMPORT_VERSIONS = 20;
