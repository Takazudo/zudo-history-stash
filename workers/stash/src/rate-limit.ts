import type { RouteId } from "@takazudo/zudo-history-stash-core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.js";
import type { Env, RateLimiter } from "./env.js";

type RateLimitBindingName = "RL_READ" | "RL_WRITE" | "RL_DIFF";
type RateLimitKeyKind = "principal" | "stash";
type RateLimitVerdict = "allowed" | "limited" | "unavailable";

export const RATE_LIMIT_BINDING_BY_ROUTE = {
  health: null,
  me: "RL_READ",
  listStashes: null,
  createStash: null,
  getStash: "RL_READ",
  createToken: null,
  listTokens: null,
  rotateToken: null,
  revokeToken: null,
  importHistory: null,
  listChanges: null,
  listFiles: "RL_READ",
  getFile: "RL_READ",
  putFile: "RL_WRITE",
  deleteFile: "RL_WRITE",
  rollbackFile: "RL_WRITE",
  getHistory: "RL_READ",
  getDiff: "RL_DIFF",
  diffCandidate: "RL_DIFF",
  getStashChanges: "RL_READ",
} as const satisfies Record<RouteId, RateLimitBindingName | null>;

const RATE_LIMITED_BODY = {
  error: {
    code: "rate-limited",
    message: "The request was rate limited.",
  },
} as const;

function limiterFor(env: Env, binding: RateLimitBindingName): RateLimiter {
  switch (binding) {
    case "RL_READ":
      return env.RL_READ;
    case "RL_WRITE":
      return env.RL_WRITE;
    case "RL_DIFF":
      return env.RL_DIFF;
  }
}

async function applyLimit(
  limiter: RateLimiter,
  key: string,
  routeId: RouteId,
  binding: RateLimitBindingName,
  keyKind: RateLimitKeyKind,
): Promise<RateLimitVerdict> {
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key });
  } catch {
    console.warn(
      JSON.stringify({
        event: "rate_limit_binding_unavailable",
        routeId,
        binding,
        keyKind,
        action: "fail_open",
      }),
    );
    return "unavailable";
  }
  return result.success ? "allowed" : "limited";
}

export function rateLimit(routeId: RouteId): MiddlewareHandler<AppEnv> {
  const bindingName = RATE_LIMIT_BINDING_BY_ROUTE[routeId];

  return async (c, next) => {
    const principal = c.get("principal");
    if (principal.kind === "admin" || bindingName === null) {
      await next();
      return;
    }

    const limiter = limiterFor(c.env, bindingName);
    const principalVerdict = await applyLimit(
      limiter,
      `p:${principal.tokenId}`,
      routeId,
      bindingName,
      "principal",
    );
    if (principalVerdict === "limited") {
      return c.json(RATE_LIMITED_BODY, 429, { "Retry-After": "60" });
    }
    if (principalVerdict === "unavailable") {
      await next();
      return;
    }

    const stashVerdict = await applyLimit(
      limiter,
      `s:${principal.stash}`,
      routeId,
      bindingName,
      "stash",
    );
    if (stashVerdict === "limited") {
      return c.json(RATE_LIMITED_BODY, 429, { "Retry-After": "60" });
    }

    await next();
  };
}
