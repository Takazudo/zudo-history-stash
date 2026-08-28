import { env } from "cloudflare:workers";
import type { Env, RateLimiter } from "../../src/env.js";
import type { StoreDependencies } from "../../src/d1/store.js";

export interface TestEnvironment {
  env: Env;
  deps: StoreDependencies;
}

export interface BlobCallCounts {
  get: number;
  put: number;
}

export type BlobFailureRule = boolean | ((call: number, key: string) => boolean);

export interface WrapBlobsOptions {
  failPut?: BlobFailureRule;
  failGet?: BlobFailureRule;
  count?: BlobCallCounts;
}

function allowAllRateLimiter(): RateLimiter {
  return {
    limit: () => Promise.resolve({ success: true }),
  };
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
      BLOBS: env.BLOBS,
      STASH_EVENTS: env.STASH_EVENTS,
      RL_READ: allowAllRateLimiter(),
      RL_WRITE: allowAllRateLimiter(),
      RL_DIFF: allowAllRateLimiter(),
      STASH_ADMIN_TOKEN: env.STASH_ADMIN_TOKEN,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      STASH_DELETE_GRACE_DAYS: env.STASH_DELETE_GRACE_DAYS,
      GC_ORPHAN_MIN_AGE_MS: env.GC_ORPHAN_MIN_AGE_MS,
      GC_LEASE_TTL_MS: env.GC_LEASE_TTL_MS,
      PROPOSAL_TTL_DAYS: env.PROPOSAL_TTL_DAYS,
      STASH_EVENTS_MAX_STREAM_MS: env.STASH_EVENTS_MAX_STREAM_MS,
      JSON_INLINE_MAX_BYTES: env.JSON_INLINE_MAX_BYTES,
      D1_INLINE_MAX_BYTES: env.D1_INLINE_MAX_BYTES,
      HTTP_REQUEST_MAX_BYTES: env.HTTP_REQUEST_MAX_BYTES,
      SINGLE_UPLOAD_MAX_BYTES: env.SINGLE_UPLOAD_MAX_BYTES,
      MAX_FILE_BYTES: env.MAX_FILE_BYTES,
      DIFF_MAX_BYTES: env.DIFF_MAX_BYTES,
      MULTIPART_PART_BYTES: env.MULTIPART_PART_BYTES,
      MAX_OPEN_UPLOAD_SESSIONS: env.MAX_OPEN_UPLOAD_SESSIONS,
      MAX_RESERVED_UPLOAD_BYTES: env.MAX_RESERVED_UPLOAD_BYTES,
      UPLOAD_SESSION_TTL_SECONDS: env.UPLOAD_SESSION_TTL_SECONDS,
      ...overrides.env,
    },
    deps: {
      now: overrides.now ?? Date.now,
      createId: overrides.createId ?? (() => crypto.randomUUID()),
    },
  };
}

function shouldFail(rule: BlobFailureRule | undefined, call: number, key: string): boolean {
  return rule === true || (typeof rule === "function" && rule(call, key));
}

export function wrapBlobs(bindings: Env, options: WrapBlobsOptions = {}): Env {
  let getCalls = 0;
  let putCalls = 0;
  if (options.count) {
    options.count.get = 0;
    options.count.put = 0;
  }

  const blobs = new Proxy(bindings.BLOBS, {
    get(target, property) {
      if (property === "get") {
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const [key] = args;
          getCalls += 1;
          if (options.count) options.count.get = getCalls;
          if (shouldFail(options.failGet, getCalls, key)) {
            throw new Error("Injected R2 get failure");
          }
          return target.get(...args);
        };
      }
      if (property === "put") {
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const [key] = args;
          putCalls += 1;
          if (options.count) options.count.put = putCalls;
          if (shouldFail(options.failPut, putCalls, key)) {
            throw new Error("Injected R2 put failure");
          }
          return target.put(...args);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { ...bindings, BLOBS: blobs };
}
