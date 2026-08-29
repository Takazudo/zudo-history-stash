import { RunGcBody, type GcKind, type GcRunResult } from "@takazudo/zudo-history-stash-core";
import { GcBudgetExhaustedError, createGcEngine, GC_STORAGE_OPERATION_LIMIT } from "./gc.js";
import {
  GcLeaseLostError,
  GcLeaseUnavailableError,
  StorageOperationBudget,
} from "./d1/gc-store.js";
import type { Env } from "./env.js";

export const GC_SCHEDULED_MAX_OBJECTS = 80;
export const GC_SCHEDULED_MAX_PAGES_PER_KIND = 10;

const GC_KINDS: readonly GcKind[] = ["r2-orphans", "ledger", "content"];

function minimumPageOperations(kind: GcKind): number {
  // Content charges acquire + startRun + contentPage + heartbeat + delete-batch + finish = 6, exactly the ledger cost.
  return kind === "r2-orphans" ? 8 : 6;
}

function logPage(kind: GcKind, count: number, runId?: string): void {
  console.log(JSON.stringify({ kind, count, ...(runId === undefined ? {} : { runId }) }));
}

function logStopped(kind: GcKind): void {
  logPage(kind, 0);
}

function isFinished(result: GcRunResult): boolean {
  return result.error !== null || result.cursor === null;
}

/**
 * Runs bounded pages in a fair round-robin. The engines deliberately share one budget so a
 * scheduled invocation cannot spend a second kind's allowance after exhausting the first kind.
 */
export async function runScheduledGc(env: Env): Promise<void> {
  const budget = new StorageOperationBudget(GC_STORAGE_OPERATION_LIMIT);
  const engines = new Map(GC_KINDS.map((kind) => [kind, createGcEngine(env, { budget })] as const));
  const pages = new Map<GcKind, number>(GC_KINDS.map((kind) => [kind, 0]));
  const active = new Set<GcKind>(GC_KINDS);
  let nextKind = 0;

  while (active.size > 0) {
    const kind = GC_KINDS[nextKind % GC_KINDS.length];
    nextKind += 1;
    if (kind === undefined || !active.has(kind)) continue;

    const pageCount = pages.get(kind) ?? 0;
    if (
      pageCount >= GC_SCHEDULED_MAX_PAGES_PER_KIND ||
      !budget.canCharge(minimumPageOperations(kind))
    ) {
      active.delete(kind);
      logStopped(kind);
      continue;
    }

    pages.set(kind, pageCount + 1);
    let result: GcRunResult;
    try {
      result = await engines
        .get(kind)!
        .run(RunGcBody.parse({ kind, maxObjects: GC_SCHEDULED_MAX_OBJECTS }));
    } catch (error) {
      active.delete(kind);
      logStopped(kind);
      if (error instanceof GcLeaseUnavailableError || error instanceof GcLeaseLostError) {
        continue;
      }
      if (error instanceof GcBudgetExhaustedError) return;
      throw error;
    }

    logPage(kind, result.scanned, result.runId);
    if (isFinished(result) || (pages.get(kind) ?? 0) >= GC_SCHEDULED_MAX_PAGES_PER_KIND) {
      active.delete(kind);
    }
  }
}
