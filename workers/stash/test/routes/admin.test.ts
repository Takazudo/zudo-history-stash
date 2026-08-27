import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/auth.js";
import { app, createApp } from "../../src/app.js";
import type { Env } from "../../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv } from "../helpers/env.js";

const BASE_URL = "http://example.test";

interface StashJson {
  name: string;
  description: string;
  meta?: Record<string, unknown>;
  fileCount: number;
  deletedFileCount: number;
  lastChangeId: number | null;
  lastChangeAt: string | null;
  createdAt: string;
}

interface ChangeJson {
  changeId: number;
  stash: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  author: string;
  message: string;
  size: number;
  createdAt: string;
}

interface ChangesJson {
  changes: ChangeJson[];
  nextSince?: number | null;
  nextBefore?: number | null;
  hasMore: boolean;
}

interface CreatedTokenJson {
  id: string;
  token: string;
  label: string;
  scope: "read" | "write";
  createdAt: string;
  expiresAt: string | null;
  rotatedFrom: string | null;
}

interface RotatedTokenJson extends CreatedTokenJson {
  predecessor: { id: string; expiresAt: string | null };
}

function withAdmin(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-admin");
  return { ...init, headers };
}

async function adminRequest(
  path: string,
  init: RequestInit = {},
  bindings?: Env,
): Promise<Response> {
  return request(app, `${BASE_URL}${path}`, withAdmin(init), bindings);
}

async function postJson(path: string, payload: unknown, token = "test-admin"): Promise<Response> {
  return request(app, `${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function insertStash(
  name: string,
  {
    createdAt = 1_000,
    description = "",
    metaJson = "{}",
  }: { createdAt?: number; description?: string; metaJson?: string } = {},
): Promise<void> {
  await createTestEnv()
    .env.DB.prepare(
      "INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(name, description, metaJson, createdAt)
    .run();
}

async function insertFile(
  stash: string,
  path: string,
  { deleted, updatedAt }: { deleted: boolean; updatedAt: number },
): Promise<void> {
  await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO files
         (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    )
    .bind(stash, path, deleted ? null : `sha256-${path}`, deleted ? 1 : 0, updatedAt, updatedAt)
    .run();
}

async function insertChange(
  stash: string,
  path: string,
  createdAt: number,
  { author = "author", message = "message", size = 10 } = {},
): Promise<number> {
  const result = await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, size_bytes, author, message, created_at)
       VALUES (?, ?, 1, 'put', ?, ?, ?, ?, ?)`,
    )
    .bind(stash, path, `sha256-${path}`, size, author, message, createdAt)
    .run();
  return result.meta.last_row_id;
}

