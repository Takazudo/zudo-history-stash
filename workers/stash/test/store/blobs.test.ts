import { env } from "cloudflare:workers";
import { R2_SPILL_BYTES, sha256Hex, utf8ByteLength } from "@takazudo/zudo-history-stash-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertBlobRowShape,
  blobKey,
  prepareBlob,
  readBlob,
  type BlobCodecRow,
} from "../../src/d1/blobs.js";
import { resetDatabase, seedStash } from "../helpers/app.js";
import { createTestEnv, wrapBlobs, type BlobCallCounts } from "../helpers/env.js";

const STASH = "blob-codec";
const HASH_PREFIX_LENGTH = "sha256-".length;

function checksumHex(bytes: ArrayBuffer | undefined): string {
  if (bytes === undefined) throw new Error("Expected an R2 SHA-256 checksum");
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectInternal(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "StashError",
    code: "internal",
    status: 500,
  });
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

async function spill(body: string, bindings = createTestEnv().env) {
  const hash = await sha256Hex(body);
  const prepared = await prepareBlob(bindings, STASH, hash, body);
  if (prepared.r2_key === null) throw new Error("Expected body to spill");
  return {
    hash,
    key: prepared.r2_key,
    row: { ...prepared, hash, size_bytes: utf8ByteLength(body) } satisfies BlobCodecRow,
  };
}

beforeEach(resetDatabase);

describe("blob codec writes", () => {
  it("uses the pinned content-addressed key format", () => {
    const hash = `sha256-${"a".repeat(64)}`;
    expect(blobKey("alpha", hash)).toBe(`alpha/${hash}`);
  });

  it("keeps the exact ASCII boundary inline and spills the next byte with R2 metadata", async () => {
    const counts: BlobCallCounts = { get: -1, put: -1 };
    const bindings = wrapBlobs(createTestEnv().env, { count: counts });
    const inlineBody = "x".repeat(R2_SPILL_BYTES);
    const inlineHash = await sha256Hex(inlineBody);

    await expect(prepareBlob(bindings, STASH, inlineHash, inlineBody)).resolves.toEqual({
      body: inlineBody,
      r2_key: null,
    });
    expect(counts).toEqual({ get: 0, put: 0 });
    await expect(env.BLOBS.list()).resolves.toMatchObject({ objects: [] });

    const spilledBody = `${inlineBody}x`;
    const spilledHash = await sha256Hex(spilledBody);
    const key = blobKey(STASH, spilledHash);
    await expect(prepareBlob(bindings, STASH, spilledHash, spilledBody)).resolves.toEqual({
      body: null,
      r2_key: key,
    });
    expect(counts).toEqual({ get: 0, put: 1 });

    const stored = await env.BLOBS.get(key);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("Expected the spilled object");
    expect(stored.size).toBe(R2_SPILL_BYTES + 1);
    expect(stored.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
    expect(stored.customMetadata).toEqual({ sha256: spilledHash.slice(HASH_PREFIX_LENGTH) });
    expect(checksumHex(stored.checksums.sha256)).toBe(spilledHash.slice(HASH_PREFIX_LENGTH));
    await expect(stored.text()).resolves.toBe(spilledBody);
  });

  it("measures the spill boundary in UTF-8 bytes instead of code units", async () => {
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, { count: counts });
    const inlineBody = `${"x".repeat(R2_SPILL_BYTES - 3)}日`;
    const spilledBody = `${inlineBody}x`;
    expect(utf8ByteLength(inlineBody)).toBe(R2_SPILL_BYTES);
    expect(utf8ByteLength(spilledBody)).toBe(R2_SPILL_BYTES + 1);

    await expect(
      prepareBlob(bindings, STASH, await sha256Hex(inlineBody), inlineBody),
    ).resolves.toEqual({ body: inlineBody, r2_key: null });
    await expect(
      prepareBlob(bindings, STASH, await sha256Hex(spilledBody), spilledBody),
    ).resolves.toEqual({ body: null, r2_key: blobKey(STASH, await sha256Hex(spilledBody)) });
    expect(counts).toEqual({ get: 0, put: 1 });
  });

  it("lets native R2 checksum validation reject mismatched content", async () => {
    const body = "a".repeat(R2_SPILL_BYTES + 1);
    const wrongHash = await sha256Hex("b".repeat(R2_SPILL_BYTES + 1));

    await expect(prepareBlob(createTestEnv().env, STASH, wrongHash, body)).rejects.toThrow();
    await expect(env.BLOBS.list()).resolves.toMatchObject({ objects: [] });
  });

  it("converges repeated uploads of the same content-addressed key", async () => {
    const body = "same".repeat(Math.ceil((R2_SPILL_BYTES + 1) / 4));
    const first = await spill(body);
    const second = await spill(body);

    expect(second).toEqual(first);
    const listed = await env.BLOBS.list({ prefix: `${STASH}/` });
    expect(listed.objects.map(({ key }) => key)).toEqual([first.key]);
    await expect(readBlob(createTestEnv().env, first.row)).resolves.toBe(body);
  });

  it("supports ordinal put failure injection without replacing real R2", async () => {
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const attempts: { call: number; key: string }[] = [];
    const bindings = wrapBlobs(createTestEnv().env, {
      count: counts,
      failPut: (call, key) => {
        attempts.push({ call, key });
        return call === 2;
      },
    });
    const firstBody = "a".repeat(R2_SPILL_BYTES + 1);
    const secondBody = "b".repeat(R2_SPILL_BYTES + 1);
    const firstHash = await sha256Hex(firstBody);
    const secondHash = await sha256Hex(secondBody);

    await prepareBlob(bindings, STASH, firstHash, firstBody);
    await expect(prepareBlob(bindings, STASH, secondHash, secondBody)).rejects.toThrow(
      "Injected R2 put failure",
    );
    expect(counts).toEqual({ get: 0, put: 2 });
    expect(attempts).toEqual([
      { call: 1, key: blobKey(STASH, firstHash) },
      { call: 2, key: blobKey(STASH, secondHash) },
    ]);
    const listed = await env.BLOBS.list({ prefix: `${STASH}/` });
    expect(listed.objects).toHaveLength(1);
  });
});

