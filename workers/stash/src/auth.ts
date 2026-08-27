import { ROUTES, StashError, type RouteId } from "@takazudo/zudo-history-stash-core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Principal } from "./context.js";
import type { StashRow, TokenRow } from "./d1/schema.js";

const encoder = new TextEncoder();
const LAST_USED_INTERVAL_MS = 60_000;

function unauthorized(): StashError {
  return new StashError("unauthorized", "A valid bearer token is required.");
}

async function sha256Bytes(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await sha256Bytes(value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || authorization.includes(",")) throw unauthorized();
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match?.[1] === undefined) throw unauthorized();
  return match[1];
}

async function isAdmin(token: string, adminToken: string): Promise<boolean> {
  const [presentedHash, adminHash] = await Promise.all([
    sha256Bytes(token),
    sha256Bytes(adminToken),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(presentedHash, adminHash);
}

function touchLastUsed(env: AppEnv["Bindings"], token: TokenRow, now: number): Promise<unknown> {
  return env.DB.prepare(
    "UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)",
  )
    .bind(now, token.id, now - LAST_USED_INTERVAL_MS)
    .run();
}

export const requireToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  let principal: Principal;
  try {
    const token = bearerToken(c.req.raw);
    if (await isAdmin(token, c.env.STASH_ADMIN_TOKEN)) {
      principal = { kind: "admin" };
    } else {
      if (!token.startsWith("zhs_")) throw unauthorized();
      const now = c.get("deps").now();
      const tokenRow = await c.env.DB.prepare(
        `SELECT
           id, stash_name, token_hash, label, scope, created_at, revoked_at, last_used_at,
           expires_at, rotated_from, rotated_to
         FROM tokens
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
        .bind(await sha256Hex(token), now)
        .first<TokenRow>();
      if (tokenRow === null || (tokenRow.scope !== "read" && tokenRow.scope !== "write")) {
        throw unauthorized();
      }
      principal = {
        kind: "stash",
        stash: tokenRow.stash_name,
        tokenId: tokenRow.id,
        scope: tokenRow.scope,
        expiresAt:
          tokenRow.expires_at === null ? null : new Date(tokenRow.expires_at).toISOString(),
      };
      if (tokenRow.last_used_at === null || tokenRow.last_used_at <= now - LAST_USED_INTERVAL_MS) {
        c.executionCtx.waitUntil(touchLastUsed(c.env, tokenRow, now));
      }
    }
  } catch {
    throw unauthorized();
  }
  c.set("principal", principal);
  await next();
};

export function requireRoute(routeId: RouteId): MiddlewareHandler<AppEnv> {
  const route = ROUTES.find((candidate) => candidate.id === routeId);
  if (route === undefined) throw new Error(`Unknown route: ${routeId}`);

  return async (c, next) => {
    const principal = c.get("principal");
    const stash = c.req.param("stash");
    if (principal.kind !== "admin") {
      if (route.principal === "admin") {
        throw new StashError("not-found", "The requested resource was not found.");
      }
      if (stash !== undefined && principal.stash !== stash) {
        throw new StashError("not-found", "The requested resource was not found.");
      }
      if (route.principal === "write" && principal.scope !== "write") {
        throw new StashError("scope", "This token does not have write access.");
      }
    }
    const allowsDeleted =
      route.id === "deleteStash" ||
      route.id === "restoreStash" ||
      (route.id === "getStash" && principal.kind === "admin");
    if (stash !== undefined && !allowsDeleted) {
      const row = await c.env.DB.withSession("first-primary")
        .prepare(
          `SELECT name, description, meta_json, created_at, deleted_at
           FROM stashes
           WHERE name = ? AND deleted_at IS NULL
           LIMIT 1`,
        )
        .bind(stash)
        .first<StashRow>();
      if (row === null) {
        throw new StashError("not-found", "The requested resource was not found.");
      }
      c.set("routeStash", row);
    }
    await next();
  };
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function mintToken(): { id: string; token: string } {
  return { id: `tok_${randomHex(16)}`, token: `zhs_${randomBase64Url(32)}` };
}
