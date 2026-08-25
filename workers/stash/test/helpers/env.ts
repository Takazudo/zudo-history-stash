import { env } from "cloudflare:workers";
import type { Env } from "../../src/env.js";
import type { StoreDependencies } from "../../src/d1/store.js";

export interface TestEnvironment {
  env: Env;
  deps: StoreDependencies;
}

export function createTestEnv(
  overrides: {
    now?: () => number;
    createId?: () => string;
    env?: Partial<Env>;
  } = {},
): TestEnvironment {
  return {
    env: {
      DB: env.DB,
      STASH_ADMIN_TOKEN: env.STASH_ADMIN_TOKEN,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      ...overrides.env,
    },
    deps: {
      now: overrides.now ?? Date.now,
      createId: overrides.createId ?? (() => crypto.randomUUID()),
    },
  };
}