describe("blob codec reads", () => {
  it.each([
    {
      label: "a leading BOM",
      body: () => `\uFEFF${"x".repeat(R2_SPILL_BYTES)}`,
    },
    {
      label: "Japanese text",
      body: () => `${"x".repeat(R2_SPILL_BYTES - 2)}日本語`,
    },
    {
      label: "NUL and control characters",
      body: () => `${"x".repeat(R2_SPILL_BYTES)}\u0000\u0001\t`,
    },
    {
      label: "CRLF newlines",
      body: () => `${"x".repeat(R2_SPILL_BYTES)}\r\n`,
    },
  ])("round-trips $label exactly", async ({ body: createBody }) => {
    const body = createBody();
    const { row } = await spill(body);
    const result = await readBlob(createTestEnv().env, row);

    expect(result).toBe(body);
    if (body.startsWith("\uFEFF")) expect(result.codePointAt(0)).toBe(0xfeff);
  });

  it("accepts empty and legacy oversized inline bodies without consulting R2", async () => {
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, { count: counts, failGet: true });
    const oversized = "legacy".repeat(Math.ceil((R2_SPILL_BYTES + 1) / 6));

    await expect(
      readBlob(bindings, {
        hash: await sha256Hex(""),
        body: "",
        r2_key: null,
        size_bytes: 0,
      }),
    ).resolves.toBe("");
    await expect(
      readBlob(bindings, {
        hash: await sha256Hex(oversized),
        body: oversized,
        r2_key: null,
        size_bytes: utf8ByteLength(oversized),
      }),
    ).resolves.toBe(oversized);
    expect(counts).toEqual({ get: 0, put: 0 });
  });

  it("normalizes a missing object to an internal error", async () => {
    await expectInternal(
      readBlob(createTestEnv().env, {
        hash: `sha256-${"a".repeat(64)}`,
        body: null,
        r2_key: `${STASH}/missing`,
        size_bytes: 1,
      }),
    );
  });

  it("rejects wrong bytes even when their size still matches", async () => {
    const body = "a".repeat(R2_SPILL_BYTES + 1);
    const { key, row } = await spill(body);
    const wrongBody = `${body.slice(0, -1)}b`;
    await env.BLOBS.put(key, wrongBody);

    expect(utf8ByteLength(wrongBody)).toBe(row.size_bytes);
    await expectInternal(readBlob(createTestEnv().env, row));
  });

  it("rejects a row size mismatch before serving stored content", async () => {
    const body = "x".repeat(R2_SPILL_BYTES + 1);
    const { row } = await spill(body);

    await expectInternal(readBlob(createTestEnv().env, { ...row, size_bytes: row.size_bytes + 1 }));
  });

  it("fatally rejects invalid UTF-8 after matching raw size and hash", async () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    const hash = await sha256Hex(bytes);
    const key = blobKey(STASH, hash);
    await env.BLOBS.put(key, bytes, { sha256: hash.slice(HASH_PREFIX_LENGTH) });

    await expectInternal(
      readBlob(createTestEnv().env, {
        hash,
        body: null,
        r2_key: key,
        size_bytes: bytes.byteLength,
      }),
    );
  });

  it("rejects both invalid XOR row shapes before R2 access", async () => {
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, { count: counts, failGet: true });
    const hash = `sha256-${"a".repeat(64)}`;
    const rows: BlobCodecRow[] = [
      { hash, body: "both", r2_key: `${STASH}/${hash}`, size_bytes: 4 },
      { hash, body: null, r2_key: null, size_bytes: 0 },
    ];

    for (const row of rows) {
      expect(captureError(() => assertBlobRowShape(row))).toMatchObject({
        name: "StashError",
        code: "internal",
        status: 500,
      });
      await expectInternal(readBlob(bindings, row));
    }
    expect(counts).toEqual({ get: 0, put: 0 });
  });

  it("normalizes an injected get failure and counts the attempted call", async () => {
    const body = "x".repeat(R2_SPILL_BYTES + 1);
    const { row } = await spill(body);
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const bindings = wrapBlobs(createTestEnv().env, { count: counts, failGet: true });

    await expectInternal(readBlob(bindings, row));
    expect(counts).toEqual({ get: 1, put: 0 });
  });
});

