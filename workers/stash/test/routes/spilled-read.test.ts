import {
  DIFF_MAX_BYTES,
  R2_SPILL_BYTES,
  formatEtag,
  sha256Hex,
  utf8ByteLength,
} from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prepareBlob } from "../../src/d1/blobs.js";
import { createStashStore } from "../../src/d1/store.js";
import type { Env } from "../../src/env.js";
import { request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";
import { seedCommit } from "../helpers/seed-rows.js";

const STASH = "spilled-read";
const BASE = `http://stash.test/v1/stashes/${STASH}`;
const CREATED_AT = 1_780_000_000_000;

interface SeedVersionInput {
  body: string;
  kind?: "put" | "rollback";
  rollbackOf?: number;
}

interface SeededVersion {
  version: number;
  body: string;
  hash: string;
  size: number;
  key: string | null;
  kind: "put" | "rollback";
  createdAt: number;
}

function bodyAtSize(prefix: string, size: number): string {
  const prefixSize = utf8ByteLength(prefix);
  if (prefixSize > size) throw new Error("Fixture prefix exceeds requested byte size");
  const body = `${prefix}${"x".repeat(size - prefixSize)}`;
  if (utf8ByteLength(body) !== size) throw new Error("Fixture has an unexpected UTF-8 size");
  return body;
}

function spilledBody(prefix: string): string {
  return bodyAtSize(prefix, R2_SPILL_BYTES + 1);
}

async function api(path: string, init: RequestInit = {}, bindings?: Env): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-admin");
  return request(app, `${BASE}${path}`, { ...init, headers }, bindings);
}

