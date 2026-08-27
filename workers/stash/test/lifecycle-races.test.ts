import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { R2_SPILL_BYTES } from "@takazudo/zudo-history-stash-core";
import { createAdminStore } from "../src/d1/admin-store.js";
import { createImport } from "../src/d1/import.js";
import { createWrites } from "../src/d1/writes.js";
import type { Env } from "../src/env.js";
import { resetDatabase, seedStash } from "./helpers/app.js";
import { generation } from "./helpers/blob-generations.js";
import { createTestEnv } from "./helpers/env.js";

const NOW = 1_900_000_000_000;

async function tableCounts(stash: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of ["blobs", "versions", "files", "idempotency"] as const) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE stash_name = ?`)
      .bind(stash)
      .first<{ count: number }>();
    result[table] = row?.count ?? -1;
  }
  return result;
}

function deleteAtCommit(stash: string): () => Promise<void> {
  return async () => {
    await createAdminStore(env as Env, { now: () => NOW }).deleteStash(stash);
  };
}

beforeEach(resetDatabase);

describe("delete races against live-stash mutations", () => {
  it("lets delete beat a prepared put with zero D1 mutations and one unique v2 orphan", async () => {
    const stash = "put-delete-race";
    await seedStash(stash);
    const before = await tableCounts(stash);
    const generationId = generation(129);
    const writes = createWrites(env as Env, {
      now: () => NOW,
      createId: () => "unused",
      createBlobGeneration: () => generationId,
      onBeforeCommit: deleteAtCommit(stash),
    });

    const result = await writes.put(stash, "race.txt", {
      body: `lost:${"x".repeat(R2_SPILL_BYTES + 1)}`,
      expectedVersion: null,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not-found", status: 404 } });
    expect(await tableCounts(stash)).toEqual(before);
    const objects = await env.BLOBS.list({ prefix: `v2/${stash}/` });
    expect(objects.objects).toHaveLength(1);
    expect(objects.objects[0]?.key).toContain(`/${generationId}`);
  });

  it("lets delete beat an import with zero D1 mutations and one unique v2 orphan", async () => {
    const stash = "import-delete-race";
    await seedStash(stash);
    const before = await tableCounts(stash);
    const generationId = generation(130);
    const importer = createImport(env as Env, {
      now: () => NOW,
      createId: () => "unused",
      createBlobGeneration: () => generationId,
      onBeforeCommit: deleteAtCommit(stash),
    });

    const result = await importer.importFile(stash, {
      path: "race.txt",
      expectedVersion: null,
      versions: [
        {
          kind: "put",
          body: `lost:${"y".repeat(R2_SPILL_BYTES + 1)}`,
          createdAt: NOW - 1,
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not-found", status: 404 } });
    expect(await tableCounts(stash)).toEqual(before);
    const objects = await env.BLOBS.list({ prefix: `v2/${stash}/` });
    expect(objects.objects).toHaveLength(1);
    expect(objects.objects[0]?.key).toContain(`/${generationId}`);
  });

  it("lets delete beat token creation and commits no successor token", async () => {
    const stash = "token-create-delete-race";
    await seedStash(stash);
    const token = { id: `tok_${"d".repeat(32)}`, token: `zhs_${"D".repeat(43)}` };
    const store = createAdminStore(createTestEnv().env, {
      now: () => NOW,
      mintToken: () => token,
      onBeforeCreateTokenCommit: deleteAtCommit(stash),
    });

    await expect(store.createToken(stash, { scope: "write" })).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM tokens WHERE stash_name = ?")
        .bind(stash)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("lets delete beat token rotation, revokes the predecessor, and creates no successor", async () => {
    const stash = "token-rotate-delete-race";
    await seedStash(stash);
    const predecessorId = `tok_${"e".repeat(32)}`;
    await env.DB.prepare(
      `INSERT INTO tokens
         (id, stash_name, token_hash, label, scope, created_at, revoked_at, rotated_to)
       VALUES (?, ?, 'hash', 'writer', 'write', ?, NULL, NULL)`,
    )
      .bind(predecessorId, stash, NOW - 1)
      .run();
    const successor = { id: `tok_${"f".repeat(32)}`, token: `zhs_${"F".repeat(43)}` };
    const store = createAdminStore(createTestEnv().env, {
      now: () => NOW,
      mintToken: () => successor,
      onBeforeRotateCommit: deleteAtCommit(stash),
    });

    await expect(store.rotateToken(stash, predecessorId, {})).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(
      env.DB.prepare(
        "SELECT id, revoked_at, rotated_to FROM tokens WHERE stash_name = ? ORDER BY id",
      )
        .bind(stash)
        .all(),
    ).resolves.toMatchObject({
      results: [{ id: predecessorId, revoked_at: NOW, rotated_to: null }],
    });
  });
});
