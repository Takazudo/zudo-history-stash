import {
  CommitDiffQuery,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListCommitsQuery,
  RevertCommitBody,
  StashError,
  type CreateCommitBody as CreateCommitBodyType,
  type ErrorResponse,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";
import type { StoreCommitResult } from "../d1/commits.js";

const commits = new Hono<AppEnv>();
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

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

function commitResponse(c: Context<AppEnv>, result: StoreCommitResult): Response {
  if (!result.ok) {
    const payload: ErrorResponse = {
      error: { code: result.error.code, message: result.error.message },
      ...(result.conflicts === undefined ? {} : { conflicts: result.conflicts }),
    };
    return c.json(payload, result.error.status as ContentfulStatusCode);
  }
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(result.value, 201);
}

commits.post("/v1/stashes/:stash/commits", async (c) => {
  const input = await jsonBody(c);
  const store = createStashStore(c.env, c.get("deps"));
  const result = await store.commits.createCommit(
    c.get("routeStash").name,
    input as CreateCommitBodyType,
    {
      principal: c.get("principal"),
      idempotencyKey: idempotencyKey(c),
    },
  );
  return commitResponse(c, result);
});

commits.get("/v1/stashes/:stash/commits/:id", async (c) => {
  const record = await createStashStore(c.env, c.get("deps")).commits.getCommit(
    c.get("routeStash").name,
    c.req.param("id"),
  );
  if (record === null) throw new StashError("not-found", "Commit not found.");
  return c.json(record);
});

commits.get(
  "/v1/stashes/:stash/commits",
  zValidator("query", ListCommitsQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid commit list query.");
  }),
  async (c) => {
    const page = await createStashStore(c.env, c.get("deps")).commits.listCommits(
      c.get("routeStash").name,
      c.req.valid("query"),
    );
    return c.json(page);
  },
);

commits.get(
  "/v1/stashes/:stash/commits/:id/diff",
  zValidator("query", CommitDiffQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid commit diff query.");
  }),
  async (c) => {
    const result = await createStashStore(c.env, c.get("deps")).commits.getCommitDiff(
      c.get("routeStash").name,
      c.req.param("id"),
      c.req.valid("query"),
    );
    if (result === null) throw new StashError("not-found", "Commit not found.");
    return c.json(result);
  },
);

commits.post("/v1/stashes/:stash/commits/:id/revert", async (c) => {
  const parsed = RevertCommitBody.safeParse(await jsonBody(c));
  if (!parsed.success) throw new StashError("validation", "Invalid revert input.");
  const result = await createStashStore(c.env, c.get("deps")).commits.revertCommit(
    c.get("routeStash").name,
    c.req.param("id"),
    parsed.data,
    { principal: c.get("principal"), idempotencyKey: idempotencyKey(c) },
  );
  return commitResponse(c, result);
});

export default commits;
