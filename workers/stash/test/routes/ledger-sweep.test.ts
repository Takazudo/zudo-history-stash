import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { request, resetDatabase, seedStash } from "../helpers/app.js";

const STASH = "route-sweep";
const BASE = `http://stash.test/v1/stashes/${STASH}`;

async function put(path: string, body: string): Promise<Response> {
  return request(app, `${BASE}/files/${path}`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer test-admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body, expectedVersion: null }),
  });
}

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency WHERE stash_name = ?")
    .bind(STASH)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

it("schedules ledger cleanup through waitUntil at most once per minute", async () => {
  const inserts = Array.from({ length: 205 }, (_, index) =>
    env.DB.prepare(
      `INSERT INTO idempotency
        (stash_name, key, request_hash, path, version, status_code, created_at)
       VALUES (?, ?, 'hash', 'path', 1, 201, 0)`,
    ).bind(STASH, `old-${index}`),
  );
  await env.DB.batch(inserts);

  expect((await put("sweep-one.txt", "one")).status).toBe(201);
  expect(await ledgerCount()).toBe(5);

  expect((await put("sweep-two.txt", "two")).status).toBe(201);
  expect(await ledgerCount()).toBe(5);
});