function instrumentPrepare(db: D1Database, queries: string[]): D1Database {
  function instrumentSession(session: D1DatabaseSession): D1DatabaseSession {
    return new Proxy(session, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            queries.push(query);
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          return target.prepare(query);
        };
      }
      if (property === "withSession") {
        return (constraint?: string) => instrumentSession(target.withSession(constraint));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

describe("stash administration", () => {
  it("lists keyset-paginated stash aggregates with exactly one grouped SQL query", async () => {
    await insertStash("alpha", {
      description: "Alpha stash",
      metaJson: '{"owner":"one"}',
      createdAt: 1_000,
    });
    await insertStash("beta", { description: "Beta stash", createdAt: 2_000 });
    await insertFile("alpha", "live.txt", { deleted: false, updatedAt: 2_500 });
    await insertFile("alpha", "dead.txt", { deleted: true, updatedAt: 2_600 });
    const alphaChange = await insertChange("alpha", "live.txt", 3_000);
    await insertChange("beta", "beta.txt", 4_000);

    const queries: string[] = [];
    const base = createTestEnv().env;
    const response = await adminRequest(
      "/v1/stashes?limit=1",
      {},
      {
        ...base,
        DB: instrumentPrepare(base.DB, queries),
      },
    );
    expect(response.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("SUM(deleted = 0)");
    expect(queries[0]).toContain("SUM(deleted = 1)");
    expect(queries[0]).toContain("MAX(id)");
    expect(queries[0]?.match(/GROUP BY stash_name/g)).toHaveLength(2);

    const first = await response.json<{ stashes: StashJson[]; nextAfter: string | null }>();
    expect(first).toEqual({
      stashes: [
        {
          name: "alpha",
          description: "Alpha stash",
          fileCount: 1,
          deletedFileCount: 1,
          lastChangeId: alphaChange,
          lastChangeAt: new Date(3_000).toISOString(),
          createdAt: new Date(1_000).toISOString(),
        },
      ],
      nextAfter: "alpha",
    });
    expect(first.stashes[0]).not.toHaveProperty("meta");

    const secondResponse = await adminRequest("/v1/stashes?limit=1&after=alpha");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<{ stashes: StashJson[]; nextAfter: string | null }>();
    expect(second.stashes.map(({ name }) => name)).toEqual(["beta"]);
    expect(second.nextAfter).toBeNull();
  });

  it("creates and retrieves strict stash records with grouped counts", async () => {
    const createdResponse = await postJson("/v1/stashes", {
      name: "created-stash",
      description: "Created description",
      meta: { source: "test", nested: { ok: true } },
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<StashJson>();
    expect(created).toMatchObject({
      name: "created-stash",
      description: "Created description",
      meta: { source: "test", nested: { ok: true } },
      fileCount: 0,
      deletedFileCount: 0,
      lastChangeId: null,
      lastChangeAt: null,
    });
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);

    await insertFile("created-stash", "live.txt", { deleted: false, updatedAt: 3_000 });
    await insertFile("created-stash", "deleted.txt", { deleted: true, updatedAt: 4_000 });
    const changeId = await insertChange("created-stash", "live.txt", 5_000);
    const getResponse = await adminRequest("/v1/stashes/created-stash");
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json<StashJson>()).toEqual({
      ...created,
      fileCount: 1,
      deletedFileCount: 1,
      lastChangeId: changeId,
      lastChangeAt: new Date(5_000).toISOString(),
    });

    const duplicate = await postJson("/v1/stashes", { name: "created-stash" });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: "exists" } });

    const missing = await adminRequest("/v1/stashes/missing");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });

  it("strictly rejects invalid list and create inputs without leaking request bodies", async () => {
    const marker = "ZHS_ADMIN_BODY_MUST_NOT_BE_ECHOED";
    const consoleCalls: unknown[][] = [];
    for (const method of ["debug", "error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => consoleCalls.push(args));
    }

    const invalidName = await postJson("/v1/stashes", { name: "Invalid-Name" });
    expect(invalidName.status).toBe(400);
    await expect(invalidName.json()).resolves.toMatchObject({ error: { code: "validation" } });

    const unknownKey = await postJson("/v1/stashes", {
      name: "body-marker",
      description: marker,
      unexpected: marker,
    });
    expect(unknownKey.status).toBe(400);
    const errorText = await unknownKey.text();
    expect(errorText).not.toContain(marker);
    expect(JSON.stringify(consoleCalls)).not.toContain(marker);

    const malformed = await request(app, `${BASE_URL}/v1/stashes`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: `{"name":"malformed","description":"${marker}"`,
    });
    expect(malformed.status).toBe(400);
    const malformedText = await malformed.text();
    expect(malformedText).not.toContain(marker);
    expect(JSON.parse(malformedText)).toEqual({
      error: { code: "validation", message: "Invalid JSON body." },
    });

    for (const path of ["/v1/stashes?limit=201", "/v1/stashes?limit=1&unexpected=true"]) {
      const response = await adminRequest(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "validation" } });
    }
  });

  it("allows only the matching stash principal on the admin-or-stash detail route", async () => {
    await seedStash("alpha");
    await seedStash("beta");
    const token = await mintToken("alpha", "write");

    const own = await request(app, `${BASE_URL}/v1/stashes/alpha`, {
      headers: bearer(token.token),
    });
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ name: "alpha" });

    const foreign = await request(app, `${BASE_URL}/v1/stashes/beta`, {
      headers: bearer(token.token),
    });
    expect(foreign.status).toBe(404);

    const concealed = await request(app, `${BASE_URL}/v1/changes`, {
      headers: bearer(token.token),
    });
    expect(concealed.status).toBe(404);
    await expect(concealed.json()).resolves.toEqual({
      error: { code: "not-found", message: "The requested resource was not found." },
    });
  });
});

