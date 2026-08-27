import {
  DeleteFileBody,
  FileGetQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListFilesQuery,
  MAX_BODY_BYTES,
  PutFileBody,
  RollbackBody,
  StashError,
  formatEtag,
  ifNoneMatchMatches,
  isWellFormedString,
  utf8ByteLength,
  validatePath,
  type Current,
  type FileRecord,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";
import type { ReadFileMetadata, ReadFileRecord } from "../d1/reads.js";
import type { StoreWriteResult } from "../d1/writes.js";

const files = new Hono<AppEnv>();

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

type WriteSuccess<T> = Extract<StoreWriteResult<T>, { ok: true }>;
type RoutedWriteSuccess<T> = WriteSuccess<T> & { statusCode: 200 | 201 };

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const contentType = c.req.header("Content-Type");
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new StashError("validation", "The request body must be JSON.");
  }
  try {
    return await c.req.json<unknown>();
  } catch {
    throw new StashError("validation", "The request body must be valid JSON.");
  }
}

async function putBody(c: Context<AppEnv>): Promise<PutFileBody> {
  const candidate = await jsonBody(c);
  const result = PutFileBody.safeParse(candidate);
  if (result.success) return result.data;
  if (typeof candidate === "object" && candidate !== null && "body" in candidate) {
    const body = candidate.body;
    if (typeof body === "string") {
      if (!isWellFormedString(body)) {
        throw new StashError("body-not-well-formed", "Body is not well-formed Unicode.");
      }
      if (utf8ByteLength(body) > MAX_BODY_BYTES) {
        throw new StashError("payload-too-large", "The file body is too large.");
      }
    }
  }
  throw new StashError("validation", "Invalid file write input.");
}

async function deleteBody(c: Context<AppEnv>): Promise<DeleteFileBody> {
  const result = DeleteFileBody.safeParse(await jsonBody(c));
  if (!result.success) throw new StashError("validation", "Invalid delete input.");
  return result.data;
}

async function rollbackBody(c: Context<AppEnv>): Promise<RollbackBody> {
  const result = RollbackBody.safeParse(await jsonBody(c));
  if (!result.success) throw new StashError("validation", "Invalid rollback input.");
  return result.data;
}

function filePath(c: Context<AppEnv>): string {
  // Hono decodes named route parameters once. Do not call decodeURIComponent here.
  const path = c.req.param("path");
  if (path === undefined) throw new StashError("invalid-path", "Invalid file path.");
  const validation = validatePath(path);
  if (!validation.ok) throw new StashError(validation.error, validation.message);
  return path;
}

function idempotencyKey(c: Context<AppEnv>): string | undefined {
  const key = c.req.header("Idempotency-Key");
  if (key !== undefined && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS)) {
    throw new StashError(
      "validation",
      `Idempotency-Key must contain between 1 and ${IDEMPOTENCY_KEY_MAX_CHARS} characters.`,
    );
  }
  return key;
}

function unwrapWrite<T>(result: StoreWriteResult<T>): RoutedWriteSuccess<T> {
  if (!result.ok) {
    throw new StashError(result.error.code, result.error.message, result.current);
  }
  if (result.statusCode !== 200 && result.statusCode !== 201) {
    throw new StashError("internal", "The write store returned an invalid status code.");
  }
  return { ...result, statusCode: result.statusCode };
}

function responseFile(record: ReadFileRecord): FileRecord {
  return {
    path: record.path,
    version: record.version,
    hash: record.hash,
    size: record.size,
    kind: record.kind,
    author: record.author,
    message: record.message,
    meta: record.meta,
    createdAt: record.createdAt,
    deleted: record.deleted,
    body: record.body,
  };
}

function currentFromRecord(record: ReadFileMetadata): Current {
  return {
    version: record.version,
    hash: record.hash,
    deleted: record.deleted,
    kind: record.kind,
    author: record.author,
    createdAt: record.createdAt,
  };
}

function fileEtag(record: ReadFileMetadata): string {
  if (record.deleted) {
    return formatEtag({ version: record.version, hash: null, deleted: true });
  }
  if (record.hash === null) {
    throw new StashError("internal", "A live file is missing its content hash.");
  }
  return formatEtag({ version: record.version, hash: record.hash, deleted: false });
}

files.get(
  "/v1/stashes/:stash/files",
  zValidator("query", ListFilesQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid file list query.");
  }),
  async (c) => {
    const store = createStashStore(c.env);
    const query = c.req.valid("query");
    return c.json(await store.reads.listFiles(c.get("routeStash").name, query));
  },
);

files.get(
  "/v1/stashes/:stash/files/:path{.+}",
  zValidator("query", FileGetQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid file query.");
  }),
  async (c) => {
    const path = filePath(c);
    const query = c.req.valid("query");
    const reads = createStashStore(c.env).reads;
    const source = await reads.getFileSource(c.get("routeStash").name, path, query);
    if (source === null) {
      throw new StashError(
        query.version === undefined ? "not-found" : "version-not-found",
        query.version === undefined ? "File not found." : "Version not found.",
      );
    }
    const record = source.metadata;
    if (record.deleted && query.version === undefined) {
      return c.json(
        {
          error: { code: "file-deleted" as const, message: "The file head is deleted." },
          current: currentFromRecord(record),
        },
        404,
      );
    }

    const etag = fileEtag(record);
    const headers = { ETag: etag, "X-Stash-Version": String(record.version) };
    if (ifNoneMatchMatches(c.req.header("If-None-Match"), etag)) {
      return c.body(null, 304, headers);
    }
    const materialized = await reads.materializeFile(source);
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    return c.json(responseFile(materialized));
  },
);

files.put("/v1/stashes/:stash/files/:path{.+}", async (c) => {
  const path = filePath(c);
  const key = idempotencyKey(c);
  const store = createStashStore(c.env);
  const result = unwrapWrite(
    await store.writes.put(c.get("routeStash").name, path, await putBody(c), {
      idempotencyKey: key,
    }),
  );
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(result.value, result.statusCode);
});

files.post("/v1/stashes/:stash/delete/:path{.+}", async (c) => {
  const path = filePath(c);
  const key = idempotencyKey(c);
  const store = createStashStore(c.env);
  const result = unwrapWrite(
    await store.writes.delete(c.get("routeStash").name, path, await deleteBody(c), {
      idempotencyKey: key,
    }),
  );
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(result.value, result.statusCode);
});

files.post("/v1/stashes/:stash/rollback/:path{.+}", async (c) => {
  const path = filePath(c);
  const key = idempotencyKey(c);
  const store = createStashStore(c.env);
  const result = unwrapWrite(
    await store.writes.rollback(c.get("routeStash").name, path, await rollbackBody(c), {
      idempotencyKey: key,
    }),
  );
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(result.value, result.statusCode);
});

export default files;
