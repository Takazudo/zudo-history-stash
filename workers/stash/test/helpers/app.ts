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
  const { DB: db, BLOBS: blobs } = createTestEnv().env;
  for (const table of [
    "upload_part_writes",
    "upload_parts",
    "upload_staged_bytes",
    "upload_objects",
    "upload_sessions",
    "gc_runs",
    "idempotency",
    "versions",
    "files",
    "blobs",
    "byte_blobs",
    "tokens",
    "stashes",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare(
      `UPDATE gc_jobs
       SET next_cursor = NULL,
           lease_owner = NULL,
           lease_generation = 0,
           lease_until = NULL,
           updated_at = 0`,
    )
    .run();
  await db.prepare("DELETE FROM sqlite_sequence WHERE name = 'versions'").run();

  for (;;) {
    const page = await blobs.list({ limit: 1_000 });
    const keys = page.objects.map(({ key }) => key);
    if (keys.length === 0) break;
    await blobs.delete(keys);
  }
}

export async function mintToken(
  stash: string,
  scope: "read" | "write",
  { expiresAt = null }: { expiresAt?: number | null } = {},
) {
  const minted = createToken();
  await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO tokens (id, stash_name, token_hash, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(minted.id, stash, await sha256Hex(minted.token), scope, Date.now(), expiresAt)
    .run();
  return minted;
}

export function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}
