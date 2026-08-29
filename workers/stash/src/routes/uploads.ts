import {
  AbortUploadSessionBody,
  CompleteUploadSessionBody,
  CreateUploadSessionBody,
  MAX_MULTIPART_PARTS,
  UploadPartQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  StashError,
  canonicalJson,
  sha256Hex,
  validatePath,
  type UploadCompletionResult,
  type UploadSessionRecord,
} from "@takazudo/zudo-history-stash-core";
import { Hono, type Context } from "hono";
import { parseBinarySettings } from "../binary-config.js";
import {
  discardStagedBytes,
  stageSingleBytes,
  stagingObjectKey,
  verifyByteStream,
} from "../byte-writes.js";
import type { AppEnv, Principal } from "../context.js";
import { finalizeUnchanged, finalizeUpload } from "../d1/upload-finalize.js";
import { mintCommitId } from "../d1/sql/commits.js";
import { D1UploadSessionStore, type FinalizationLease } from "../d1/upload-sessions.js";
import type { UploadSessionRow } from "../d1/schema.js";
import { deliverEvents, eventOrigin } from "../events/publish.js";

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(?:;.*)?$/i;
const uploads = new Hono<AppEnv>();

async function json(c: Context<AppEnv>): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(c.req.header("Content-Type") ?? "")) {
    throw new StashError("validation", "The request body must be JSON.");
  }
  try {
    return await c.req.json<unknown>();
  } catch {
    throw new StashError("validation", "The request body must be valid JSON.");
  }
}

function uploadPath(c: Context<AppEnv>): string {
  const path = c.req.param("path");
  if (path === undefined) throw new StashError("invalid-path", "Invalid file path.");
  const result = validatePath(path);
  if (!result.ok) throw new StashError(result.error, result.message);
  return path;
}

function idempotencyKey(c: Context<AppEnv>): string | undefined {
  const key = c.req.header("Idempotency-Key");
  if (key !== undefined && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS)) {
    throw new StashError("validation", "Invalid Idempotency-Key.");
  }
  return key;
}

function principalColumns(principal: Principal): { kind: "admin" | "stash"; id: string | null } {
  return principal.kind === "admin"
    ? { kind: "admin", id: null }
    : { kind: "stash", id: principal.tokenId };
}

function owns(row: UploadSessionRow, principal: Principal, stash: string): boolean {
  if (row.stash_name !== stash) return false;
  const columns = principalColumns(principal);
  return row.principal_kind === columns.kind && row.principal_id === columns.id;
}

function requireOwned(row: UploadSessionRow | null, c: Context<AppEnv>): UploadSessionRow {
  if (row === null || !owns(row, c.get("principal"), c.get("routeStash").name)) {
    throw new StashError("not-found", "Upload session not found.");
  }
  return row;
}

function result(row: UploadSessionRow): UploadCompletionResult | null {
  if (row.state !== "committed" || row.result_json === null) return null;
  return JSON.parse(row.result_json) as UploadCompletionResult;
}

function record(row: UploadSessionRow): UploadSessionRecord {
  return {
    id: row.id,
    stash: row.stash_name,
    path: row.path,
    principal:
      row.principal_kind === "admin"
        ? { kind: "admin" }
        : { kind: "stash", tokenId: row.principal_id ?? "" },
    state: row.state,
    expectedVersion: row.expected_version,
    declaredSize: row.declared_size,
    declaredHash: row.declared_hash,
    representation: row.representation,
    contentType: row.content_type,
    mode: row.upload_mode,
    storageTier: row.storage_tier,
    partSize: row.part_size,
    expiresAt: new Date(row.expires_at).toISOString(),
    attemptGeneration: row.attempt_generation,
    uploadedSize: row.uploaded_size,
    uploadedHash: row.uploaded_hash,
    finalizationLeaseOwner: row.finalization_lease_owner,
    finalizationLeaseExpiresAt:
      row.finalization_lease_until === null
        ? null
        : new Date(row.finalization_lease_until).toISOString(),
    result: result(row),
  };
}

async function fingerprint(
  c: Context<AppEnv>,
  operation: string,
  sessionId: string,
  body: unknown,
): Promise<string> {
  const key = idempotencyKey(c);
  if (key === undefined) return `adhoc-${c.get("deps").createId()}`;
  return sha256Hex(
    canonicalJson({
      operation,
      sessionId,
      key,
      body: operation === "create" ? null : JSON.stringify(body),
    }),
  );
}

function sessionId(c: Context<AppEnv>): string {
  const value = c.req.param("sessionId");
  if (value === undefined || value.length === 0)
    throw new StashError("not-found", "Upload session not found.");
  return value;
}

