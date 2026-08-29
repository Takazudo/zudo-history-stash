import {
  IDEMPOTENCY_TTL_DAYS,
  type GcRunResult,
  type ParsedRunGcBody,
} from "@takazudo/zudo-history-stash-core";
import { isStagingObjectKey } from "./byte-writes.js";
import { parseBlobKey } from "./d1/blobs.js";
import {
  GcBudgetExhaustedError,
  GcLeaseLostError,
  StorageOperationBudget,
  createGcStore,
  type GcRunHandle,
} from "./d1/gc-store.js";
import type { GcJobKind } from "./d1/schema.js";
import type { Env } from "./env.js";

export { GcBudgetExhaustedError } from "./d1/gc-store.js";

export const GC_STORAGE_OPERATION_LIMIT = 45;
export const GC_R2_LIST_LIMIT = 24;
export const GC_ORPHAN_MIN_AGE_MS = 900_000;
const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1_000;

type R2Cursor = { v: 1; kind: "r2-orphans"; value: string };
type LedgerCursor = { v: 1; kind: "ledger"; createdAt: number; rowid: number };
type GcCursor = R2Cursor | LedgerCursor;

export class GcCursorValidationError extends Error {
  constructor() {
    super("Invalid garbage collection cursor");
    this.name = "GcCursorValidationError";
  }
}

function invalidCursor(): never {
  throw new GcCursorValidationError();
}

function encodeJson(value: GcCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeJson(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  try {
    const binary = atob(padded);
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (canonical !== value) invalidCursor();
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return decoded;
  } catch {
    return invalidCursor();
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function encodeR2Cursor(value: string): string {
  if (value.length === 0) invalidCursor();
  return encodeJson({ v: 1, kind: "r2-orphans", value });
}

export function encodeLedgerCursor(createdAt: number, rowid: number): string {
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(rowid) ||
    rowid < 1
  ) {
    invalidCursor();
  }
  return encodeJson({ v: 1, kind: "ledger", createdAt, rowid });
}

export function decodeGcCursor(kind: GcJobKind, cursor: string): GcCursor {
  const decoded = decodeJson(cursor);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) invalidCursor();
  const value = decoded as Record<string, unknown>;
  if (value.v !== 1 || value.kind !== kind) invalidCursor();
  if (kind === "r2-orphans") {
    if (
      !exactKeys(value, ["v", "kind", "value"]) ||
      typeof value.value !== "string" ||
      value.value.length === 0
    ) {
      invalidCursor();
    }
    return { v: 1, kind, value: value.value };
  }
  if (
    !exactKeys(value, ["v", "kind", "createdAt", "rowid"]) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.rowid) ||
    (value.rowid as number) < 1
  ) {
    invalidCursor();
  }
  return {
    v: 1,
    kind,
    createdAt: value.createdAt as number,
    rowid: value.rowid as number,
  };
}

export interface GcHooks {
  afterList?: () => void | Promise<void>;
  afterReferences?: () => void | Promise<void>;
  beforeHead?: (index: number) => void | Promise<void>;
  beforeDelete?: () => void | Promise<void>;
}

export interface GcDependencies {
  now: () => number;
  createId: () => string;
  createOwner: () => string;
  budget: StorageOperationBudget;
  hooks: GcHooks;
}

export interface GcEngine {
  run(input: ParsedRunGcBody): Promise<GcRunResult>;
  budget: StorageOperationBudget;
}

function configuredExactInteger(name: string, value: string, expected: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== expected) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
  return parsed;
}

