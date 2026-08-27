import {
  R2_SPILL_BYTES,
  StashError,
  sha256Hex,
  utf8ByteLength,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import type { BlobRow } from "./schema.js";

const CONTENT_TYPE = "text/plain; charset=utf-8";
const SHA256_HASH = /^sha256-([0-9a-f]{64})$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BlobGenerationFactory = () => string;

export type ParsedBlobKey =
  | { format: "legacy"; stash: string; hash: string; generation: null }
  | { format: "v2"; stash: string; hash: string; generation: string };

export type PreparedBlob = { body: string; r2_key: null } | { body: null; r2_key: string };

export type BlobCodecRow = Pick<BlobRow, "hash" | "body" | "r2_key" | "size_bytes">;

function internalBlobError(): StashError {
  return new StashError("internal", "Stored blob content is unavailable or invalid.");
}

function checksumHex(hash: string): string {
  const match = SHA256_HASH.exec(hash);
  if (match?.[1] === undefined) throw internalBlobError();
  return match[1];
}

export function legacyBlobKey(stash: string, hash: string): string {
  return `${stash}/${hash}`;
}

export function blobKey(stash: string, hash: string, generation: string): string {
  return `v2/${stash}/${hash}/${generation}`;
}

export function parseBlobKey(key: string): ParsedBlobKey | null {
  const segments = key.split("/");
  const isLegacy = segments.length === 2;
  const isV2 = segments.length === 4 && segments[0] === "v2";
  if (!isLegacy && !isV2) return null;

  const stash = segments[isLegacy ? 0 : 1];
  const hash = segments[isLegacy ? 1 : 2];
  if (
    stash === undefined ||
    hash === undefined ||
    !validateStashName(stash).ok ||
    !SHA256_HASH.test(hash)
  ) {
    return null;
  }
  if (isLegacy) return { format: "legacy", stash, hash, generation: null };

  const generation = segments[3];
  if (generation === undefined || !LOWERCASE_UUID.test(generation)) return null;
  return { format: "v2", stash, hash, generation };
}

export function assertBlobRowShape(row: BlobCodecRow): asserts row is BlobCodecRow & PreparedBlob {
  const isInline = typeof row.body === "string" && row.r2_key === null;
  const isSpilled = row.body === null && typeof row.r2_key === "string";
  if (!isInline && !isSpilled) throw internalBlobError();
}

export async function prepareBlob(
  env: Env,
  stash: string,
  hash: string,
  body: string,
  createGeneration: BlobGenerationFactory = () => crypto.randomUUID(),
): Promise<PreparedBlob> {
  if (utf8ByteLength(body) <= R2_SPILL_BYTES) return { body, r2_key: null };

  const hex = checksumHex(hash);
  const generation = createGeneration();
  const key = blobKey(stash, hash, generation);
  if (parseBlobKey(key) === null) throw internalBlobError();
  const object = await env.BLOBS.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { sha256: hex },
    sha256: hex,
  });
  if (object === null) throw internalBlobError();
  return { body: null, r2_key: key };
}

export async function readBlob(env: Env, row: BlobCodecRow): Promise<string> {
  assertBlobRowShape(row);
  if (row.body !== null) return row.body;

  try {
    const parsedKey = parseBlobKey(row.r2_key);
    if (parsedKey === null || parsedKey.hash !== row.hash) throw internalBlobError();
    const object = await env.BLOBS.get(row.r2_key);
    if (object === null) throw internalBlobError();
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== row.size_bytes) throw internalBlobError();
    if ((await sha256Hex(bytes)) !== row.hash) throw internalBlobError();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw internalBlobError();
  }
}