describe("stash token administration", () => {
  it("returns a plaintext token once while persisting only its hash", async () => {
    await seedStash("tokens");
    const createResponse = await postJson("/v1/stashes/tokens/tokens", {
      label: "Viewer",
      scope: "read",
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      id: string;
      token: string;
      label: string;
      scope: "read" | "write";
      createdAt: string;
      expiresAt: string | null;
      rotatedFrom: string | null;
    }>();
    expect(created).toMatchObject({
      label: "Viewer",
      scope: "read",
      expiresAt: null,
      rotatedFrom: null,
    });
    expect(created.id).toMatch(/^tok_[0-9a-f]{32}$/);
    expect(created.token).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);

    const stored = await createTestEnv()
      .env.DB.prepare(
        "SELECT id, token_hash, label, scope, created_at, revoked_at, last_used_at FROM tokens WHERE id = ?",
      )
      .bind(created.id)
      .first<{
        id: string;
        token_hash: string;
        label: string;
        scope: string;
        created_at: number;
        revoked_at: number | null;
        last_used_at: number | null;
      }>();
    expect(stored?.token_hash).toBe(await sha256Hex(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const listResponse = await adminRequest("/v1/stashes/tokens/tokens");
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json<{ tokens: Array<Record<string, unknown>> }>();
    expect(listed).toEqual({
      tokens: [
        {
          id: created.id,
          label: "Viewer",
          scope: "read",
          createdAt: created.createdAt,
          expiresAt: null,
          rotatedFrom: null,
          rotatedTo: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("token_hash");
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("stores explicit and TTL expiries in milliseconds and lists rotation metadata", async () => {
    const now = 1_800_000_000_123;
    const explicitExpiry = now + 86_400_456;
    const fixedApp = createApp({ now: () => now });
    await seedStash("expiries");
    const createToken = (payload: unknown) =>
      request(fixedApp, `${BASE_URL}/v1/stashes/expiries/tokens`, {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    const explicitResponse = await createToken({
      label: "Explicit",
      scope: "read",
      expiresAt: new Date(explicitExpiry).toISOString(),
    });
    expect(explicitResponse.status).toBe(201);
    const explicit = await explicitResponse.json<{ id: string; expiresAt: string | null }>();
    expect(explicit.expiresAt).toBe(new Date(explicitExpiry).toISOString());

    const ttlResponse = await createToken({ label: "TTL", scope: "write", ttlSeconds: 60 });
    expect(ttlResponse.status).toBe(201);
    const ttl = await ttlResponse.json<{ id: string; expiresAt: string | null }>();
    expect(ttl.expiresAt).toBe(new Date(now + 60_000).toISOString());

    await createTestEnv()
      .env.DB.prepare("UPDATE tokens SET rotated_from = ?, rotated_to = ? WHERE id = ?")
      .bind("tok_predecessor", "tok_successor", explicit.id)
      .run();
    const stored = await createTestEnv()
      .env.DB.prepare(
        `SELECT id, created_at, expires_at, rotated_from, rotated_to
         FROM tokens
         WHERE id IN (?, ?)
         ORDER BY id`,
      )
      .bind(explicit.id, ttl.id)
      .all<{
        id: string;
        created_at: number;
        expires_at: number | null;
        rotated_from: string | null;
        rotated_to: string | null;
      }>();
    expect(stored.results).toEqual(
      expect.arrayContaining([
        {
          id: explicit.id,
          created_at: now,
          expires_at: explicitExpiry,
          rotated_from: "tok_predecessor",
          rotated_to: "tok_successor",
        },
        {
          id: ttl.id,
          created_at: now,
          expires_at: now + 60_000,
          rotated_from: null,
          rotated_to: null,
        },
      ]),
    );

    const listResponse = await request(fixedApp, `${BASE_URL}/v1/stashes/expiries/tokens`, {
      headers: bearer("test-admin"),
    });
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json<{
      tokens: Array<{
        id: string;
        expiresAt: string | null;
        rotatedFrom: string | null;
        rotatedTo: string | null;
      }>;
    }>();
    expect(listed.tokens.find(({ id }) => id === explicit.id)).toMatchObject({
      expiresAt: new Date(explicitExpiry).toISOString(),
      rotatedFrom: "tok_predecessor",
      rotatedTo: "tok_successor",
    });
    expect(listed.tokens.find(({ id }) => id === ttl.id)).toMatchObject({
      expiresAt: new Date(now + 60_000).toISOString(),
      rotatedFrom: null,
      rotatedTo: null,
    });
  });

  it("requires a strictly future expiry while allowing the inclusive ten-year bound", async () => {
    const now = 1_800_000_000_000;
    const tenYearsMs = 315_360_000 * 1_000;
    const fixedApp = createApp({ now: () => now });
    await seedStash("expiry-bounds");
    const createToken = (expiresAt: number) =>
      request(fixedApp, `${BASE_URL}/v1/stashes/expiry-bounds/tokens`, {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "read", expiresAt: new Date(expiresAt).toISOString() }),
      });

    for (const invalidExpiry of [now - 1, now, now + tenYearsMs + 1]) {
      const response = await createToken(invalidExpiry);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "validation" } });
    }

    const boundary = await createToken(now + tenYearsMs);
    expect(boundary.status).toBe(201);
    await expect(boundary.json()).resolves.toMatchObject({
      expiresAt: new Date(now + tenYearsMs).toISOString(),
    });
  });

  it("rotates through the functional route, truncates grace, and exposes recovery metadata", async () => {
    let now = 1_800_000_000_000;
    const createdAt = now;
    const originalExpiry = createdAt + 2 * 86_400_000;
    const graceEnd = createdAt + 300_000;
    const successorExpiry = createdAt + 3_600_000;
    const fixedApp = createApp({ now: () => now });
    const consoleCalls: unknown[][] = [];
    for (const method of ["debug", "error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => consoleCalls.push(args));
    }
    await seedStash("rotation");

    const predecessorResponse = await request(fixedApp, `${BASE_URL}/v1/stashes/rotation/tokens`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Writer",
        scope: "write",
        expiresAt: new Date(originalExpiry).toISOString(),
      }),
    });
    const predecessor = await predecessorResponse.json<CreatedTokenJson>();

    const rotateResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation/tokens/${predecessor.id}/rotate`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({
          graceSeconds: 300,
          expiresAt: new Date(successorExpiry).toISOString(),
        }),
      },
    );
    expect(rotateResponse.status).toBe(201);
    const successor = await rotateResponse.json<RotatedTokenJson>();
    expect(successor).toEqual({
      id: expect.stringMatching(/^tok_[0-9a-f]{32}$/),
      token: expect.stringMatching(/^zhs_[A-Za-z0-9_-]{43}$/),
      label: "Writer",
      scope: "write",
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(successorExpiry).toISOString(),
      rotatedFrom: predecessor.id,
      predecessor: {
        id: predecessor.id,
        expiresAt: new Date(graceEnd).toISOString(),
      },
    });

    const listedResponse = await request(fixedApp, `${BASE_URL}/v1/stashes/rotation/tokens`, {
      headers: bearer("test-admin"),
    });
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json<{ tokens: Array<Record<string, unknown>> }>();
    expect(listed.tokens.find(({ id }) => id === predecessor.id)).toMatchObject({
      id: predecessor.id,
      expiresAt: new Date(graceEnd).toISOString(),
      rotatedFrom: null,
      rotatedTo: successor.id,
    });
    expect(listed.tokens.find(({ id }) => id === successor.id)).toMatchObject({
      id: successor.id,
      label: "Writer",
      scope: "write",
      expiresAt: new Date(successorExpiry).toISOString(),
      rotatedFrom: predecessor.id,
      rotatedTo: null,
    });

    const stored = await createTestEnv()
      .env.DB.prepare(
        `SELECT id, token_hash, expires_at, rotated_from, rotated_to
         FROM tokens
         WHERE id IN (?, ?)`,
      )
      .bind(predecessor.id, successor.id)
      .all<{
        id: string;
        token_hash: string;
        expires_at: number | null;
        rotated_from: string | null;
        rotated_to: string | null;
      }>();
    const storedPredecessor = stored.results.find(({ id }) => id === predecessor.id);
    const storedSuccessor = stored.results.find(({ id }) => id === successor.id);
    expect(storedPredecessor).toMatchObject({
      expires_at: graceEnd,
      rotated_from: null,
      rotated_to: successor.id,
    });
    expect(storedSuccessor).toMatchObject({
      token_hash: await sha256Hex(successor.token),
      expires_at: successorExpiry,
      rotated_from: predecessor.id,
      rotated_to: null,
    });
    expect(JSON.stringify(stored)).not.toContain(successor.token);
    expect(JSON.stringify(listed)).not.toContain(successor.token);
    expect(JSON.stringify(consoleCalls)).not.toContain(successor.token);

    const successorMe = await request(fixedApp, `${BASE_URL}/v1/me`, {
      headers: bearer(successor.token),
    });
    expect(successorMe.status).toBe(200);
    await expect(successorMe.json()).resolves.toMatchObject({
      tokenId: successor.id,
      expiresAt: new Date(successorExpiry).toISOString(),
    });

    now = graceEnd - 1;
    const predecessorBeforeBoundary = await request(fixedApp, `${BASE_URL}/v1/me`, {
      headers: bearer(predecessor.token),
    });
    expect(predecessorBeforeBoundary.status).toBe(200);

    now = graceEnd;
    const predecessorAtBoundary = await request(fixedApp, `${BASE_URL}/v1/me`, {
      headers: bearer(predecessor.token),
    });
    expect(predecessorAtBoundary.status).toBe(401);
  });

  it("inherits a nullable expiry and returns the winner id on a one-shot retry", async () => {
    const now = 1_810_000_000_000;
    const fixedApp = createApp({ now: () => now });
    await seedStash("rotation-null");
    const predecessorResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation-null/tokens`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Never", scope: "read" }),
      },
    );
    const predecessor = await predecessorResponse.json<CreatedTokenJson>();
    const rotatePath = `/v1/stashes/rotation-null/tokens/${predecessor.id}/rotate`;

    const first = await request(fixedApp, `${BASE_URL}${rotatePath}`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(201);
    const successor = await first.json<RotatedTokenJson>();
    expect(successor.expiresAt).toBeNull();
    expect(successor.predecessor).toEqual({
      id: predecessor.id,
      expiresAt: new Date(now + 300_000).toISOString(),
    });

    const retry = await request(fixedApp, `${BASE_URL}${rotatePath}`, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({
      error: {
        code: "already-rotated",
        message: "Token was already rotated.",
        successorId: successor.id,
      },
    });
    const count = await createTestEnv()
      .env.DB.prepare("SELECT COUNT(*) AS count FROM tokens WHERE rotated_from = ?")
      .bind(predecessor.id)
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("refuses missing, revoked, and expired predecessors without successor rows", async () => {
    let now = 1_820_000_000_000;
    const fixedApp = createApp({ now: () => now });
    await seedStash("rotation-refused");
    const create = async (expiresAt?: number) => {
      const response = await request(fixedApp, `${BASE_URL}/v1/stashes/rotation-refused/tokens`, {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "write",
          ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
        }),
      });
      return response.json<CreatedTokenJson>();
    };
    const revoked = await create();
    const expiredAt = now + 1_000;
    const expired = await create(expiredAt);
    await request(fixedApp, `${BASE_URL}/v1/stashes/rotation-refused/tokens/${revoked.id}`, {
      method: "DELETE",
      headers: bearer("test-admin"),
    });

    const missingResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation-refused/tokens/tok_missing/rotate`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      error: { code: "not-found", message: "The requested resource was not found." },
    });

    const revokedResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation-refused/tokens/${revoked.id}/rotate`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(revokedResponse.status).toBe(404);

    now = expiredAt;
    const expiredResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation-refused/tokens/${expired.id}/rotate`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(expiredResponse.status).toBe(409);
    await expect(expiredResponse.json()).resolves.toEqual({
      error: { code: "token-expired", message: "Token is expired." },
    });

    const refusedSuccessors = await createTestEnv()
      .env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tokens WHERE rotated_from IN (?, ?) OR rotated_from = 'tok_missing'",
      )
      .bind(revoked.id, expired.id)
      .first<number>("count");
    expect(refusedSuccessors).toBe(0);
  });

  it("grace zero rejects the predecessor immediately and validates rotation bodies strictly", async () => {
    const now = 1_830_000_000_000;
    const fixedApp = createApp({ now: () => now });
    await seedStash("rotation-zero");
    const predecessorResponse = await request(
      fixedApp,
      `${BASE_URL}/v1/stashes/rotation-zero/tokens`,
      {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "read" }),
      },
    );
    const predecessor = await predecessorResponse.json<CreatedTokenJson>();
    const path = `${BASE_URL}/v1/stashes/rotation-zero/tokens/${predecessor.id}/rotate`;

    for (const payload of [
      { graceSeconds: -1 },
      { graceSeconds: 86_401 },
      { expiresAt: new Date(now + 60_000).toISOString(), ttlSeconds: 60 },
      { unexpected: true },
    ]) {
      const invalid = await request(fixedApp, path, {
        method: "POST",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        error: { code: "validation", message: "Invalid token rotation input." },
      });
    }

    const rotated = await request(fixedApp, path, {
      method: "POST",
      headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
      body: JSON.stringify({ graceSeconds: 0 }),
    });
    expect(rotated.status).toBe(201);
    const rejected = await request(fixedApp, `${BASE_URL}/v1/me`, {
      headers: bearer(predecessor.token),
    });
    expect(rejected.status).toBe(401);
  });

  it("revokes a token, rejects it on the next request, and reports unknown ids", async () => {
    await seedStash("tokens");
    const createdResponse = await postJson("/v1/stashes/tokens/tokens", {
      scope: "write",
    });
    const created = await createdResponse.json<{ id: string; token: string }>();

    const usable = await request(app, `${BASE_URL}/v1/me`, { headers: bearer(created.token) });
    expect(usable.status).toBe(200);

    const revoked = await adminRequest(`/v1/stashes/tokens/tokens/${created.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);
    expect(await revoked.text()).toBe("");
    const revokedAt = await createTestEnv()
      .env.DB.prepare("SELECT revoked_at FROM tokens WHERE id = ?")
      .bind(created.id)
      .first<number>("revoked_at");
    expect(revokedAt).toBeTypeOf("number");

    const rejected = await request(app, `${BASE_URL}/v1/me`, {
      headers: bearer(created.token),
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });

    const unknown = await adminRequest("/v1/stashes/tokens/tokens/tok_missing", {
      method: "DELETE",
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "not-found" } });
  });

  it("strictly validates token bodies and returns 404 for an unknown stash", async () => {
    await seedStash("tokens");
    for (const payload of [
      { scope: "admin" },
      { scope: "read", unexpected: true },
      { label: "missing scope" },
    ]) {
      const response = await postJson("/v1/stashes/tokens/tokens", payload);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "validation" } });
    }

    const createMissing = await postJson("/v1/stashes/missing/tokens", { scope: "read" });
    expect(createMissing.status).toBe(404);
    const listMissing = await adminRequest("/v1/stashes/missing/tokens");
    expect(listMissing.status).toBe(404);
  });
});

