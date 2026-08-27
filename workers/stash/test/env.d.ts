import type { D1Migration } from "cloudflare:test";
import type { RpcRequest } from "@takazudo/zudo-history-stash-core";
import type { RateLimiter } from "../src/env.js";

interface TestStashRpcBinding {
  request(init: RpcRequest): Promise<Response>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      UPGRADE_DB: D1Database;
      BLOBS: R2Bucket;
      RL_READ: RateLimiter;
      RL_WRITE: RateLimiter;
      RL_DIFF: RateLimiter;
      STASH_ADMIN_TOKEN: string;
      ALLOWED_ORIGINS: string;
      STASH_DELETE_GRACE_DAYS: string;
      GC_ORPHAN_MIN_AGE_MS: string;
      GC_LEASE_TTL_MS: string;
      TEST_MIGRATIONS: D1Migration[];
      STASH_RPC: TestStashRpcBinding;
    }
  }
}

export {};
