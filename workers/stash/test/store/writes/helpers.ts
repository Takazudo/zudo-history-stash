import { env } from "cloudflare:workers";
import type { Env } from "../../../src/env.js";
import { createWrites, type WriteDependencies } from "../../../src/d1/writes.js";

let sequence = 0;

export async function setup(overrides: Partial<WriteDependencies> = {}) {
  sequence += 1;
  const stash = `writes-${sequence}`;
  const now = overrides.now ?? (() => 1_700_000_000_000 + sequence);
  await env.DB.prepare(
    "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, '', '{}', ?)",
  )
    .bind(stash, now())
    .run();
  const workerEnv = env as Env;
  const deps: WriteDependencies = {
    now,
    createId: overrides.createId ?? (() => `id-${sequence}`),
    ...(overrides.onBeforeCommit ? { onBeforeCommit: overrides.onBeforeCommit } : {}),
  };
  return { env: workerEnv, stash, deps, writes: createWrites(workerEnv, deps) };
}

export async function counts(stash: string): Promise<{
  blobs: number;
  versions: number;
  files: number;
  idempotency: number;
}> {
  const result = { blobs: -1, versions: -1, files: -1, idempotency: -1 };
  for (const table of ["blobs", "versions", "files", "idempotency"] as const) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
      .bind(stash)
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

export function expectError(result: { ok: boolean; error?: { code: string } }, code: string) {
  if (result.ok) throw new Error(`Expected ${code}, got success`);
  if (result.error?.code !== code) {
    throw new Error(`Expected ${code}, got ${result.error?.code ?? "unknown"}`);
  }
}