describe("cross-stash changes", () => {
  it("pages newest-first and since-forward without gaps or duplicates", async () => {
    await seedStash("alpha");
    await seedStash("beta");
    const ids = [
      await insertChange("alpha", "one.txt", 1_000, { author: "one", size: 1 }),
      await insertChange("beta", "two.txt", 2_000, { author: "two", size: 2 }),
      await insertChange("alpha", "three.txt", 3_000, { author: "three", size: 3 }),
      await insertChange("beta", "four.txt", 4_000, { author: "four", size: 4 }),
      await insertChange("alpha", "five.txt", 5_000, { author: "five", size: 5 }),
    ];
    const descending = [...ids].reverse();

    const newestResponse = await adminRequest("/v1/changes?limit=2");
    expect(newestResponse.status).toBe(200);
    const newest = await newestResponse.json<ChangesJson>();
    expect(newest.changes.map(({ changeId }) => changeId)).toEqual(descending.slice(0, 2));
    expect(newest).toMatchObject({ nextBefore: descending[1], hasMore: true });
    expect(newest).not.toHaveProperty("nextSince");
    expect(newest.changes[0]).toEqual({
      changeId: ids[4],
      stash: "alpha",
      path: "five.txt",
      version: 1,
      kind: "put",
      author: "five",
      message: "message",
      size: 5,
      createdAt: new Date(5_000).toISOString(),
    });

    const olderResponse = await adminRequest(
      `/v1/changes?limit=2&before=${String(newest.nextBefore)}`,
    );
    const older = await olderResponse.json<ChangesJson>();
    expect(older.changes.map(({ changeId }) => changeId)).toEqual(descending.slice(2, 4));
    expect(older).toMatchObject({ nextBefore: descending[3], hasMore: true });

    const oldestResponse = await adminRequest(
      `/v1/changes?limit=2&before=${String(older.nextBefore)}`,
    );
    const oldest = await oldestResponse.json<ChangesJson>();
    expect(oldest.changes.map(({ changeId }) => changeId)).toEqual(descending.slice(4));
    expect(oldest).toMatchObject({ nextBefore: null, hasMore: false });
    expect(
      [...newest.changes, ...older.changes, ...oldest.changes].map((item) => item.changeId),
    ).toEqual(descending);

    const firstForwardResponse = await adminRequest("/v1/changes?limit=2&since=0");
    const firstForward = await firstForwardResponse.json<ChangesJson>();
    expect(firstForward.changes.map(({ changeId }) => changeId)).toEqual(ids.slice(0, 2));
    expect(firstForward).toMatchObject({ nextSince: ids[1], hasMore: true });
    expect(firstForward).not.toHaveProperty("nextBefore");

    const secondForwardResponse = await adminRequest(
      `/v1/changes?limit=2&since=${String(firstForward.nextSince)}`,
    );
    const secondForward = await secondForwardResponse.json<ChangesJson>();
    expect(secondForward.changes.map(({ changeId }) => changeId)).toEqual(ids.slice(2, 4));
    expect(secondForward).toMatchObject({ nextSince: ids[3], hasMore: true });

    const finalForwardResponse = await adminRequest(
      `/v1/changes?limit=2&since=${String(secondForward.nextSince)}`,
    );
    const finalForward = await finalForwardResponse.json<ChangesJson>();
    expect(finalForward.changes.map(({ changeId }) => changeId)).toEqual(ids.slice(4));
    expect(finalForward).toMatchObject({ nextSince: null, hasMore: false });
    expect(
      [...firstForward.changes, ...secondForward.changes, ...finalForward.changes].map(
        (item) => item.changeId,
      ),
    ).toEqual(ids);
  });

  it("rejects conflicting cursors, excessive limits, and unknown query keys", async () => {
    for (const path of [
      "/v1/changes?since=1&before=2",
      "/v1/changes?limit=201",
      "/v1/changes?unexpected=true",
    ]) {
      const response = await adminRequest(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "validation" } });
    }
  });
});