export function createGcEngine(env: Env, overrides: Partial<GcDependencies> = {}): GcEngine {
  const dependencies: GcDependencies = {
    now: Date.now,
    createId: () => crypto.randomUUID(),
    createOwner: () => crypto.randomUUID(),
    budget: new StorageOperationBudget(GC_STORAGE_OPERATION_LIMIT),
    hooks: {},
    ...overrides,
  };
  const store = createGcStore(env, dependencies.budget);
  const orphanMinAgeMs = configuredExactInteger(
    "GC_ORPHAN_MIN_AGE_MS",
    env.GC_ORPHAN_MIN_AGE_MS,
    GC_ORPHAN_MIN_AGE_MS,
  );

  async function finishError(run: GcRunHandle): Promise<GcRunResult> {
    return store.finish(
      run,
      {
        nextCursor: run.inputCursor,
        scanned: 0,
        eligible: 0,
        deleted: 0,
        error: "Garbage collection page failed",
        finishedAt: dependencies.now(),
      },
      { persistCursor: false },
    );
  }

  async function runR2(
    run: GcRunHandle,
    input: ParsedRunGcBody,
    cursor: R2Cursor | null,
  ): Promise<GcRunResult> {
    // Worst case after listing: one primary reference query, one head per object, one
    // heartbeat, one array delete, and one final bookkeeping batch.
    const capacity = dependencies.budget.remaining - 5;
    const limit = Math.min(input.maxObjects, GC_R2_LIST_LIMIT, capacity);
    if (limit < 1) throw new GcBudgetExhaustedError();

    dependencies.budget.charge();
    const listed = await env.BLOBS.list({
      limit,
      ...(cursor ? { cursor: cursor.value } : {}),
    });
    await dependencies.hooks.afterList?.();
    const nextCursor = listed.truncated
      ? listed.cursor
        ? encodeR2Cursor(listed.cursor)
        : invalidCursor()
      : null;

    const valid = listed.objects.filter(
      ({ key }) => parseBlobKey(key) !== null || isStagingObjectKey(key),
    );
    const referenced = await store.referencedR2Keys(valid.map(({ key }) => key));
    await dependencies.hooks.afterReferences?.();
    const cutoff = dependencies.now() - orphanMinAgeMs;
    const deletable: string[] = [];
    for (const [index, object] of valid.entries()) {
      if (referenced.has(object.key) || object.uploaded.getTime() >= cutoff) continue;
      await dependencies.hooks.beforeHead?.(index);
      dependencies.budget.charge();
      const current = await env.BLOBS.head(object.key);
      if (
        current !== null &&
        current.etag === object.etag &&
        current.uploaded.getTime() === object.uploaded.getTime()
      ) {
        deletable.push(object.key);
      }
    }

    await store.heartbeat(run, dependencies.now());
    let deleted = 0;
    if (!run.dryRun && deletable.length > 0) {
      await dependencies.hooks.beforeDelete?.();
      dependencies.budget.charge();
      await env.BLOBS.delete(deletable);
      deleted = deletable.length;
    }
    return store.finish(run, {
      nextCursor,
      scanned: listed.objects.length,
      eligible: deletable.length,
      deleted,
      error: null,
      finishedAt: dependencies.now(),
    });
  }

  async function runLedger(
    run: GcRunHandle,
    input: ParsedRunGcBody,
    cursor: LedgerCursor | null,
  ): Promise<GcRunResult> {
    const cutoff = dependencies.now() - IDEMPOTENCY_TTL_MS;
    const rows = await store.ledgerPage(
      cutoff,
      cursor ? { createdAt: cursor.createdAt, rowid: cursor.rowid } : null,
      input.maxObjects + 1,
    );
    const page = rows.slice(0, input.maxObjects);
    const hasNext = rows.length > input.maxObjects;
    const boundary = page.at(-1);
    const nextCursor =
      hasNext && boundary !== undefined
        ? encodeLedgerCursor(boundary.created_at, boundary.rowid)
        : null;
    await store.heartbeat(run, dependencies.now());
    const cleanupLimit = run.dryRun
      ? 0
      : Math.min(input.maxObjects, Math.floor(Math.max(0, dependencies.budget.remaining - 3) / 2));
    const ledgerCleanup = run.dryRun
      ? { deleted: 0, cleanup: [] }
      : await store.deleteLedgerAndCleanupUploadStaging(
          page,
          cutoff,
          dependencies.now() - orphanMinAgeMs,
          dependencies.now(),
          cleanupLimit,
        );
    const deleted = ledgerCleanup.deleted;
    if (!run.dryRun) {
      const cleaned = [];
      for (const row of ledgerCleanup.cleanup) {
        dependencies.budget.charge();
        const completed = await env.BLOBS.head(row.staged_r2_key);
        dependencies.budget.charge();
        if (completed !== null) {
          await env.BLOBS.delete(row.staged_r2_key);
        } else {
          await env.BLOBS.resumeMultipartUpload(row.staged_r2_key, row.r2_upload_id).abort();
        }
        cleaned.push(row);
      }
      await store.removeMultipartCleanupRows(cleaned);
    }
    return store.finish(run, {
      nextCursor,
      scanned: page.length,
      eligible: page.length,
      deleted,
      error: null,
      finishedAt: dependencies.now(),
    });
  }

  return {
    budget: dependencies.budget,
    async run(input: ParsedRunGcBody): Promise<GcRunResult> {
      if (!dependencies.budget.canCharge(input.kind === "r2-orphans" ? 8 : 6)) {
        throw new GcBudgetExhaustedError();
      }
      const explicit = input.cursor === undefined ? null : decodeGcCursor(input.kind, input.cursor);
      const startedAt = dependencies.now();
      const lease = await store.acquire(input.kind, dependencies.createOwner(), startedAt);
      const inputCursor = input.cursor ?? lease.storedCursor;
      const run = await store.startRun(
        lease,
        dependencies.createId(),
        input.dryRun,
        inputCursor,
        startedAt,
      );
      try {
        const decoded =
          explicit ?? (inputCursor === null ? null : decodeGcCursor(input.kind, inputCursor));
        return input.kind === "r2-orphans"
          ? await runR2(run, input, decoded as R2Cursor | null)
          : await runLedger(run, input, decoded as LedgerCursor | null);
      } catch (error) {
        if (error instanceof GcLeaseLostError) throw error;
        return finishError(run);
      }
    },
  };
}
