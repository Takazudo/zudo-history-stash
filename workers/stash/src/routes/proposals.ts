import {
  ApproveProposalBody,
  CreateProposalBody,
  IDEMPOTENCY_KEY_MAX_CHARS,
  ListProposalsQuery,
  MAX_BODY_BYTES,
  ProposalDiffQuery,
  RejectProposalBody,
  StashError,
  isWellFormedString,
  utf8ByteLength,
  type ApproveProposalBody as ApproveProposalInput,
  type CreateProposalBody as CreateProposalInput,
  type RejectProposalBody as RejectProposalInput,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";

const proposals = new Hono<AppEnv>();
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(?:;.*)?$/i;

// The core schema's expiresAt refinement compares against Date.now(). Proposal creation must
// perform only structural validation here so a same-key replay remains valid after expiry. The
// store applies the injected-clock future check only after an idempotency miss.
const CreateProposalRouteBody = CreateProposalBody.extend({
  expiresAt: z.iso.datetime().optional(),
});

function notFound(): never {
  throw new StashError("not-found", "The requested proposal was not found.");
}

function principalId(c: Context<AppEnv>): string {
  const principal = c.get("principal");
  return principal.kind === "admin" ? "admin" : principal.tokenId;
}

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

function bodyValidation(candidate: unknown): never {
  if (typeof candidate === "object" && candidate !== null && "body" in candidate) {
    const body = candidate.body;
    if (typeof body === "string") {
      if (!isWellFormedString(body)) {
        throw new StashError("body-not-well-formed", "Body is not well-formed Unicode.");
      }
      if (utf8ByteLength(body) > MAX_BODY_BYTES) {
        throw new StashError("payload-too-large", "The proposal body is too large.");
      }
    }
  }
  throw new StashError("validation", "Invalid proposal input.");
}

async function createBody(c: Context<AppEnv>): Promise<CreateProposalInput> {
  const candidate = await jsonBody(c);
  const result = CreateProposalRouteBody.safeParse(candidate);
  if (!result.success) return bodyValidation(candidate);
  return result.data;
}

function hasOversizedStringIssue(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => typeof issue.message === "string" && issue.message.startsWith("String exceeds "),
  );
}

async function approveBody(c: Context<AppEnv>): Promise<ApproveProposalInput> {
  const result = ApproveProposalBody.safeParse(await jsonBody(c));
  if (!result.success) {
    if (hasOversizedStringIssue(result.error)) {
      throw new StashError("payload-too-large", "Proposal approval metadata is too large.");
    }
    throw new StashError("validation", "Invalid proposal approval input.");
  }
  return result.data;
}

async function rejectBody(c: Context<AppEnv>): Promise<RejectProposalInput> {
  const result = RejectProposalBody.safeParse(await jsonBody(c));
  if (!result.success) {
    if (hasOversizedStringIssue(result.error)) {
      throw new StashError("payload-too-large", "Proposal rejection reason is too large.");
    }
    throw new StashError("validation", "Invalid proposal rejection input.");
  }
  return result.data;
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

function store(c: Context<AppEnv>) {
  return createStashStore(c.env, { now: c.get("deps").now }).proposals;
}

proposals.post("/v1/stashes/:stash/proposals", async (c) => {
  const result = await store(c).createProposal(c.get("routeStash").name, await createBody(c), {
    idempotencyKey: idempotencyKey(c),
  });
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(result.value, 201);
});

proposals.get(
  "/v1/stashes/:stash/proposals",
  zValidator("query", ListProposalsQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid proposal list query.");
  }),
  async (c) => c.json(await store(c).listProposals(c.get("routeStash").name, c.req.valid("query"))),
);

proposals.get("/v1/stashes/:stash/proposals/:id", async (c) => {
  const result = await store(c).getProposal(c.get("routeStash").name, c.req.param("id"));
  if (result === null) return notFound();
  return c.json(result);
});

proposals.get(
  "/v1/stashes/:stash/proposals/:id/diff",
  zValidator("query", ProposalDiffQuery, (result) => {
    if (!result.success) throw new StashError("validation", "Invalid proposal diff query.");
  }),
  async (c) => {
    const result = await store(c).getProposalDiff(
      c.get("routeStash").name,
      c.req.param("id"),
      c.req.valid("query"),
    );
    if (result === null) return notFound();
    return c.json(result);
  },
);

proposals.post("/v1/stashes/:stash/proposals/:id/approve", async (c) => {
  const result = await store(c).approveProposal(
    c.get("routeStash").name,
    c.req.param("id"),
    await approveBody(c),
    principalId(c),
  );
  if (result === null) return notFound();
  return c.json(result);
});

proposals.post("/v1/stashes/:stash/proposals/:id/reject", async (c) => {
  const result = await store(c).rejectProposal(
    c.get("routeStash").name,
    c.req.param("id"),
    await rejectBody(c),
    principalId(c),
  );
  if (result === null) return notFound();
  return c.json(result);
});

export default proposals;
