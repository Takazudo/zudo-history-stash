import type { StashEvents } from "./events/stash-events.js";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  STASH_EVENTS: DurableObjectNamespace<StashEvents>;
  RL_READ: RateLimiter;
  RL_WRITE: RateLimiter;
  RL_DIFF: RateLimiter;
  STASH_ADMIN_TOKEN: string;
  ALLOWED_ORIGINS: string;
  STASH_DELETE_GRACE_DAYS: string;
  GC_ORPHAN_MIN_AGE_MS: string;
  GC_CONTENT_MIN_AGE_MS: string;
  GC_LEASE_TTL_MS: string;
  CHANGE_SET_TTL_DAYS: string;
  STASH_EVENTS_MAX_STREAM_MS: string;
  JSON_INLINE_MAX_BYTES: string;
  D1_INLINE_MAX_BYTES: string;
  HTTP_REQUEST_MAX_BYTES: string;
  SINGLE_UPLOAD_MAX_BYTES: string;
  MAX_FILE_BYTES: string;
  DIFF_MAX_BYTES: string;
  MULTIPART_PART_BYTES: string;
  MAX_OPEN_UPLOAD_SESSIONS: string;
  MAX_RESERVED_UPLOAD_BYTES: string;
  UPLOAD_SESSION_TTL_SECONDS: string;
}
