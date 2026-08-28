import {
  StashError,
  type ByteObject,
  type ByteRange,
  type ByteStorageReader,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { parseBlobKey } from "./blobs.js";

interface LegacyByteRow {
  body: string | null;
  r2_key: string | null;
  size_bytes: number;
}

interface ByteRow {
  body_bytes: ArrayBuffer | null;
  r2_key: string | null;
  size_bytes: number;
}

function internalReadError(): never {
  throw new StashError("internal", "Stored file content is unavailable or invalid.");
}

function assertRange(range: ByteRange | undefined, size: number): void {
  if (
    range !== undefined &&
    (!Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= size)
  ) {
    internalReadError();
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function selectedBytes(bytes: Uint8Array, range: ByteRange | undefined): Uint8Array {
  return range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
}

async function readR2(
  env: Env,
  key: string,
  expectedSize: number,
  range: ByteRange | undefined,
): Promise<ReadableStream<Uint8Array>> {
  try {
    const object = await env.BLOBS.get(
      key,
      range === undefined
        ? undefined
        : { range: { offset: range.start, length: range.end - range.start + 1 } },
    );
    if (object === null || object.size !== expectedSize) internalReadError();
    return object.body;
  } catch (error) {
    if (error instanceof StashError) throw error;
    internalReadError();
  }
}

/** Resolves exact bytes from the version-selected legacy or byte table. */
export function createByteStorageReader(env: Env): ByteStorageReader {
  return {
    async get(input): Promise<ByteObject | null> {
      if (!Number.isSafeInteger(input.size) || input.size < 0) internalReadError();
      assertRange(input.range, input.size);
      const db = env.DB.withSession("first-primary");

      if (input.storage === "legacy") {
        const row = await db
          .prepare(
            `SELECT body, r2_key, size_bytes FROM blobs
             WHERE stash_name = ? AND hash = ? LIMIT 1`,
          )
          .bind(input.stash, input.hash)
          .first<LegacyByteRow>();
        if (row === null) return null;
        if (row.size_bytes !== input.size || (row.body === null) === (row.r2_key === null)) {
          internalReadError();
        }

        let stream: ReadableStream<Uint8Array>;
        if (row.body !== null) {
          const bytes = new TextEncoder().encode(row.body);
          if (bytes.byteLength !== input.size) internalReadError();
          stream = byteStream(selectedBytes(bytes, input.range));
        } else {
          const key = row.r2_key;
          if (key === null) internalReadError();
          const parsed = parseBlobKey(key);
          if (parsed === null || parsed.stash !== input.stash || parsed.hash !== input.hash) {
            internalReadError();
          }
          stream = await readR2(env, key, input.size, input.range);
        }
        return {
          stream,
          size: input.size,
          etag: input.etag,
          contentType: input.contentType,
          ...(input.range === undefined ? {} : { range: input.range }),
        };
      }

      const row = await db
        .prepare(
          `SELECT body_bytes, r2_key, size_bytes FROM byte_blobs
           WHERE stash_name = ? AND hash = ? LIMIT 1`,
        )
        .bind(input.stash, input.hash)
        .first<ByteRow>();
      if (row === null) return null;
      if (row.size_bytes !== input.size || (row.body_bytes === null) === (row.r2_key === null)) {
        internalReadError();
      }

      const stream =
        row.body_bytes !== null
          ? (() => {
              const bytes = new Uint8Array(row.body_bytes);
              if (bytes.byteLength !== input.size) internalReadError();
              return byteStream(selectedBytes(bytes, input.range));
            })()
          : await readR2(env, row.r2_key ?? internalReadError(), input.size, input.range);
      return {
        stream,
        size: input.size,
        etag: input.etag,
        contentType: input.contentType,
        ...(input.range === undefined ? {} : { range: input.range }),
      };
    },
  };
}
