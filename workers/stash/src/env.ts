export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  RL_READ: RateLimiter;
  RL_WRITE: RateLimiter;
  RL_DIFF: RateLimiter;
  STASH_ADMIN_TOKEN: string;
  ALLOWED_ORIGINS: string;
}
