import { ListGcRunsQuery, RunGcBody, StashError } from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { GcCursorValidationError, GC_STORAGE_OPERATION_LIMIT, createGcEngine } from "../gc.js";
import { GcLeaseUnavailableError, StorageOperationBudget, createGcStore } from "../d1/gc-store.js";
import type { AppEnv } from "../context.js";

const gc = new Hono<AppEnv>();

const jsonContentType = /^application\/([a-z-.]+\+)?json(?:;.*)?$/i;

function validationError(message: string): never {
  throw new StashError("validation", message);
}

const validateJsonSyntax: MiddlewareHandler<AppEnv> = async (c, next) => {
  const contentType = c.req.header("Content-Type");
  if (contentType !== undefined && jsonContentType.test(contentType)) {
    try {
      await c.req.json();
    } catch {
      validationError("Invalid JSON body.");
    }
  }
  await next();
};

function mapGcError(error: unknown): never {
  if (error instanceof GcCursorValidationError) {
    throw new StashError("validation", "Invalid garbage collection cursor.");
  }
  if (error instanceof GcLeaseUnavailableError) {
    throw new StashError("gc-busy", "A garbage-collection run is already in progress.");
  }
  throw error;
}

function gcNow(c: Context<AppEnv>): () => number {
  return c.get("deps").now;
}

gc.post(
  "/v1/admin/gc",
  validateJsonSyntax,
  zValidator("json", RunGcBody, (result) => {
    if (!result.success) validationError("Invalid garbage collection input.");
  }),
  async (c) => {
    try {
      const budget = new StorageOperationBudget(GC_STORAGE_OPERATION_LIMIT);
      const engine = createGcEngine(c.env, { now: gcNow(c), budget });
      return c.json(await engine.run(c.req.valid("json")));
    } catch (error) {
      return mapGcError(error);
    }
  },
);

gc.get(
  "/v1/admin/gc/runs",
  zValidator("query", ListGcRunsQuery, (result) => {
    if (!result.success) validationError("Invalid garbage collection run query.");
  }),
  async (c) => {
    const query = c.req.valid("query");
    const store = createGcStore(c.env, new StorageOperationBudget());
    return c.json({ runs: await store.listRuns(query.kind, query.limit) });
  },
);

export default gc;