describe("real binding and schema plumbing", () => {
  it("delegates get options and receiver-sensitive head, list, and delete calls", async () => {
    const counts: BlobCallCounts = { get: 0, put: 0 };
    const original = createTestEnv().env;
    const bindings = wrapBlobs(original, { count: counts });
    expect(bindings).not.toBe(original);
    expect(bindings.BLOBS).not.toBe(original.BLOBS);
    const key = "wrapper/value";
    await bindings.BLOBS.put(key, "value", { customMetadata: { source: "wrapper" } });

    await expect(bindings.BLOBS.head(key)).resolves.toMatchObject({ key, size: 5 });
    const ranged = await bindings.BLOBS.get(key, { range: { offset: 1, length: 2 } });
    expect(ranged).not.toBeNull();
    if (ranged === null) throw new Error("Expected ranged object");
    await expect(ranged.text()).resolves.toBe("al");
    const listed = await bindings.BLOBS.list({ prefix: "wrapper/" });
    expect(listed.objects.map((object) => object.key)).toEqual([key]);
    await bindings.BLOBS.delete(key);
    await expect(bindings.BLOBS.head(key)).resolves.toBeNull();
    expect(counts).toEqual({ get: 1, put: 1 });
  });

  it("accepts both inline and R2-key blob rows through the D1 XOR CHECK", async () => {
    await seedStash(STASH);
    const inlineBody = "inline";
    const inlineHash = await sha256Hex(inlineBody);
    const spilledHash = await sha256Hex("spilled");
    const spilledKey = blobKey(STASH, spilledHash);

    await env.DB.prepare(
      `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, 1)`,
    )
      .bind(STASH, inlineHash, inlineBody, utf8ByteLength(inlineBody))
      .run();
    await env.DB.prepare(
      `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
       VALUES (?, ?, NULL, ?, ?, 1)`,
    )
      .bind(STASH, spilledHash, spilledKey, utf8ByteLength("spilled"))
      .run();

    const rows = await env.DB.prepare(
      "SELECT hash, body, r2_key, size_bytes FROM blobs WHERE stash_name = ? ORDER BY hash",
    )
      .bind(STASH)
      .all<BlobCodecRow>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) expect(() => assertBlobRowShape(row)).not.toThrow();
  });

  it("clears application rows and every R2 object in the shared reset helper", async () => {
    await seedStash(STASH);
    await env.BLOBS.put("reset/one", "one");
    await env.BLOBS.put("reset/two", "two");

    await resetDatabase();

    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM stashes").first()).resolves.toEqual({
      count: 0,
    });
    await expect(env.BLOBS.list()).resolves.toMatchObject({ objects: [] });
  });
});
