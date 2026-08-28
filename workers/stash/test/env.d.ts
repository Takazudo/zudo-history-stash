import type { D1Migration } from "cloudflare:test";
import type { RpcRequest } from "@takazudo/zudo-history-stash-core";
import type { RateLimiter } from "../src/env.js";
import type { StashEvents } from "../src/events/stash-events.js";

interface TestStashRpcBinding {
  request(init: RpcRequest): Promise<Response>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      UPGRADE_DB: D1Database;
      BLOBS: R2Bucket;
      STASH_EVENTS: DurableObjectNamespace<StashEvents>;
      RL_READ: RateLimiter;
      RL_WRITE: RateLimiter;
      RL_DIFF: RateLimiter;
      STASH_ADMIN_TOKEN: string;
      ALLOWED_ORIGINS: string;
      STASH_DELETE_GRACE_DAYS: string;
      GC_ORPHAN_MIN_AGE_MS: string;
      GC_LEASE_TTL_MS: string;
      PROPOSAL_TTL_DAYS: string;
      STASH_EVENTS_MAX_STREAM_MS: string;
      TEST_MIGRATIONS: D1Migration[];
      STASH_RPC: TestStashRpcBinding;
    }
  }
}

export {};
