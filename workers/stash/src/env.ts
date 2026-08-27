export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  RL_READ: RateLimiter;
  RL_WRITE: RateLimiter;
  RL_DIFF: RateLimiter;
  STASH_ADMIN_TOKEN: string;
  ALLOWED_ORIGINS: string;
  STASH_DELETE_GRACE_DAYS: string;
  GC_ORPHAN_MIN_AGE_MS: string;
  GC_LEASE_TTL_MS: string;
}