async function candidate(path: string, body: string, bindings: Env): Promise<Response> {
  return api(
    `/diff/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "head", body }),
    },
    bindings,
  );
}

function rejectingReads(): { bindings: Env; counts: BlobCallCounts } {
  const counts: BlobCallCounts = { get: 0, put: 0 };
  return {
    bindings: wrapBlobs(createTestEnv().env, { count: counts, failGet: true }),
    counts,
  };
}

async function seedFile(
  path: string,
  inputs: readonly SeedVersionInput[],
): Promise<SeededVersion[]> {
  if (inputs.length === 0) throw new Error("A file needs at least one version");
  const bindings = createTestEnv().env;
  const preparedByHash = new Map<string, { body: string | null; r2_key: string | null }>();
  const versions: SeededVersion[] = [];

  for (const [index, input] of inputs.entries()) {
    const version = index + 1;
    const kind = input.kind ?? "put";
    const rollbackOf = kind === "rollback" ? (input.rollbackOf ?? 1) : null;
    const hash = await sha256Hex(input.body);
    const size = utf8ByteLength(input.body);
    const createdAt = CREATED_AT + version;
    let prepared = preparedByHash.get(hash);
    if (prepared === undefined) {
      prepared = await prepareBlob(bindings, STASH, hash, input.body);
      preparedByHash.set(hash, prepared);
      await bindings.DB.prepare(
        `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(STASH, hash, prepared.body, prepared.r2_key, size, createdAt)
        .run();
    }

    const commitId = await seedCommit(
      STASH,
      `cmt_spilled_${path}_${version}`,
      createdAt,
      kind,
    );
    await bindings.DB.prepare(
      `INSERT INTO versions (
        stash_name, path, version, kind, blob_hash, size_bytes, content_type,
        rollback_of, author, message, meta_json, created_at, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        STASH,
        path,
        version,
        kind,
        hash,
        size,
        rollbackOf,
        "reader",
        `version ${version}`,
        JSON.stringify({ version }),
        createdAt,
        commitId,
      )
      .run();
    versions.push({
      version,
      body: input.body,
      hash,
      size,
      key: prepared.r2_key,
      kind,
      createdAt,
    });
  }

  const head = versions.at(-1);
  if (head === undefined) throw new Error("Expected a head version");
  await bindings.DB.prepare(
    `INSERT INTO files (
      stash_name, path, head_version, head_hash, deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      STASH,
      path,
      head.version,
      head.hash,
      versions[0]?.createdAt ?? CREATED_AT,
      head.createdAt,
    )
    .run();

  return versions;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("spilled file reads", () => {
  it("keeps source inspection storage-free and composes getFile through materialization", async () => {
    const body = spilledBody("COMPOSED_READ_MARKER\r\n");
    const [version] = await seedFile("composed.txt", [{ body }]);
    if (version === undefined) throw new Error("Missing fixture");
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const reads = createStashStore(wrapBlobs(createTestEnv().env, { count: counts })).reads;

    const source = await reads.getFileSource(STASH, "composed.txt");
    expect(source).not.toBeNull();
    if (source === null) throw new Error("Expected a file source");
    expect(source.metadata).toMatchObject({ version: 1, hash: version.hash, size: version.size });
    expect(source.metadata).not.toHaveProperty("body");
    expect(counts).toEqual({ get: 0, put: 0 });

    await expect(reads.materializeFile(source)).resolves.toMatchObject({ body });
    expect(counts).toEqual({ get: 1, put: 0 });
    await expect(reads.getFile(STASH, "composed.txt")).resolves.toMatchObject({ body });
    expect(counts).toEqual({ get: 2, put: 0 });
  });

  it("serves exact spilled head and historical text with application representation headers", async () => {
    const oldBody = spilledBody("\uFEFF古い日本語\r\nOLD_BODY_MARKER\r\n");
    const headBody = spilledBody("\uFEFF新しい日本語\r\nHEAD_BODY_MARKER\r\n");
    const [oldVersion, headVersion] = await seedFile("exact.txt", [
      { body: oldBody },
      { body: headBody },
    ]);
    if (oldVersion === undefined || headVersion === undefined) throw new Error("Missing fixture");

    const headCounts: BlobCallCounts = { get: 0, put: 0 };
    const headResponse = await api(
      "/files/exact.txt",
      {},
      wrapBlobs(createTestEnv().env, { count: headCounts }),
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("ETag")).toBe(
      formatEtag({ version: 2, hash: headVersion.hash, deleted: false }),
    );
    expect(headResponse.headers.get("X-Stash-Version")).toBe("2");
    await expect(headResponse.json()).resolves.toMatchObject({
      path: "exact.txt",
      version: 2,
      hash: headVersion.hash,
      size: headVersion.size,
      kind: "put",
      author: "reader",
      message: "version 2",
      meta: { version: 2 },
      createdAt: new Date(headVersion.createdAt).toISOString(),
      deleted: false,
      body: headBody,
    });
    expect(headCounts).toEqual({ get: 1, put: 0 });

    const versionCounts: BlobCallCounts = { get: 0, put: 0 };
    const versionResponse = await api(
      "/files/exact.txt?version=1",
      {},
      wrapBlobs(createTestEnv().env, { count: versionCounts }),
    );
    expect(versionResponse.status).toBe(200);
    expect(versionResponse.headers.get("ETag")).toBe(
      formatEtag({ version: 1, hash: oldVersion.hash, deleted: false }),
    );
    expect(versionResponse.headers.get("X-Stash-Version")).toBe("1");
    const historical = await versionResponse.json<Record<string, unknown>>();
    expect(historical).toMatchObject({
      path: "exact.txt",
      version: 1,
      hash: oldVersion.hash,
      size: oldVersion.size,
      kind: "put",
      author: "reader",
      message: "version 1",
      meta: { version: 1 },
      createdAt: new Date(oldVersion.createdAt).toISOString(),
      deleted: false,
      body: oldBody,
    });
    expect(historical.body?.toString().codePointAt(0)).toBe(0xfeff);
    expect(historical).not.toHaveProperty("r2_key");
    expect(historical).not.toHaveProperty("blob");
    expect(historical).toMatchObject({
      representation: "text",
      contentAccess: "inline",
      contentType: "text/plain; charset=utf-8",
      byteSize: oldVersion.size,
      etag: oldVersion.hash,
    });
    expect(versionCounts).toEqual({ get: 1, put: 0 });
  });

  it("answers conditional head and version requests before reading even a corrupt R2 object", async () => {
    const body = spilledBody("\uFEFFCONDITIONAL_MARKER\r\n");
    const [version] = await seedFile("conditional.txt", [{ body }]);
    if (version === undefined || version.key === null) throw new Error("Expected spilled fixture");
    const etag = formatEtag({ version: 1, hash: version.hash, deleted: false });

    const head = rejectingReads();
    const headResponse = await api(
      "/files/conditional.txt",
      { headers: { "If-None-Match": etag } },
      head.bindings,
    );
    expect(headResponse.status).toBe(304);
    expect(headResponse.headers.get("ETag")).toBe(etag);
    expect(headResponse.headers.get("X-Stash-Version")).toBe("1");
    expect(await headResponse.text()).toBe("");
    expect(head.counts).toEqual({ get: 0, put: 0 });

    await createTestEnv().env.BLOBS.put(
      version.key,
      bodyAtSize("CORRUPT_CONDITIONAL_MARKER\r\n", version.size),
    );
    const historical = rejectingReads();
    const versionResponse = await api(
      "/files/conditional.txt?version=1",
      { headers: { "If-None-Match": `W/${etag}` } },
      historical.bindings,
    );
    expect(versionResponse.status).toBe(304);
    expect(versionResponse.headers.get("ETag")).toBe(etag);
    expect(versionResponse.headers.get("X-Stash-Version")).toBe("1");
    expect(await versionResponse.text()).toBe("");
    expect(historical.counts).toEqual({ get: 0, put: 0 });
  });

  it("returns a body-safe internal error when an R2 object is corrupted", async () => {
    const body = spilledBody("ORIGINAL_PRIVATE_MARKER\r\n");
    const [version] = await seedFile("corrupt.txt", [{ body }]);
    if (version === undefined || version.key === null) throw new Error("Expected spilled fixture");
    const corruptBody = bodyAtSize("CORRUPT__PRIVATE_MARKER\r\n", version.size);
    await createTestEnv().env.BLOBS.put(version.key, corruptBody);

    const counts: BlobCallCounts = { get: 0, put: 0 };
    const response = await api(
      "/files/corrupt.txt",
      {},
      wrapBlobs(createTestEnv().env, { count: counts }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("X-Stash-Version")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal" } });
    for (const secret of ["ORIGINAL_PRIVATE_MARKER", "CORRUPT__PRIVATE_MARKER", version.key]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(version.hash);
    expect(counts).toEqual({ get: 1, put: 0 });
  });

  it("rejects a missing joined blob row before conditional evaluation and without R2", async () => {
    const body = spilledBody("MISSING_ROW_MARKER\r\n");
    const [version] = await seedFile("missing-row.txt", [{ body }]);
    if (version === undefined) throw new Error("Missing fixture");
    await createTestEnv()
      .env.DB.prepare("DELETE FROM blobs WHERE stash_name = ? AND hash = ?")
      .bind(STASH, version.hash)
      .run();

    const read = rejectingReads();
    const response = await api(
      "/files/missing-row.txt",
      {
        headers: {
          "If-None-Match": formatEtag({ version: 1, hash: version.hash, deleted: false }),
        },
      },
      read.bindings,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "internal" } });
    expect(read.counts).toEqual({ get: 0, put: 0 });
  });
});

describe("metadata-first spilled diffs", () => {
  it("returns same for equal spilled hashes before size checks or body reads", async () => {
    const body = spilledBody("EQUAL_SPILLED_MARKER\r\n");
    const [from, to] = await seedFile("equal.txt", [
      { body },
      { body, kind: "rollback", rollbackOf: 1 },
    ]);
    if (from === undefined || to === undefined) throw new Error("Missing fixture");
    const read = rejectingReads();

    const response = await api("/diff/equal.txt?from=1&to=2", {}, read.bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "same",
      from: { version: 1, hash: from.hash, deleted: false },
      to: { version: 2, hash: to.hash, deleted: false },
    });
    expect(read.counts).toEqual({ get: 0, put: 0 });
  });

  it("returns bytes for unequal spilled metadata without leaking size or loading bodies", async () => {
    const spilled = spilledBody("OVERSIZED_SPILLED_MARKER\r\n");
    const [from, to] = await seedFile("oversized.txt", [{ body: spilled }, { body: "small\n" }]);
    if (from === undefined || to === undefined) throw new Error("Missing fixture");
    const read = rejectingReads();

    const response = await api("/diff/oversized.txt?from=1&to=2", {}, read.bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "oversized",
      reason: "bytes",
      from: { version: 1, hash: from.hash, deleted: false },
      to: { version: 2, hash: to.hash, deleted: false },
    });
    expect(read.counts).toEqual({ get: 0, put: 0 });
  });

  it("hashes a candidate before deciding same or oversized and never reads the spilled head", async () => {
    const body = spilledBody("CANDIDATE_SPILLED_MARKER\r\n");
    await seedFile("candidate.txt", [{ body }]);

    const sameRead = rejectingReads();
    const same = await candidate("candidate.txt", body, sameRead.bindings);
    expect(same.status).toBe(200);
    await expect(same.json()).resolves.toEqual({ state: "same" });
    expect(sameRead.counts).toEqual({ get: 0, put: 0 });

    const oversizedRead = rejectingReads();
    const oversized = await candidate("candidate.txt", "different\n", oversizedRead.bindings);
    expect(oversized.status).toBe(200);
    await expect(oversized.json()).resolves.toEqual({ state: "oversized", reason: "bytes" });
    expect(oversizedRead.counts).toEqual({ get: 0, put: 0 });
  });

  it("keeps the exact diff byte boundary eligible", async () => {
    const before = "a".repeat(DIFF_MAX_BYTES);
    const after = `${"a".repeat(DIFF_MAX_BYTES - 1)}b`;
    await seedFile("boundary.txt", [{ body: before }, { body: after }]);
    const read = rejectingReads();

    const response = await api(
      "/diff/boundary.txt?from=1&to=2&maxUnifiedBytes=0",
      {},
      read.bindings,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: "ready" });
    expect(read.counts).toEqual({ get: 0, put: 0 });
  });

  it("keeps history listings metadata-only for spilled versions", async () => {
    const body = spilledBody("HISTORY_METADATA_MARKER\r\n");
    const [version] = await seedFile("history.txt", [{ body }]);
    if (version === undefined || version.key === null) throw new Error("Expected spilled fixture");
    const read = rejectingReads();

    const response = await api("/history/history.txt", {}, read.bindings);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(version.key);
    expect(text).not.toContain("HISTORY_METADATA_MARKER");
    expect(read.counts).toEqual({ get: 0, put: 0 });
  });
});
