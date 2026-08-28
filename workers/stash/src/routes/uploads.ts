import {
  AbortUploadSessionBody,
  CompleteUploadSessionBody,
  CreateUploadSessionBody,
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
import { discardStagedBytes, stageSingleBytes } from "../byte-writes.js";
import type { AppEnv, Principal } from "../context.js";
import { finalizeUnchanged, finalizeUpload } from "../d1/upload-finalize.js";
import { D1UploadSessionStore } from "../d1/upload-sessions.js";
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
  const settings = parseBinarySettings(c.env);
  if (parsed.data.size > settings.maxFileBytes) {
    throw new StashError("payload-too-large", "The declared file size is too large.");
  }
  const mode =
    parsed.data.mode === "auto"
      ? !parsed.data.resumable && parsed.data.size <= settings.singleUploadMaxBytes
        ? "single"
        : "multipart"
      : parsed.data.mode;
  if (mode === "single" && parsed.data.resumable) {
    throw new StashError("validation", "A resumable upload must use multipart mode.");
  }
  if (mode === "single" && parsed.data.size > settings.singleUploadMaxBytes) {
    throw new StashError("payload-too-large", "The declared single upload size is too large.");
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
    return c.json(record(existing), 201);
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
    tier: parsed.data.size <= settings.d1InlineMaxBytes ? "d1" : "r2",
    partSize: mode === "multipart" ? settings.multipartPartBytes : null,
    fingerprint: createFingerprint,
    expiresAt: now + settings.uploadSessionTtlSeconds * 1_000,
    now,
    maxOpenSessions: settings.maxOpenUploadSessions,
    maxReservedBytes: settings.maxReservedUploadBytes,
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
      return c.json(record(raced), 201);
    }
    throw new StashError("payload-too-large", "Upload reservation capacity is exhausted.");
  }
  const row = await store.getByCreateFingerprint(stash, createFingerprint);
  if (row === null) throw new StashError("internal", "Created upload session is unavailable.");
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
  const settings = parseBinarySettings(c.env);
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
  if (row.expires_at <= now && row.state !== "finalizing") {
    await store.expire(row.id, now);
    throw new StashError("upload-session-expired", "Upload session expired.");
  }
  if (
    parsed.data.generation !== row.attempt_generation ||
    row.uploaded_size === null ||
    row.uploaded_hash === null
  ) {
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
  row = requireOwned(await store.get(row.id), c);
  await c.get("deps").uploadHooks.duringFinalizing?.();
  if (!(await verifyR2Staging(c, row))) {
    await store.finish({ lease, state: "failed", errorCode: "staging-unavailable", now });
    throw new StashError("internal", "Durable upload staging is unavailable.");
  }
  const origin = eventOrigin(c.req.raw);
  const unchanged = await finalizeUnchanged(c.env.DB, {
    session: row,
    lease,
    createdAt: now,
    eventOrigin: origin,
  });
  if (unchanged !== null) {
    return new Response(JSON.stringify(unchanged), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  }
  const committed = await finalizeUpload(c.env.DB, {
    session: row,
    lease,
    createdAt: now,
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
    await store.finish({ lease, state: "failed", errorCode: "stash-unavailable", now });
    throw new StashError("not-found", "The requested resource was not found.");
  }
  const casIsStale =
    row.expected_version === null
      ? current.head_version !== null
      : current.head_version !== row.expected_version;
  if (!casIsStale) {
    await store.finish({ lease, state: "failed", errorCode: "staging-unavailable", now });
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
    lease,
    state: "stale",
    resultStatus: 409,
    resultJson: staleJson,
    errorCode: "stale",
    now,
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
  const before = requireOwned(await store.get(sessionId(c)), c);
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
  if (replayed !== null) return replayed;
  const won = await store.abort({
    sessionId: row.id,
    generation: parsed.data.generation,
    fingerprint: abortFingerprint,
    now: c.get("deps").now(),
  });
  if (!won) {
    row = requireOwned(await store.get(row.id), c);
    const raced = replayResponse(row, abortFingerprint);
    if (raced !== null) return raced;
    throw new StashError("upload-session-not-open", "Upload session cannot be aborted.");
  }
  row = requireOwned(await store.get(row.id), c);
  return new Response(row.result_json!, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
});

// The greedy file path route is intentionally registered after every session-id route.
uploads.post("/v1/stashes/:stash/uploads/:path{.+}", createSession);

export default uploads;
