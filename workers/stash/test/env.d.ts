import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      STASH_ADMIN_TOKEN: string;
      ALLOWED_ORIGINS: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
