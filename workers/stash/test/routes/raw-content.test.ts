import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { contentDisposition, parseByteRange } from "../../src/routes/raw-content.js";
import type { Env } from "../../src/env.js";
import { bearer, mintToken, request, resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const STASH = "raw-content";
const BASE = `http://stash.test/v1/stashes/${STASH}`;
const encoder = new TextEncoder();

interface SeedInput {
  bytes: Uint8Array;
  representation: "text" | "binary";
  contentType: string;
  storage: "legacy" | "bytes";
  r2?: boolean;
  kind?: "put" | "delete";
}

async function raw(path: string, init: RequestInit = {}, env?: Env): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-admin");
  return request(app, `${BASE}${path}`, { ...init, headers }, env);
}

async function seedPath(path: string, inputs: readonly SeedInput[]): Promise<string[]> {
  const env = createTestEnv().env;
  const hashes: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const version = index + 1;
    const deleted = input.kind === "delete";
    const hash = deleted ? null : await sha256Hex(input.bytes.slice().buffer as ArrayBuffer);
    hashes.push(hash ?? "");
    if (!deleted && hash !== null) {
      if (input.storage === "legacy") {
        const body = new TextDecoder().decode(input.bytes);
        const key = input.r2 ? `${STASH}/${hash}` : null;
        if (key !== null) await env.BLOBS.put(key, input.bytes);
        await env.DB.prepare(
          `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(stash_name, hash) DO NOTHING`,
        )
          .bind(STASH, hash, key === null ? body : null, key, input.bytes.byteLength, version)
          .run();
      } else {
        const key = input.r2 ? `committed/${STASH}/${hash}/${version}` : null;
        if (key !== null) await env.BLOBS.put(key, input.bytes);
        await env.DB.prepare(
          `INSERT INTO byte_blobs
             (stash_name, hash, body_bytes, r2_key, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(stash_name, hash) DO NOTHING`,
        )
          .bind(
            STASH,
            hash,
            key === null ? input.bytes.buffer : null,
            key,
            input.bytes.byteLength,
            version,
          )
          .run();
      }
    }
    await env.DB.prepare(
      `INSERT INTO versions
         (stash_name, path, version, kind, blob_hash, size_bytes, content_type,
          author, message, meta_json, created_at, representation, application_etag,
          content_storage)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '{}', ?, ?, ?, ?)`,
    )
      .bind(
        STASH,
        path,
        version,
        deleted ? "delete" : "put",
        hash,
        deleted ? 0 : input.bytes.byteLength,
        input.contentType,
        version,
        input.representation,
        hash,
        input.storage,
      )
      .run();
  }
  const headVersion = inputs.length;
  const head = inputs.at(-1);
  if (head === undefined) throw new Error("Missing head fixture");
  await env.DB.prepare(
    `INSERT INTO files
       (stash_name, path, head_version, head_hash, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      STASH,
      path,
      headVersion,
      head.kind === "delete" ? null : hashes.at(-1),
      head.kind === "delete" ? 1 : 0,
      headVersion,
    )
    .run();
  return hashes;
}

beforeEach(async () => {
  await resetDatabase();
  await seedStash(STASH);
});

describe("raw byte delivery", () => {
  it("returns arbitrary D1 binary exactly with download-safe metadata", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 128, 10]);
    const [hash] = await seedPath("arbitrary.bin", [
      {
        bytes,
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
    ]);

    const response = await raw("/raw/arbitrary.bin");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("ETag")).toBe(`"${hash}"`);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
  });

  it("selects legacy and byte tables deterministically for the same SHA", async () => {
    const bytes = encoder.encode("same bytes");
    const [legacyHash] = await seedPath("legacy.txt", [
      {
        bytes,
        representation: "text",
        contentType: "text/plain; charset=utf-8",
        storage: "legacy",
      },
    ]);
    const [byteHash] = await seedPath("byte.bin", [
      {
        bytes,
        representation: "binary",
        contentType: "application/x-byte-fixture",
        storage: "bytes",
      },
    ]);
    expect(byteHash).toBe(legacyHash);
    await expect((await raw("/raw/legacy.txt")).text()).resolves.toBe("same bytes");
    const binary = await raw("/raw/byte.bin");
    expect(binary.headers.get("Content-Type")).toBe("application/x-byte-fixture");
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes);
  });

  it.each([false, true])(
    "marks oversized valid UTF-8 as raw-only and preserves its %s bytes",
    async (r2) => {
      const bytes = encoder.encode("valid UTF-8 日本語");
      await seedPath(r2 ? "raw-r2.txt" : "raw-d1.txt", [
        {
          bytes,
          representation: "text",
          contentType: "text/plain; charset=utf-8",
          storage: r2 ? "legacy" : "bytes",
          r2,
        },
      ]);
      const path = r2 ? "raw-r2.txt" : "raw-d1.txt";
      const env = createTestEnv({ env: { JSON_INLINE_MAX_BYTES: "4" } }).env;
      const json = await raw(`/files/${path}`, {}, env);
      await expect(json.json()).resolves.toMatchObject({
        body: null,
        deleted: false,
        representation: "text",
        contentAccess: "raw",
        byteSize: bytes.byteLength,
      });
      const response = await raw(`/raw/${path}`, {}, env);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  it("diffs raw-only text below the configured diff bound", async () => {
    await seedPath("raw-diff.txt", [
      {
        bytes: encoder.encode("before raw text\n"),
        representation: "text",
        contentType: "text/plain; charset=utf-8",
        storage: "bytes",
      },
      {
        bytes: encoder.encode("after raw text\n"),
        representation: "text",
        contentType: "text/plain; charset=utf-8",
        storage: "bytes",
      },
    ]);
    const env = createTestEnv({ env: { JSON_INLINE_MAX_BYTES: "4" } }).env;
    const response = await raw("/diff/raw-diff.txt?from=1&to=2", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "ready",
      from: { contentAccess: "raw", representation: "text" },
      to: { contentAccess: "raw", representation: "text" },
    });
  });

  it("streams private R2 bytes and requests only a selected range", async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    await seedPath("remote.bin", [
      {
        bytes,
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
        r2: true,
      },
    ]);
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const env = wrapBlobs(createTestEnv().env, { count: counts });
    const response = await raw("/raw/remote.bin", { headers: { Range: "bytes=7-11" } }, env);
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(7, 12));
    expect(response.headers.get("Content-Range")).toBe("bytes 7-11/32");
    expect(counts.get).toBe(1);
  });

  it.each([
    ["bytes=0-0", [0]],
    ["bytes=5-5", [5]],
    ["bytes=1-3", [1, 2, 3]],
    ["bytes=2-", [2, 3, 4, 5]],
    ["bytes=-2", [4, 5]],
    ["bytes=3-99", [3, 4, 5]],
  ] as const)("serves one range %s", async (header, expected) => {
    await seedPath("ranges.bin", [
      {
        bytes: Uint8Array.from([0, 1, 2, 3, 4, 5]),
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
    ]);
    const response = await raw("/raw/ranges.bin", { headers: { Range: header } });
    expect(response.status).toBe(206);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(expected);
  });

  it.each(["bytes=", "items=0-1", "bytes=2-1", "bytes=-0", "bytes=8-", "bytes=0-1,3-4"])(
    "rejects invalid or unsatisfiable range %s",
    async (header) => {
      await seedPath("invalid-range.bin", [
        {
          bytes: Uint8Array.from([1, 2, 3]),
          representation: "binary",
          contentType: "application/octet-stream",
          storage: "bytes",
        },
      ]);
      const response = await raw("/raw/invalid-range.bin", { headers: { Range: header } });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */3");
    },
  );

  it("rejects every range on an empty object", async () => {
    await seedPath("empty.bin", [
      {
        bytes: new Uint8Array(),
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
    ]);
    const response = await raw("/raw/empty.bin", { headers: { Range: "bytes=0-0" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */0");
  });

  it("honors If-None-Match and application-validator If-Range", async () => {
    const bytes = encoder.encode("conditional");
    const [hash] = await seedPath("conditional.txt", [
      {
        bytes,
        representation: "text",
        contentType: "text/plain; charset=utf-8",
        storage: "legacy",
      },
    ]);
    const etag = `"${hash}"`;
    const notModified = await raw("/raw/conditional.txt", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const matched = await raw("/raw/conditional.txt", {
      headers: { Range: "bytes=0-2", "If-Range": etag },
    });
    expect(matched.status).toBe(206);
    await expect(matched.text()).resolves.toBe("con");

    for (const mismatch of [`"other"`, `W/${etag}`, new Date().toUTCString()]) {
      const response = await raw("/raw/conditional.txt", {
        headers: { Range: "bytes=0-2", "If-Range": mismatch },
      });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("conditional");
    }
  });

  it("matches GET headers/status for HEAD and never emits a body", async () => {
    await seedPath("head.bin", [
      {
        bytes: Uint8Array.from([10, 11, 12, 13]),
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
    ]);
    const cases: HeadersInit[] = [{}, { Range: "bytes=1-2" }, { Range: "bytes=99-" }];
    for (const headers of cases) {
      const get = await raw("/raw/head.bin", { headers });
      const head = await raw("/raw/head.bin", { method: "HEAD", headers });
      expect(head.status).toBe(get.status);
      for (const name of ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]) {
        expect(head.headers.get(name), name).toBe(get.headers.get(name));
      }
      expect(await head.text()).toBe("");
    }
  });

  it("serves historical bytes and reports tombstones explicitly", async () => {
    const old = Uint8Array.from([255, 0, 9]);
    await seedPath("history.bin", [
      {
        bytes: old,
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
      {
        bytes: new Uint8Array(),
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
        kind: "delete",
      },
    ]);
    const historical = await raw("/versions/1/raw/history.bin");
    expect(new Uint8Array(await historical.arrayBuffer())).toEqual(old);
    const tombstone = await raw("/versions/2/raw/history.bin");
    expect(tombstone.status).toBe(404);
    await expect(tombstone.json()).resolves.toMatchObject({ error: { code: "file-deleted" } });
    const current = await raw("/raw/history.bin");
    await expect(current.json()).resolves.toMatchObject({ error: { code: "file-deleted" } });
  });

  it("propagates binary and tombstone metadata through every JSON read surface", async () => {
    const bytes = Uint8Array.from([0, 255, 3]);
    const [hash] = await seedPath("mapped.bin", [
      {
        bytes,
        representation: "binary",
        contentType: "application/x-mapped",
        storage: "bytes",
      },
    ]);
    expect(
      (
        await raw("/delete/mapped.bin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1 }),
        })
      ).status,
    ).toBe(200);

    const live = await raw("/files/mapped.bin?version=1");
    await expect(live.json()).resolves.toMatchObject({
      hash,
      body: null,
      deleted: false,
      representation: "binary",
      contentAccess: "raw",
      contentType: "application/x-mapped",
      byteSize: 3,
      etag: hash,
    });
    const tombstone = await raw("/files/mapped.bin?version=2");
    await expect(tombstone.json()).resolves.toMatchObject({
      hash: null,
      body: null,
      deleted: true,
      representation: "binary",
      contentAccess: "deleted",
      byteSize: 0,
      etag: null,
    });
    await expect((await raw("/files?includeDeleted=true")).json()).resolves.toMatchObject({
      files: [
        {
          path: "mapped.bin",
          representation: "binary",
          contentAccess: "deleted",
          etag: null,
        },
      ],
    });
    await expect((await raw("/history/mapped.bin")).json()).resolves.toMatchObject({
      versions: [
        { version: 2, representation: "binary", contentAccess: "deleted", etag: null },
        { version: 1, representation: "binary", contentAccess: "raw", etag: hash },
      ],
    });
    await expect((await raw("/changes?since=0")).json()).resolves.toMatchObject({
      changes: [
        { version: 1, representation: "binary", contentAccess: "raw", etag: hash },
        { version: 2, representation: "binary", contentAccess: "deleted", etag: null },
      ],
    });
    await expect((await raw("/diff/mapped.bin?from=1&to=2")).json()).resolves.toMatchObject({
      state: "binary",
      from: { representation: "binary", contentAccess: "raw", etag: hash },
      to: { representation: "binary", contentAccess: "deleted", etag: null },
    });
  });

  it("rolls a deleted binary back by one immutable pointer without copying bytes", async () => {
    const bytes = Uint8Array.from([222, 173, 0, 190, 239]);
    const [hash] = await seedPath("rollback.bin", [
      {
        bytes,
        representation: "binary",
        contentType: "application/x-rollback",
        storage: "bytes",
      },
    ]);
    expect(
      (
        await raw("/delete/rollback.bin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1 }),
        })
      ).status,
    ).toBe(200);
    const response = await raw("/rollback/rollback.bin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "binary-rollback" },
      body: JSON.stringify({ expectedVersion: 2, toVersion: 1 }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      version: 3,
      hash,
      rollbackOf: 1,
      representation: "binary",
      contentType: "application/x-rollback",
      byteSize: bytes.byteLength,
      etag: hash,
    });
    const counts = await createTestEnv()
      .env.DB.prepare(
        `SELECT
         (SELECT COUNT(*) FROM versions WHERE stash_name = ? AND path = ?) AS versions,
         (SELECT COUNT(*) FROM byte_blobs WHERE stash_name = ? AND hash = ?) AS blobs`,
      )
      .bind(STASH, "rollback.bin", STASH, hash)
      .first<{ versions: number; blobs: number }>();
    expect(counts).toEqual({ versions: 3, blobs: 1 });
    const pointer = await createTestEnv()
      .env.DB.prepare(
        `SELECT representation, content_type, application_etag, content_storage
       FROM versions WHERE stash_name = ? AND path = ? AND version = 3`,
      )
      .bind(STASH, "rollback.bin")
      .first();
    expect(pointer).toEqual({
      representation: "binary",
      content_type: "application/x-rollback",
      application_etag: hash,
      content_storage: "bytes",
    });
    expect(new Uint8Array(await (await raw("/raw/rollback.bin")).arrayBuffer())).toEqual(bytes);
  });

  it("conceals a raw path from a foreign stash token", async () => {
    await seedPath("private.bin", [
      {
        bytes: Uint8Array.from([1]),
        representation: "binary",
        contentType: "application/octet-stream",
        storage: "bytes",
      },
    ]);
    await seedStash("other-raw");
    const foreign = await mintToken("other-raw", "read");
    const response = await request(app, `${BASE}/raw/private.bin`, {
      headers: bearer(foreign.token),
    });
    expect(response.status).toBe(404);
  });
});

describe("raw helpers", () => {
  it("sanitizes separators, quotes, controls, and non-ASCII filenames", () => {
    const value = contentDisposition(`unsafe/日本語 "x"\n..\\report.html`);
    expect(value).toContain('filename="report.html"');
    expect(value).toContain("filename*=UTF-8''report.html");
    expect(value).not.toContain("\n");
    expect(contentDisposition("///")).toContain('filename="download"');
  });

  it("parses closed, open, suffix, and leading-zero ranges", () => {
    expect(parseByteRange("bytes=01-03", 8)).toEqual({ start: 1, end: 3 });
    expect(parseByteRange("bytes=4-", 8)).toEqual({ start: 4, end: 7 });
    expect(parseByteRange("bytes=-99", 8)).toEqual({ start: 0, end: 7 });
  });
});
