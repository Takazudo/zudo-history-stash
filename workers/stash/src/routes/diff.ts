import {
  DiffCandidateBody,
  DiffQuery,
  MAX_BODY_BYTES,
  StashError,
  computeDiff,
  validatePath,
  type DiffSide,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import type { StashReads, ReadVersionRecord } from "../d1/reads.js";
import { createStashStore } from "../d1/store.js";
import type { Env } from "../env.js";

const MAX_CONTEXT_LINES = 10;
const DiffRouteQuery = DiffQuery.superRefine((value, context) => {
  if (!Number.isSafeInteger(value.from)) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must be a safe integer" });
  }
  if (value.to !== "head" && !Number.isSafeInteger(value.to)) {
    context.addIssue({ code: "custom", path: ["to"], message: "to must be a safe integer" });
  }
  if (value.context !== undefined && value.context > MAX_CONTEXT_LINES) {
    context.addIssue({
      code: "custom",
      path: ["context"],
      message: `context must be at most ${MAX_CONTEXT_LINES}`,
    });
  }
});
const DiffCandidateRouteBody = DiffCandidateBody.superRefine((value, context) => {
  if (value.from !== "head" && !Number.isSafeInteger(value.from)) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must be a safe integer" });
  }
  if (value.context !== undefined && value.context > MAX_CONTEXT_LINES) {
    context.addIssue({
      code: "custom",
      path: ["context"],
      message: `context must be at most ${MAX_CONTEXT_LINES}`,
    });
  }
});

type DiffReads = Pick<StashReads, "getFile" | "listHistory">;

export interface DiffRouteDependencies {
  createReads?: (env: Env) => DiffReads;
}

interface ResolvedHead {
  side: DiffSide;
}

function notFound(): never {
  throw new StashError("not-found", "The requested file was not found.");
}

function versionNotFound(): never {
  throw new StashError("version-not-found", "The requested file version was not found.");
}

function internalReadError(): never {
  throw new StashError("internal", "An internal error occurred.");
}

function diffPath(requestPath: string, stash: string): string {
  const prefix = `/v1/stashes/${stash}/diff/`;
  const path = requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : "";
  const validation = validatePath(path);
  if (!validation.ok) throw new StashError(validation.error, validation.message);
  return path;
}

function toSide(version: ReadVersionRecord): DiffSide {
  return {
    version: version.version,
    hash: version.hash,
    deleted: version.kind === "delete",
  };
}

async function readHead(reads: DiffReads, stash: string, path: string): Promise<ResolvedHead> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await reads.listHistory(stash, path, { limit: 1 });
    if (page === null) return notFound();
    const version = page.versions[0];
    if (version !== undefined && version.version === page.headVersion) {
      return { side: toSide(version) };
    }
  }
  return internalReadError();
}

async function resolveSide(
  reads: DiffReads,
  stash: string,
  path: string,
  version: number,
  head: ResolvedHead,
): Promise<DiffSide> {
  if (version === head.side.version) return head.side;
  if (version > head.side.version) return versionNotFound();

  const page = await reads.listHistory(stash, path, { before: version + 1, limit: 1 });
  const resolved = page?.versions[0];
  if (resolved === undefined || resolved.version !== version) return versionNotFound();
  return toSide(resolved);
}

async function loadText(
  reads: DiffReads,
  stash: string,
  path: string,
  side: DiffSide,
): Promise<string> {
  if (side.deleted) return "";
  const file = await reads.getFile(stash, path, { version: side.version });
  if (file === null) return versionNotFound();
  if (file.deleted || file.body === null || file.hash !== side.hash) return internalReadError();
  return file.body;
}

function candidateValidationError(result: {
  success: false;
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> };
}): never {
  const bodyIssue = result.error.issues.find((issue) => issue.path[0] === "body");
  if (bodyIssue?.message === "String is not well-formed") {
    throw new StashError("body-not-well-formed", "Body is not well-formed Unicode.");
  }
  if (bodyIssue?.message === `Body exceeds ${MAX_BODY_BYTES} UTF-8 bytes`) {
    throw new StashError("payload-too-large", "Body is too large.");
  }
  throw new StashError("validation", "Invalid candidate diff input.");
}

export function createDiffRoutes(dependencies: DiffRouteDependencies = {}): Hono<AppEnv> {
  const createReads =
    dependencies.createReads ?? ((env: Env): DiffReads => createStashStore(env).reads);
  const diff = new Hono<AppEnv>();

  diff.get(
    "/v1/stashes/:stash/diff/*",
    requireRoute("getDiff"),
    zValidator("query", DiffRouteQuery, (result) => {
      if (!result.success) throw new StashError("validation", "Invalid diff query.");
    }),
    async (c) => {
      const stash = c.req.param("stash");
      const path = diffPath(c.req.path, stash);
      const query = c.req.valid("query");
      const reads = createReads(c.env);
      const head = await readHead(reads, stash, path);
      const from = await resolveSide(reads, stash, path, query.from, head);
      const toVersion = query.to === "head" ? head.side.version : query.to;
      const to = await resolveSide(reads, stash, path, toVersion, head);

      if (from.hash === to.hash) return c.json({ state: "same" as const, from, to });

      const [fromText, toText] = await Promise.all([
        loadText(reads, stash, path, from),
        loadText(reads, stash, path, to),
      ]);
      const result = computeDiff({
        fromText,
        toText,
        fromLabel: `a/${path}@v${from.version}`,
        toLabel: `b/${path}@v${to.version}`,
        context: query.context,
        maxUnifiedBytes: query.maxUnifiedBytes,
      });
      return c.json({ ...result, from, to });
    },
  );

  diff.post(
    "/v1/stashes/:stash/diff/*",
    requireRoute("diffCandidate"),
    zValidator("json", DiffCandidateRouteBody, (result) => {
      if (!result.success) return candidateValidationError(result);
    }),
    async (c) => {
      const stash = c.req.param("stash");
      const path = diffPath(c.req.path, stash);
      const input = c.req.valid("json");
      const reads = createReads(c.env);
      const head = await readHead(reads, stash, path);
      const fromVersion = input.from === "head" ? head.side.version : input.from;
      const from = await resolveSide(reads, stash, path, fromVersion, head);
      const fromText = await loadText(reads, stash, path, from);
      const result = computeDiff({
        fromText,
        toText: input.body,
        fromLabel: `a/${path}@v${from.version}`,
        toLabel: `b/${path}@candidate`,
        context: input.context,
      });
      return c.json(result);
    },
  );

  return diff;
}

const diff = createDiffRoutes();

export default diff;
