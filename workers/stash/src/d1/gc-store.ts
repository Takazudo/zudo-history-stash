import type { GcRunResult } from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import type { GcJobKind, GcJobRow, GcRunRow } from "./schema.js";
import {
  acquireLease,
  deleteLedgerRows,
  finishRunBatch,
  heartbeatLease,
  insertRun,
  releaseLease,
  selectLedgerPage,
  selectReferencedR2Keys,
} from "./sql/gc.js";

export const GC_LEASE_TTL_MS = 300_000;

export function parseGcLeaseTtlMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== GC_LEASE_TTL_MS) {
    throw new Error(`GC_LEASE_TTL_MS must be exactly ${GC_LEASE_TTL_MS}`);
  }
  return parsed;
}

export class GcLeaseUnavailableError extends Error {
  constructor() {
    super("Garbage collection job is already running");
    this.name = "GcLeaseUnavailableError";
  }
}

export class GcLeaseLostError extends Error {
  constructor() {
    super("Garbage collection lease was lost");
    this.name = "GcLeaseLostError";
  }
}

export class StorageOperationBudget {
  readonly limit: number;
  #used = 0;

  constructor(limit = 45) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid storage operation budget");
    this.limit = limit;
  }

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return this.limit - this.#used;
  }

  canCharge(count: number): boolean {
    return Number.isInteger(count) && count >= 0 && count <= this.remaining;
  }

  charge(count = 1): void {
    if (!this.canCharge(count)) throw new GcBudgetExhaustedError();
    this.#used += count;
  }
}

export class GcBudgetExhaustedError extends Error {
  constructor() {
    super("Garbage collection storage operation budget is exhausted");
    this.name = "GcBudgetExhaustedError";
  }
}

export interface GcLease {
  kind: GcJobKind;
  owner: string;
  generation: number;
  storedCursor: string | null;
}

export interface GcRunHandle extends GcLease {
  runId: string;
  dryRun: boolean;
  inputCursor: string | null;
  startedAt: number;
}

export interface LedgerRow {
  rowid: number;
  created_at: number;
}

function changed(result: D1Result): number {
  return result.meta.changes;
}

function resultFromRow(row: GcRunRow): GcRunResult {
  return {
    runId: row.id,
    jobId: row.job_kind,
    kind: row.job_kind,
    dryRun: row.dry_run === 1,
    scanned: row.scanned,
    eligible: row.eligible,
    deleted: row.deleted,
    cursor: row.next_cursor,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    error: row.error,
  };
}

