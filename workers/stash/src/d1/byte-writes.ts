import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { parseBinarySettings } from "../binary-config.js";
import type { Env } from "../env.js";
import { blobKey, parseBlobKey, type BlobGenerationFactory } from "./blobs.js";

const SHA256_HASH = /^sha256-([0-9a-f]{64})$/;

export type PreparedByteWrite =
  | { bodyBytes: ArrayBuffer; r2Key: null; storageGeneration: 0 }
  | { bodyBytes: null; r2Key: string; storageGeneration: 0 };

function invalidByteWrite(): Error {
  return new Error("Binary content representation is unavailable or invalid");
}

export function assertPreparedByteWrite(
  prepared: PreparedByteWrite,
  size: number,
): asserts prepared is PreparedByteWrite {
  const inline = prepared.bodyBytes instanceof ArrayBuffer && prepared.r2Key === null;
  const spilled = prepared.bodyBytes === null && typeof prepared.r2Key === "string";
  if (
    (!inline && !spilled) ||
    prepared.storageGeneration !== 0 ||
    (inline && prepared.bodyBytes.byteLength !== size)
  ) {
    throw invalidByteWrite();
  }
}

export async function prepareByteWrite(
  env: Env,
  stash: string,
  hash: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  createGeneration: BlobGenerationFactory = () => crypto.randomUUID(),
): Promise<PreparedByteWrite> {
  const match = SHA256_HASH.exec(hash);
  if (match?.[1] === undefined || (await sha256Hex(bytes)) !== hash) throw invalidByteWrite();

  let prepared: PreparedByteWrite;
  if (bytes.byteLength <= parseBinarySettings(env).d1InlineMaxBytes) {
    prepared = {
      bodyBytes: bytes.slice().buffer as ArrayBuffer,
      r2Key: null,
      storageGeneration: 0,
    };
  } else {
    const key = blobKey(stash, hash, createGeneration());
    if (parseBlobKey(key) === null) throw invalidByteWrite();
    const object = await env.BLOBS.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType },
      customMetadata: { sha256: match[1] },
      sha256: match[1],
    });
    if (object === null) throw invalidByteWrite();
    prepared = { bodyBytes: null, r2Key: key, storageGeneration: 0 };
  }
  assertPreparedByteWrite(prepared, bytes.byteLength);
  return prepared;
}
