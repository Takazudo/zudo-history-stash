import type { D1Migration } from "cloudflare:test";
import type { RpcRequest } from "@takazudo/zudo-history-stash-core";

interface TestStashRpcBinding {
  request(init: RpcRequest): Promise<Response>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      STASH_ADMIN_TOKEN: string;
      ALLOWED_ORIGINS: string;
      TEST_MIGRATIONS: D1Migration[];
      STASH_RPC: TestStashRpcBinding;
    }
  }
}

export {};