export function createGcStore(env: Env, budget: StorageOperationBudget) {
  const leaseTtlMs = parseGcLeaseTtlMs(env.GC_LEASE_TTL_MS);
  return {
    async acquire(kind: GcJobKind, owner: string, now: number): Promise<GcLease> {
      budget.charge();
      const row = await env.DB.prepare(acquireLease)
        .bind(owner, now + leaseTtlMs, now, kind, now)
        .first<GcJobRow>();
      if (row === null) throw new GcLeaseUnavailableError();
      return {
        kind,
        owner,
        generation: row.lease_generation,
        storedCursor: row.next_cursor,
      };
    },

    async startRun(
      lease: GcLease,
      runId: string,
      dryRun: boolean,
      inputCursor: string | null,
      startedAt: number,
    ): Promise<GcRunHandle> {
      budget.charge();
      const result = await env.DB.prepare(insertRun)
        .bind(
          runId,
          lease.kind,
          lease.generation,
          dryRun ? 1 : 0,
          inputCursor,
          startedAt,
          lease.kind,
          lease.owner,
          lease.generation,
        )
        .run();
      if (changed(result) !== 1) throw new GcLeaseLostError();
      return { ...lease, runId, dryRun, inputCursor, startedAt };
    },

    async heartbeat(run: GcRunHandle, now: number): Promise<void> {
      budget.charge();
      const result = await env.DB.prepare(heartbeatLease)
        .bind(now + leaseTtlMs, now, run.kind, run.owner, run.generation)
        .run();
      if (changed(result) !== 1) throw new GcLeaseLostError();
    },

    async release(lease: GcLease, now: number): Promise<void> {
      budget.charge();
      const result = await env.DB.prepare(releaseLease)
        .bind(now, lease.kind, lease.owner, lease.generation)
        .run();
      if (changed(result) !== 1) throw new GcLeaseLostError();
    },

    async finish(
      run: GcRunHandle,
      values: {
        nextCursor: string | null;
        scanned: number;
        eligible: number;
        deleted: number;
        error: string | null;
        finishedAt: number;
      },
      options: { persistCursor?: boolean } = {},
    ): Promise<GcRunResult> {
      budget.charge();
      const results = await env.DB.batch(
        finishRunBatch(env.DB, {
          kind: run.kind,
          owner: run.owner,
          generation: run.generation,
          runId: run.runId,
          persistCursor: options.persistCursor ?? !run.dryRun,
          ...values,
        }),
      );
      if (changed(results[0]!) !== 1 || changed(results.at(-1)!) !== 1) {
        throw new GcLeaseLostError();
      }
      return {
        runId: run.runId,
        jobId: run.kind,
        kind: run.kind,
        dryRun: run.dryRun,
        scanned: values.scanned,
        eligible: values.eligible,
        deleted: values.deleted,
        cursor: values.nextCursor,
        startedAt: new Date(run.startedAt).toISOString(),
        finishedAt: new Date(values.finishedAt).toISOString(),
        error: values.error,
      };
    },

    async referencedR2Keys(keys: readonly string[]): Promise<Set<string>> {
      if (keys.length === 0) return new Set();
      const found = new Set<string>();
      const session = env.DB.withSession("first-primary");
      for (let offset = 0; offset < keys.length; offset += 30) {
        const chunk = keys.slice(offset, offset + 30);
        budget.charge();
        const sql = selectReferencedR2Keys.replace(
          /__PLACEHOLDERS__/g,
          chunk.map(() => "?").join(", "),
        );
        const rows = await session
          .prepare(sql)
          .bind(...chunk, ...chunk, ...chunk)
          .all<{ r2_key: string }>();
        for (const row of rows.results) found.add(row.r2_key);
      }
      return found;
    },

    async cleanupUploadStaging(cutoff: number, now: number): Promise<number> {
      budget.charge();
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE upload_sessions SET state = 'expired', reservation_released_at = ?,
               updated_at = ?
             WHERE state IN ('open','uploaded') AND expires_at <= ?`,
        ).bind(now, now, now),
        env.DB.prepare(
          `DELETE FROM upload_staged_bytes
           WHERE created_at < ? AND EXISTS (
             SELECT 1 FROM upload_sessions sessions
             WHERE sessions.id = upload_staged_bytes.session_id
               AND sessions.attempt_generation = upload_staged_bytes.generation
               AND sessions.state IN ('committed','aborted','expired','stale','failed')
           )`,
        ).bind(cutoff),
        env.DB.prepare(
          `DELETE FROM upload_parts
           WHERE recorded_at < ? AND EXISTS (
             SELECT 1 FROM upload_sessions sessions
             WHERE sessions.id = upload_parts.session_id
               AND sessions.attempt_generation = upload_parts.generation
               AND sessions.state IN ('committed','aborted','expired','stale','failed')
           )`,
        ).bind(cutoff),
      ]);
      return results.slice(1).reduce((total, result) => total + changed(result), 0);
    },

    async ledgerPage(
      cutoff: number,
      after: { createdAt: number; rowid: number } | null,
      limit: number,
    ): Promise<LedgerRow[]> {
      budget.charge();
      const createdAt = after?.createdAt ?? -1;
      const rowid = after?.rowid ?? 0;
      const rows = await env.DB.withSession("first-primary")
        .prepare(selectLedgerPage)
        .bind(cutoff, createdAt, createdAt, rowid, limit)
        .all<LedgerRow>();
      return rows.results;
    },

    async deleteLedger(rows: readonly LedgerRow[], cutoff: number): Promise<number> {
      if (rows.length === 0) return 0;
      budget.charge();
      const session = env.DB.withSession("first-primary");
      const results = await session.batch(deleteLedgerRows(session, rows, cutoff));
      return results.reduce((total, result) => total + changed(result), 0);
    },

    async listRuns(kind: GcJobKind | undefined, limit: number): Promise<GcRunResult[]> {
      budget.charge();
      const where = kind === undefined ? "" : "WHERE job_kind = ?";
      const statement = env.DB.prepare(
        `SELECT id, job_kind, lease_generation, dry_run, input_cursor, next_cursor,
          scanned, eligible, deleted, error, started_at, finished_at
         FROM gc_runs ${where}
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      );
      const rows = await (
        kind === undefined ? statement.bind(limit) : statement.bind(kind, limit)
      ).all<GcRunRow>();
      return rows.results.map(resultFromRow);
    },
  };
}
