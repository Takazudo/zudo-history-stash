import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Hono } from "hono";
import { mintToken as createToken, sha256Hex } from "../../src/auth.js";
import type { AppEnv } from "../../src/context.js";
import { createTestEnv } from "./env.js";

export async function request(
  app: Hono<AppEnv>,
  url: string,
  init?: RequestInit,
  bindings: AppEnv["Bindings"] = createTestEnv().env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.request(url, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function seedStash(name: string): Promise<void> {
  await createTestEnv()
    .env.DB.prepare(
      "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, '', '{}', ?)",
    )
    .bind(name, Date.now())
    .run();
}

export async function resetDatabase(): Promise<void> {
  const db = createTestEnv().env.DB;
  for (const table of ["idempotency", "versions", "files", "blobs", "tokens", "stashes"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

export async function mintToken(stash: string, scope: "read" | "write") {
  const minted = createToken();
  await createTestEnv()
    .env.DB.prepare(
      "INSERT INTO tokens (id, stash_name, token_hash, scope, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(minted.id, stash, await sha256Hex(minted.token), scope, Date.now())
    .run();
  return minted;
}

export function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}
