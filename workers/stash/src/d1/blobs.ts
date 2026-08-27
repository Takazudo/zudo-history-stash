import {
  R2_SPILL_BYTES,
  StashError,
  sha256Hex,
  utf8ByteLength,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import type { BlobRow } from "./schema.js";

const CONTENT_TYPE = "text/plain; charset=utf-8";
const SHA256_HASH = /^sha256-([0-9a-f]{64})$/;

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

export function blobKey(stash: string, hash: string): string {
  return `${stash}/${hash}`;
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
): Promise<PreparedBlob> {
  if (utf8ByteLength(body) <= R2_SPILL_BYTES) return { body, r2_key: null };

  const hex = checksumHex(hash);
  const key = blobKey(stash, hash);
  await env.BLOBS.put(key, body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { sha256: hex },
    sha256: hex,
  });
  return { body: null, r2_key: key };
}

export async function readBlob(env: Env, row: BlobCodecRow): Promise<string> {
  assertBlobRowShape(row);
  if (row.body !== null) return row.body;

  try {
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
