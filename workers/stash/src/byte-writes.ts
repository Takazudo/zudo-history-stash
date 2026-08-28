import {
  StashError,
  type Representation,
  type StagedByteObject,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "./env.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,160}$/;

export function stagingObjectKey(sessionId: string, generation: number, objectId: string): string {
  if (
    !SAFE_SEGMENT.test(sessionId) ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !SAFE_SEGMENT.test(objectId)
  ) {
    throw new Error("Invalid staging object identity");
  }
  return `uploads/${sessionId}/${generation}/${objectId}`;
}

export function isStagingObjectKey(key: string): boolean {
  const segments = key.split("/");
  return (
    segments.length === 4 &&
    segments[0] === "uploads" &&
    SAFE_SEGMENT.test(segments[1] ?? "") &&
    /^(0|[1-9]\d*)$/.test(segments[2] ?? "") &&
    SAFE_SEGMENT.test(segments[3] ?? "")
  );
}

export interface StreamResult {
  size: number;
  hash: string;
}

export async function verifyByteStream(input: {
  stream: ReadableStream<Uint8Array>;
  declaredSize: number;
  maximumBytes: number;
  representation: Representation;
}): Promise<StreamResult> {
  const state = {
    size: 0,
    hash: new IncrementalSha256(),
    decoder: validator(input.representation),
  };
  const reader = input.stream.getReader();
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      consumeChunk(read.value, state, input.maximumBytes, input.declaredSize);
    }
  } finally {
    reader.releaseLock();
  }
  if (state.size !== input.declaredSize) {
    throw new StashError("upload-size-mismatch", "Upload size does not match its declaration.");
  }
  return finish(state);
}

function validator(representation: Representation): TextDecoder | null {
  return representation === "text"
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    : null;
}

function consumeChunk(
  chunk: Uint8Array,
  state: { size: number; hash: IncrementalSha256; decoder: TextDecoder | null },
  maximum: number,
  declared: number,
): void {
  state.size += chunk.byteLength;
  if (state.size > maximum)
    throw new StashError("payload-too-large", "The upload body is too large.");
  if (state.size > declared) {
    throw new StashError("upload-size-mismatch", "Upload size does not match its declaration.");
  }
  state.hash.update(chunk);
  if (state.decoder !== null) {
    try {
      state.decoder.decode(chunk, { stream: true });
    } catch {
      throw new StashError("body-not-well-formed", "Text upload bytes are not valid UTF-8.");
    }
  }
}

function finish(state: {
  size: number;
  hash: IncrementalSha256;
  decoder: TextDecoder | null;
}): StreamResult {
  if (state.decoder !== null) {
    try {
      state.decoder.decode();
    } catch {
      throw new StashError("body-not-well-formed", "Text upload bytes are not valid UTF-8.");
    }
  }
  return { size: state.size, hash: state.hash.digest() };
}

export interface StageSingleInput {
  sessionId: string;
  generation: number;
  tier: "d1" | "r2";
  stream: ReadableStream<Uint8Array>;
  declaredSize: number;
  representation: Representation;
  maximumBytes: number;
  createObjectId: () => string;
}

export type StagedSingle = StagedByteObject & { bytes?: ArrayBuffer; objectKey?: string };

export async function stageSingleBytes(env: Env, input: StageSingleInput): Promise<StagedSingle> {
  const state = {
    size: 0,
    hash: new IncrementalSha256(),
    decoder: validator(input.representation),
  };
  if (input.tier === "d1") {
    const chunks: Uint8Array[] = [];
    const reader = input.stream.getReader();
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        consumeChunk(read.value, state, input.maximumBytes, input.declaredSize);
        chunks.push(read.value.slice());
      }
    } finally {
      reader.releaseLock();
    }
    const result = finish(state);
    const bytes = new Uint8Array(result.size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      sessionId: input.sessionId,
      generation: input.generation,
      tier: "d1",
      ...result,
      bytes: bytes.buffer,
    };
  }

  const objectKey = stagingObjectKey(input.sessionId, input.generation, input.createObjectId());
  const fixed = new FixedLengthStream(input.declaredSize);
  const reader = input.stream.getReader();
  const writer = fixed.writable.getWriter();
  const put = env.BLOBS.put(objectKey, fixed.readable, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { session: input.sessionId, generation: String(input.generation) },
  });
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      consumeChunk(read.value, state, input.maximumBytes, input.declaredSize);
      await writer.write(read.value);
    }
    if (state.size !== input.declaredSize) {
      throw new StashError("upload-size-mismatch", "Upload size does not match its declaration.");
    }
    await writer.close();
    const result = finish(state);
    const object = await put;
    if (object === null) throw new Error("Immutable staging object key collision");
    return {
      sessionId: input.sessionId,
      generation: input.generation,
      tier: "r2",
      ...result,
      objectKey,
    };
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await put.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

export async function discardStagedBytes(env: Env, staged: StagedSingle): Promise<void> {
  if (staged.tier === "r2" && staged.objectKey !== undefined)
    await env.BLOBS.delete(staged.objectKey);
}