function sameCreate(
  row: UploadSessionRow,
  candidate: ReturnType<typeof CreateUploadSessionBody.parse>,
  path: string,
  mode: "single" | "multipart",
): boolean {
  return (
    row.path === path &&
    row.expected_version === candidate.expectedVersion &&
    row.declared_size === candidate.size &&
    row.declared_hash === (candidate.hash ?? null) &&
    row.representation === candidate.representation &&
    row.content_type === candidate.contentType &&
    row.skip_if_unchanged === (candidate.skipIfUnchanged ? 1 : 0) &&
    row.upload_mode === mode
  );
}

function settings(c: Context<AppEnv>) {
  return parseBinarySettings(c.env, c.get("deps").binarySettingOverrides);
}

async function ensureMultipart(
  c: Context<AppEnv>,
  row: UploadSessionRow,
): Promise<UploadSessionRow> {
  if (row.upload_mode !== "multipart") return row;
  if (row.r2_upload_id !== null && row.staged_r2_key !== null) return row;
  if (row.state !== "open") {
    throw new StashError(
      "upload-session-not-open",
      "Upload session cannot initialize multipart state.",
    );
  }
  const objectKey = stagingObjectKey(row.id, row.attempt_generation, c.get("deps").createId());
  const multipart = await c.env.BLOBS.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { session: row.id, generation: String(row.attempt_generation) },
  });
  const store = new D1UploadSessionStore(c.env.DB);
  const bound = await store.bindMultipart({
    sessionId: row.id,
    generation: row.attempt_generation,
    objectKey,
    uploadId: multipart.uploadId,
    now: c.get("deps").now(),
  });
  if (!bound) await multipart.abort().catch(() => undefined);
  const current = requireOwned(await store.get(row.id), c);
  if (current.r2_upload_id === null || current.staged_r2_key === null) {
    throw new StashError("internal", "Multipart upload initialization failed.");
  }
  return current;
}

async function assertCreateCas(
  c: Context<AppEnv>,
  path: string,
  expected: number | null,
): Promise<void> {
  const head = await c.env.DB.withSession("first-primary")
    .prepare("SELECT head_version FROM files WHERE stash_name = ? AND path = ?")
    .bind(c.get("routeStash").name, path)
    .first<{ head_version: number }>();
  if (expected === null && head !== null) throw new StashError("exists", "File already exists.");
  if (expected !== null && head === null) throw new StashError("not-found", "File not found.");
  if (expected !== null && head?.head_version !== expected) {
    throw new StashError("stale", "Expected version is stale.");
  }
}

async function createSession(c: Context<AppEnv>) {
  const parsed = CreateUploadSessionBody.safeParse(await json(c));
  if (!parsed.success) throw new StashError("validation", "Invalid upload session input.");
  const path = uploadPath(c);
  const policy = settings(c);
  if (parsed.data.size > policy.maxFileBytes) {
    throw new StashError("payload-too-large", "The declared file size is too large.");
  }
  const mode =
    parsed.data.mode === "auto"
      ? !parsed.data.resumable && parsed.data.size <= policy.singleUploadMaxBytes
        ? "single"
        : "multipart"
      : parsed.data.mode;
  if (mode === "single" && parsed.data.resumable) {
    throw new StashError("validation", "A resumable upload must use multipart mode.");
  }
  if (mode === "single" && parsed.data.size > policy.singleUploadMaxBytes) {
    throw new StashError("payload-too-large", "The declared single upload size is too large.");
  }
  if (mode === "multipart" && parsed.data.size === 0) {
    throw new StashError("validation", "An empty file must use single upload mode.");
  }
  const stash = c.get("routeStash").name;
  const principal = principalColumns(c.get("principal"));
  const createFingerprint = await fingerprint(c, "create", stash, parsed.data);
  const store = new D1UploadSessionStore(c.env.DB);
  const existing = await store.getByCreateFingerprint(stash, createFingerprint);
  if (existing !== null) {
    if (
      !owns(existing, c.get("principal"), stash) ||
      !sameCreate(existing, parsed.data, path, mode)
    ) {
      throw new StashError("idempotency-key-reused", "Idempotency-Key was reused.");
    }
    c.header("Idempotent-Replayed", "true");
    return c.json(record(await ensureMultipart(c, existing)), 201);
  }
  await assertCreateCas(c, path, parsed.data.expectedVersion);
  const now = c.get("deps").now();
  const created = await store.create({
    id: `upl_${c.get("deps").createId().replaceAll("-", "")}`,
    stash,
    path,
    principalKind: principal.kind,
    principalId: principal.id,
    expectedVersion: parsed.data.expectedVersion,
    declaredSize: parsed.data.size,
    declaredHash: parsed.data.hash ?? null,
    representation: parsed.data.representation,
    contentType: parsed.data.contentType,
    mode,
    tier: mode === "multipart" || parsed.data.size > policy.d1InlineMaxBytes ? "r2" : "d1",
    partSize: mode === "multipart" ? policy.multipartPartBytes : null,
    fingerprint: createFingerprint,
    expiresAt: now + policy.uploadSessionTtlSeconds * 1_000,
    now,
    maxOpenSessions: policy.maxOpenUploadSessions,
    maxReservedBytes: policy.maxReservedUploadBytes,
    skipIfUnchanged: parsed.data.skipIfUnchanged,
  });
  if (!created) {
    const raced = await store.getByCreateFingerprint(stash, createFingerprint);
    if (
      raced !== null &&
      owns(raced, c.get("principal"), stash) &&
      sameCreate(raced, parsed.data, path, mode)
    ) {
      c.header("Idempotent-Replayed", "true");
      return c.json(record(await ensureMultipart(c, raced)), 201);
    }
    throw new StashError("payload-too-large", "Upload reservation capacity is exhausted.");
  }
  let row = await store.getByCreateFingerprint(stash, createFingerprint);
  if (row === null) throw new StashError("internal", "Created upload session is unavailable.");
  row = await ensureMultipart(c, row);
  return c.json(record(row), 201);
}

uploads.get("/v1/stashes/:stash/uploads/:sessionId", async (c) => {
  const store = new D1UploadSessionStore(c.env.DB);
  const row = requireOwned(await store.get(sessionId(c)), c);
  const parts = await store.listParts(row.id, row.attempt_generation);
  return c.json({
    ...record(row),
    parts: parts.map((part) => ({
      partNumber: part.part_number,
      size: part.size_bytes,
      generation: part.generation,
      etag: part.r2_etag,
    })),
  });
});

function contentLength(c: Context<AppEnv>): number | null {
  const value = c.req.header("Content-Length");
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

uploads.put("/v1/stashes/:stash/uploads/:sessionId/content", async (c) => {
  const store = new D1UploadSessionStore(c.env.DB);
  const row = requireOwned(await store.get(sessionId(c)), c);
  const now = c.get("deps").now();
  const uploadFingerprint = await fingerprint(c, "upload", row.id, {
    generation: row.attempt_generation,
  });
  if (row.state === "uploaded" && row.upload_fingerprint === uploadFingerprint) {
    c.header("Idempotent-Replayed", "true");
    return c.json(record(row), 202);
  }
  if (row.expires_at <= now) {
    await store.expire(row.id, now);
    throw new StashError("upload-session-expired", "Upload session expired.");
  }
  if (row.state !== "open" || row.upload_mode !== "single") {
    throw new StashError("upload-session-not-open", "Upload session does not accept content.");
  }
  const settings = parseBinarySettings(c.env, c.get("deps").binarySettingOverrides);
  const declaredLength = contentLength(c);
  if (declaredLength !== null) {
    if (declaredLength > settings.httpRequestMaxBytes || declaredLength > settings.maxFileBytes) {
      await store.failOpen(row.id, row.attempt_generation, "payload-too-large", now);
      throw new StashError("payload-too-large", "The upload body is too large.");
    }
    if (declaredLength !== row.declared_size) {
      await store.failOpen(row.id, row.attempt_generation, "upload-size-mismatch", now);
      throw new StashError("upload-size-mismatch", "Upload size does not match its declaration.");
    }
  }
  const empty = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  let staged;
  let durable = false;
  try {
    staged = await stageSingleBytes(c.env, {
      sessionId: row.id,
      generation: row.attempt_generation,
      tier: row.storage_tier,
      stream: c.req.raw.body ?? empty,
      declaredSize: row.declared_size,
      representation: row.representation,
      maximumBytes: Math.min(
        settings.httpRequestMaxBytes,
        settings.maxFileBytes,
        settings.singleUploadMaxBytes,
      ),
      createObjectId: c.get("deps").createId,
    });
    if (staged.size !== row.declared_size) {
      throw new StashError("upload-size-mismatch", "Upload size does not match its declaration.");
    }
    if (row.declared_hash !== null && staged.hash !== row.declared_hash) {
      throw new StashError("upload-hash-mismatch", "Upload hash does not match its declaration.");
    }
    const recorded =
      staged.tier === "d1"
        ? await store.recordStagedBytes({
            sessionId: row.id,
            generation: row.attempt_generation,
            bytes: staged.bytes!,
            size: staged.size,
            hash: staged.hash,
            fingerprint: uploadFingerprint,
            now,
          })
        : await store.recordStagedObject({
            sessionId: row.id,
            generation: row.attempt_generation,
            objectKey: staged.objectKey!,
            size: staged.size,
            hash: staged.hash,
            fingerprint: uploadFingerprint,
            now,
          });
    if (!recorded) {
      await discardStagedBytes(c.env, staged);
      throw new StashError("upload-session-not-open", "Upload session no longer accepts content.");
    }
    durable = true;
    await c.get("deps").uploadHooks.afterStage?.();
  } catch (error) {
    if (!durable && staged !== undefined)
      await discardStagedBytes(c.env, staged).catch(() => undefined);
    if (error instanceof StashError) {
      await store.failOpen(row.id, row.attempt_generation, error.code, now);
      throw error;
    }
    throw new StashError("internal", "Upload streaming failed.");
  }
  const uploaded = await store.get(row.id);
  if (uploaded === null) throw new StashError("internal", "Uploaded session is unavailable.");
  return c.json(record(uploaded), 202);
});

function partNumber(c: Context<AppEnv>): number {
  const raw = c.req.param("partNumber");
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new StashError("validation", "Invalid multipart part number.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_MULTIPART_PARTS) {
    throw new StashError("validation", "Invalid multipart part number.");
  }
  return value;
}

async function uploadMultipartBody(input: {
  upload: R2MultipartUpload;
  partNumber: number;
  body: ReadableStream<Uint8Array>;
  expectedSize: number;
  maximumBytes: number;
}): Promise<R2UploadedPart> {
  const fixed = new FixedLengthStream(input.expectedSize);
  const reader = input.body.getReader();
  const writer = fixed.writable.getWriter();
  const uploaded = input.upload.uploadPart(input.partNumber, fixed.readable);
  let size = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      size += read.value.byteLength;
      if (size > input.maximumBytes) {
        throw new StashError("payload-too-large", "The upload part is too large.");
      }
      if (size > input.expectedSize) {
        throw new StashError("upload-size-mismatch", "Upload part size is incorrect.");
      }
      await writer.write(read.value);
    }
    if (size !== input.expectedSize) {
      throw new StashError("upload-size-mismatch", "Upload part size is incorrect.");
    }
    await writer.close();
    return await uploaded;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await uploaded.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

uploads.put("/v1/stashes/:stash/uploads/:sessionId/parts/:partNumber", async (c) => {
  const parsedQuery = UploadPartQuery.safeParse(c.req.query());
  if (!parsedQuery.success) throw new StashError("validation", "Invalid multipart generation.");
  const store = new D1UploadSessionStore(c.env.DB);
  let row = requireOwned(await store.get(sessionId(c)), c);
  if (row.expires_at <= c.get("deps").now()) {
    if (await store.expire(row.id, c.get("deps").now())) {
      row = requireOwned(await store.get(row.id), c);
      await cleanupMultipart(c, row);
    }
    throw new StashError("upload-session-expired", "Upload session expired.");
  }
  if (
    row.state !== "open" ||
    row.upload_mode !== "multipart" ||
    parsedQuery.data.generation !== row.attempt_generation
  ) {
    throw new StashError("upload-session-not-open", "Upload session does not accept parts.");
  }
  row = await ensureMultipart(c, row);
  const number = partNumber(c);
  const partSize = row.part_size!;
  const expectedParts = Math.ceil(row.declared_size / partSize);
  if (number > expectedParts || expectedParts > MAX_MULTIPART_PARTS) {
    throw new StashError("validation", "Multipart part number is outside the declared file.");
  }
  const expectedSize =
    number === expectedParts ? row.declared_size - partSize * (expectedParts - 1) : partSize;
  const policy = settings(c);
  const length = contentLength(c);
  if (length !== null && length !== expectedSize) {
    throw new StashError("upload-size-mismatch", "Upload part size is incorrect.");
  }
  if (expectedSize > policy.httpRequestMaxBytes || expectedSize > policy.multipartPartBytes) {
    throw new StashError("payload-too-large", "The upload part is too large.");
  }
  const owner = c.get("deps").createId();
  const claimed = await store.claimPart({
    sessionId: row.id,
    generation: row.attempt_generation,
    partNumber: number,
    owner,
    now: c.get("deps").now(),
    staleBefore: c.get("deps").now() - c.get("deps").uploadLeaseMs,
  });
  if (!claimed) {
    throw new StashError("upload-session-not-open", "The multipart part is already being written.");
  }
  try {
    const body = c.req.raw.body;
    if (body === null)
      throw new StashError("upload-size-mismatch", "Upload part size is incorrect.");
    const upload = c.env.BLOBS.resumeMultipartUpload(row.staged_r2_key!, row.r2_upload_id!);
    const part = await uploadMultipartBody({
      upload,
      partNumber: number,
      body,
      expectedSize,
      maximumBytes: Math.min(policy.httpRequestMaxBytes, policy.multipartPartBytes),
    });
    await c.get("deps").uploadHooks.afterMultipartPart?.();
    const recorded = await store.recordClaimedPart({
      sessionId: row.id,
      generation: row.attempt_generation,
      partNumber: number,
      owner,
      size: expectedSize,
      etag: part.etag,
      now: c.get("deps").now(),
    });
    if (!recorded) {
      throw new StashError("upload-session-not-open", "Upload session no longer accepts parts.");
    }
  } catch (error) {
    await store.releasePartClaim({
      sessionId: row.id,
      generation: row.attempt_generation,
      partNumber: number,
      owner,
    });
    if (error instanceof StashError) throw error;
    throw new StashError("internal", "Multipart part upload failed.");
  }
  row = requireOwned(await store.get(row.id), c);
  const parts = await store.listParts(row.id, row.attempt_generation);
  return c.json(
    {
      ...record(row),
      parts: parts.map((part) => ({
        partNumber: part.part_number,
        size: part.size_bytes,
        generation: part.generation,
        etag: part.r2_etag,
      })),
    },
    202,
  );
});

function replayResponse(row: UploadSessionRow, fingerprintValue: string): Response | null {
  if (row.result_status === null || row.result_json === null) return null;
  if (row.complete_fingerprint !== fingerprintValue) {
    throw new StashError("idempotency-key-reused", "Idempotency-Key was reused.");
  }
  return new Response(row.result_json, {
    status: row.result_status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Idempotent-Replayed": "true" },
  });
}

async function cleanupMultipart(c: Context<AppEnv>, row: UploadSessionRow): Promise<void> {
  if (
    row.upload_mode !== "multipart" ||
    row.staged_r2_key === null ||
    row.r2_upload_id === null ||
    row.state === "committed"
  ) {
    return;
  }
  const objectKey = row.staged_r2_key;
  const uploadId = row.r2_upload_id;
  const tracked = await c.env.DB.prepare(
    `SELECT 1 AS tracked FROM upload_objects WHERE session_id = ? AND generation = ?
       AND purpose IN ('multipart','staging')`,
  )
    .bind(row.id, row.attempt_generation)
    .first<{ tracked: 1 }>();
  if (tracked === null) return;
  const head = await c.env.BLOBS.head(objectKey);
  if (head !== null) {
    await c.env.BLOBS.delete(objectKey);
  } else {
    await c.env.BLOBS.resumeMultipartUpload(objectKey, uploadId).abort();
  }
  await c.env.DB.prepare(
    `DELETE FROM upload_objects WHERE session_id = ? AND generation = ?
       AND purpose IN ('multipart','staging')
       AND NOT EXISTS (SELECT 1 FROM upload_sessions
         WHERE id = ? AND state IN ('open','uploaded','finalizing','committed'))`,
  )
    .bind(row.id, row.attempt_generation, row.id)
    .run();
}

async function publishCommitted(c: Context<AppEnv>, row: UploadSessionRow): Promise<void> {
  if (row.state !== "committed" || row.result_status !== 201 || row.result_json === null) return;
  const committed = JSON.parse(row.result_json) as UploadCompletionResult;
  if ("unchanged" in committed) return;
  await c.get("deps").uploadHooks.beforeEventPublish?.();
  const now = c.get("deps").now();
  const owner = c.get("deps").createId();
  const claimed = await c.env.DB.prepare(
    `UPDATE upload_sessions SET event_publish_owner = ?, event_publish_until = ?
     WHERE id = ? AND state = 'committed' AND event_published_at IS NULL
       AND (event_publish_owner IS NULL OR event_publish_until <= ?)`,
  )
    .bind(owner, now + c.get("deps").uploadLeaseMs, row.id, now)
    .run();
  if (claimed.meta.changes !== 1) return;
  try {
    await deliverEvents(c.env, row.stash_name, [
      {
        type: "change",
        changeId: committed.changeId,
        commitId: committed.commitId,
        stash: row.stash_name,
        path: row.path,
        version: committed.version,
        kind: "put",
        origin: row.event_origin,
        createdAt: committed.createdAt,
      },
    ]);
    const published = await c.env.DB.prepare(
      `UPDATE upload_sessions SET event_published_at = ?, event_publish_owner = NULL,
         event_publish_until = NULL, updated_at = ?
       WHERE id = ? AND state = 'committed' AND event_published_at IS NULL
         AND event_publish_owner = ?`,
    )
      .bind(c.get("deps").now(), c.get("deps").now(), row.id, owner)
      .run();
    if (published.meta.changes !== 1) throw new Error("Upload event publication lease was lost");
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE upload_sessions SET event_publish_owner = NULL, event_publish_until = NULL
       WHERE id = ? AND event_published_at IS NULL AND event_publish_owner = ?`,
    )
      .bind(row.id, owner)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

async function verifyR2Staging(c: Context<AppEnv>, row: UploadSessionRow): Promise<boolean> {
  if (row.storage_tier !== "r2") return true;
  if (row.staged_r2_key === null || row.uploaded_size === null) return false;
  const object = await c.env.BLOBS.head(row.staged_r2_key);
  return (
    object !== null &&
    object.size === row.uploaded_size &&
    object.customMetadata?.session === row.id &&
    object.customMetadata.generation === String(row.attempt_generation)
  );
}

function finalizationLeaseLost(): StashError {
  return new StashError("upload-session-not-open", "Upload finalization lease was lost.");
}

async function withFinalizationLeaseHeartbeat<T>(
  c: Context<AppEnv>,
  store: D1UploadSessionStore,
  state: { current: FinalizationLease },
  operation: () => Promise<T>,
): Promise<T> {
  const dependencies = c.get("deps");
  const intervalMs = Math.max(1, Math.floor(dependencies.uploadLeaseMs / 3));
  let stopped = false;
  let wake: (() => void) | null = null;
  let heartbeatError: unknown;

  const waitForInterval = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, intervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  const stopWaiting = () => {
    if (wake !== null) wake();
  };

  const heartbeat = (async () => {
    while (!stopped) {
      await waitForInterval();
      if (stopped) break;
      try {
        const heartbeatAt = dependencies.now();
        const renewed = await store.renewFinalizationLease(
          state.current,
          heartbeatAt,
          heartbeatAt + dependencies.uploadLeaseMs,
        );
        if (renewed === null) throw finalizationLeaseLost();
        state.current = renewed;
      } catch (error) {
        heartbeatError = error;
        stopped = true;
      }
    }
  })();

  let operationFailed = false;
  let operationError: unknown;
  let value!: T;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    stopped = true;
    stopWaiting();
    await heartbeat;
  }

  if (heartbeatError !== undefined) throw heartbeatError;
  const renewalAt = dependencies.now();
  const renewed = await store.renewFinalizationLease(
    state.current,
    renewalAt,
    renewalAt + dependencies.uploadLeaseMs,
  );
  if (renewed === null) throw finalizationLeaseLost();
  state.current = renewed;
  if (operationFailed) throw operationError;
  return value;
}

async function complete(c: Context<AppEnv>): Promise<Response> {
  const parsed = CompleteUploadSessionBody.safeParse(await json(c));
  if (!parsed.success) throw new StashError("validation", "Invalid upload completion input.");
  const store = new D1UploadSessionStore(c.env.DB);
  let row = requireOwned(await store.get(sessionId(c)), c);
  const completeFingerprint = await fingerprint(c, "complete", row.id, parsed.data);
  const replayed = replayResponse(row, completeFingerprint);
  if (replayed !== null) {
    await publishCommitted(c, row);
    return replayed;
  }
  const now = c.get("deps").now();
  let finalizationNow = now;
  if (row.expires_at <= now && row.state !== "finalizing") {
    if (await store.expire(row.id, now)) {
      row = requireOwned(await store.get(row.id), c);
      await cleanupMultipart(c, row);
    }
    throw new StashError("upload-session-expired", "Upload session expired.");
  }
  if (parsed.data.generation !== row.attempt_generation) {
    throw new StashError("upload-session-not-open", "Upload session is not ready to complete.");
  }
  let multipartParts: { partNumber: number; etag: string }[] | null = null;
  if (row.upload_mode === "multipart") {
    const durable = await store.listParts(row.id, row.attempt_generation);
    const partSize = row.part_size!;
    const expectedCount = Math.ceil(row.declared_size / partSize);
    const valid =
      expectedCount > 0 &&
      expectedCount <= MAX_MULTIPART_PARTS &&
      durable.length === expectedCount &&
      durable.every((part, index) => {
        const number = index + 1;
        const expectedSize =
          number === expectedCount ? row.declared_size - partSize * (expectedCount - 1) : partSize;
        return (
          part.part_number === number &&
          part.generation === row.attempt_generation &&
          part.size_bytes === expectedSize &&
          part.r2_etag.length > 0
        );
      });
    if (!valid) {
      throw new StashError("upload-size-mismatch", "Multipart upload is incomplete.");
    }
    multipartParts = durable.map((part) => ({
      partNumber: part.part_number,
      etag: part.r2_etag,
    }));
    if (row.state === "open") {
      if (!(await store.sealMultipart(row.id, row.attempt_generation, now))) {
        throw new StashError("upload-session-not-open", "Multipart upload has active part writes.");
      }
      row = requireOwned(await store.get(row.id), c);
    }
  } else if (row.uploaded_size === null || row.uploaded_hash === null) {
    throw new StashError("upload-session-not-open", "Upload session is not ready to complete.");
  }
  const owner = c.get("deps").createId();
  const lease = await store.acquireFinalizationLease({
    sessionId: row.id,
    generation: parsed.data.generation,
    owner,
    fingerprint: completeFingerprint,
    now,
    leaseUntil: now + c.get("deps").uploadLeaseMs,
  });
  if (lease === null) {
    row = requireOwned(await store.get(row.id), c);
    const raced = replayResponse(row, completeFingerprint);
    if (raced !== null) {
      await publishCommitted(c, row);
      return raced;
    }
    throw new StashError("upload-session-not-open", "Upload finalization is already in progress.");
  }
  const leaseState = { current: lease };
  row = requireOwned(await store.get(row.id), c);
  await c.get("deps").uploadHooks.duringFinalizing?.();
  if (row.upload_mode === "multipart") {
    row = requireOwned(await store.get(row.id), c);
    const key = row.staged_r2_key;
    if (key === null || row.r2_upload_id === null || multipartParts === null) {
      await store.finish({
        lease: leaseState.current,
        state: "failed",
        errorCode: "staging-unavailable",
        now,
      });
      throw new StashError("internal", "Multipart staging is unavailable.");
    }
    const completed = await withFinalizationLeaseHeartbeat(c, store, leaseState, async () => {
      let object = await c.env.BLOBS.head(key);
      if (object === null) {
        try {
          object = await c.env.BLOBS.resumeMultipartUpload(key, row.r2_upload_id!).complete(
            multipartParts,
          );
        } catch {
          object = await c.env.BLOBS.head(key);
        }
        if (object !== null) await c.get("deps").uploadHooks.afterMultipartComplete?.();
      }
      return object;
    });
    if (completed === null) {
      await store.finish({
        lease: leaseState.current,
        state: "failed",
        errorCode: "multipart-complete-failed",
        now: c.get("deps").now(),
      });
      throw new StashError("internal", "Multipart completion failed.");
    }
    if (
      completed.size !== row.declared_size ||
      completed.customMetadata?.session !== row.id ||
      completed.customMetadata.generation !== String(row.attempt_generation)
    ) {
      await store.finish({
        lease: leaseState.current,
        state: "failed",
        errorCode: "staging-unavailable",
        now: c.get("deps").now(),
      });
      throw new StashError("internal", "Completed multipart staging is invalid.");
    }
    if (row.r2_completed_at === null) {
      if (
        !(await store.markMultipartCompleted({
          lease: leaseState.current,
          now: c.get("deps").now(),
        }))
      ) {
        throw finalizationLeaseLost();
      }
    }
    let verified: Awaited<ReturnType<typeof verifyByteStream>> | null;
    try {
      verified = await withFinalizationLeaseHeartbeat(c, store, leaseState, async () => {
        const object = await c.env.BLOBS.get(key);
        return object === null
          ? null
          : verifyByteStream({
              stream: object.body,
              declaredSize: row.declared_size,
              maximumBytes: settings(c).maxFileBytes,
              representation: row.representation,
            });
      });
    } catch (error) {
      if (error instanceof StashError && error.code !== "upload-session-not-open") {
        await store.finish({
          lease: leaseState.current,
          state: "failed",
          errorCode: error.code,
          now: c.get("deps").now(),
        });
      }
      throw error;
    }
    if (verified === null) {
      await store.finish({
        lease: leaseState.current,
        state: "failed",
        errorCode: "staging-unavailable",
        now: c.get("deps").now(),
      });
      throw new StashError("internal", "Completed multipart staging is unavailable.");
    }
    if (row.declared_hash !== null && verified.hash !== row.declared_hash) {
      await store.finish({
        lease: leaseState.current,
        state: "failed",
        errorCode: "upload-hash-mismatch",
        now: c.get("deps").now(),
      });
      throw new StashError("upload-hash-mismatch", "Upload hash does not match its declaration.");
    }
    if (
      !(await store.markMultipartVerified({
        lease: leaseState.current,
        size: verified.size,
        hash: verified.hash,
        now: c.get("deps").now(),
      }))
    ) {
      throw finalizationLeaseLost();
    }
    row = requireOwned(await store.get(row.id), c);
  }
  const stagingAvailable =
    row.storage_tier === "r2"
      ? await withFinalizationLeaseHeartbeat(c, store, leaseState, () => verifyR2Staging(c, row))
      : true;
  finalizationNow = c.get("deps").now();
  const commitLease = await store.renewFinalizationLease(
    leaseState.current,
    finalizationNow,
    finalizationNow + c.get("deps").uploadLeaseMs,
  );
  if (commitLease === null) throw finalizationLeaseLost();
  leaseState.current = commitLease;
  if (!stagingAvailable) {
    await store.finish({
      lease: leaseState.current,
      state: "failed",
      errorCode: "staging-unavailable",
      now: finalizationNow,
    });
    throw new StashError("internal", "Durable upload staging is unavailable.");
  }
  const origin = eventOrigin(c.req.raw);
  const unchanged = await finalizeUnchanged(c.env.DB, {
    session: row,
    lease: leaseState.current,
    createdAt: finalizationNow,
    eventOrigin: origin,
  });
  if (unchanged !== null) {
    return new Response(JSON.stringify(unchanged), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  }
  const committed = await finalizeUpload(c.env.DB, {
    commitId: mintCommitId(finalizationNow, c.get("deps").createId),
    createdBy: row.principal_kind === "admin" ? "admin" : (row.principal_id ?? "unknown-principal"),
    session: row,
    lease: leaseState.current,
    createdAt: finalizationNow,
    eventOrigin: origin,
  });
  if (committed !== null) {
    await c.get("deps").uploadHooks.afterCommit?.();
    const committedRow = requireOwned(await store.get(row.id), c);
    await publishCommitted(c, committedRow);
    return new Response(JSON.stringify(committed), {
      status: 201,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  }
  const current = await c.env.DB.withSession("first-primary")
    .prepare(
      `SELECT files.head_version, files.head_hash, files.deleted, versions.kind,
         versions.author, versions.created_at, stashes.deleted_at
       FROM stashes LEFT JOIN files ON files.stash_name = stashes.name AND files.path = ?
       LEFT JOIN versions ON versions.stash_name = files.stash_name
         AND versions.path = files.path AND versions.version = files.head_version
       WHERE stashes.name = ?`,
    )
    .bind(row.path, row.stash_name)
    .first<{
      head_version: number | null;
      head_hash: string | null;
      deleted: 0 | 1 | null;
      kind: "put" | "delete" | "rollback" | null;
      author: string | null;
      created_at: number | null;
      deleted_at: number | null;
    }>();
  if (current === null || current.deleted_at !== null) {
    await store.finish({
      lease: leaseState.current,
      state: "failed",
      errorCode: "stash-unavailable",
      now: finalizationNow,
    });
    throw new StashError("not-found", "The requested resource was not found.");
  }
  const casIsStale =
    row.expected_version === null
      ? current.head_version !== null
      : current.head_version !== row.expected_version;
  if (!casIsStale) {
    await store.finish({
      lease: leaseState.current,
      state: "failed",
      errorCode: "staging-unavailable",
      now: finalizationNow,
    });
    throw new StashError("internal", "Upload finalization could not reference durable staging.");
  }
  const staleJson = JSON.stringify({
    error: { code: "stale", message: "Expected version is stale." },
    ...(current.head_version !== null &&
    current.deleted !== null &&
    current.kind !== null &&
    current.author !== null &&
    current.created_at !== null
      ? {
          current: {
            version: current.head_version,
            hash: current.head_hash,
            deleted: current.deleted === 1,
            kind: current.kind,
            author: current.author,
            createdAt: new Date(current.created_at).toISOString(),
          },
        }
      : {}),
  });
  const stale = await store.finish({
    lease: leaseState.current,
    state: "stale",
    resultStatus: 409,
    resultJson: staleJson,
    errorCode: "stale",
    now: finalizationNow,
  });
  if (!stale)
    throw new StashError("upload-session-not-open", "Upload finalization lease was lost.");
  return new Response(staleJson, {
    status: 409,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

uploads.post("/v1/stashes/:stash/uploads/:sessionId/complete", complete);
uploads.post("/v1/stashes/:stash/uploads/:sessionId/resume", async (c) => {
  const store = new D1UploadSessionStore(c.env.DB);
  let before = requireOwned(await store.get(sessionId(c)), c);
  if (before.state === "open") {
    idempotencyKey(c);
    if (!JSON_CONTENT_TYPE.test(c.req.header("Content-Type") ?? "")) {
      throw new StashError("validation", "The request body must be JSON.");
    }
    let candidate: unknown;
    try {
      candidate = await c.req.json<unknown>();
    } catch {
      throw new StashError("validation", "The request body must be valid JSON.");
    }
    const parsed = CompleteUploadSessionBody.safeParse(candidate);
    if (!parsed.success || parsed.data.generation !== before.attempt_generation) {
      throw new StashError("validation", "Invalid upload resume input.");
    }
    before = await ensureMultipart(c, before);
    return c.json(record(before), 200);
  }
  const completion = await complete(c);
  if (completion.status !== 200 && completion.status !== 201) return completion;
  const after = requireOwned(await store.get(before.id), c);
  const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
  if (completion.headers.get("Idempotent-Replayed") === "true") {
    headers.set("Idempotent-Replayed", "true");
  }
  return new Response(JSON.stringify(record(after)), { status: 200, headers });
});

uploads.delete("/v1/stashes/:stash/uploads/:sessionId", async (c) => {
  const parsed = AbortUploadSessionBody.safeParse(await json(c));
  if (!parsed.success) throw new StashError("validation", "Invalid upload abort input.");
  const store = new D1UploadSessionStore(c.env.DB);
  let row = requireOwned(await store.get(sessionId(c)), c);
  const abortFingerprint = await fingerprint(c, "abort", row.id, parsed.data);
  const replayed = replayResponse(row, abortFingerprint);
  if (replayed !== null) {
    await cleanupMultipart(c, row);
    return replayed;
  }
  const abortNow = c.get("deps").now();
  await store.releaseStalePartClaims(
    row.id,
    parsed.data.generation,
    abortNow - c.get("deps").uploadLeaseMs,
  );
  const won = await store.abort({
    sessionId: row.id,
    generation: parsed.data.generation,
    fingerprint: abortFingerprint,
    now: abortNow,
  });
  if (!won) {
    row = requireOwned(await store.get(row.id), c);
    const raced = replayResponse(row, abortFingerprint);
    if (raced !== null) return raced;
    throw new StashError("upload-session-not-open", "Upload session cannot be aborted.");
  }
  row = requireOwned(await store.get(row.id), c);
  await cleanupMultipart(c, row);
  return new Response(row.result_json!, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
});

// The greedy file path route is intentionally registered after every session-id route.
uploads.post("/v1/stashes/:stash/uploads/:path{.+}", createSession);

export default uploads;
