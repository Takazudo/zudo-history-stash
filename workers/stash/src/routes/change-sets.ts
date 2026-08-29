import {
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CreateChangeSetBody,
  ListChangeSetsQuery,
  RejectChangeSetBody,
  StashError,
  type CommitConflict,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";
import { commitEvents, eventOrigin, publishEvents } from "../events/publish.js";

const changeSets = new Hono<AppEnv>();

function invalid(message: string): never {
  throw new StashError("validation", message);
}

changeSets.post(
  "/v1/stashes/:stash/change-sets",
  zValidator("json", CreateChangeSetBody, (result) => {
    if (!result.success) {
      const bodyIssue = result.error.issues.find((issue) => issue.path.at(-1) === "body");
      if (bodyIssue?.message === "String is not well-formed") {
        throw new StashError("body-not-well-formed", "Body is not well-formed Unicode.");
      }
      if (bodyIssue?.message.startsWith("Body exceeds ")) {
        throw new StashError("payload-too-large", "Change-set body is too large.");
      }
      invalid("Invalid change-set input.");
    }
  }),
  async (c) => {
    const stash = c.get("routeStash").name;
    const principal = c.get("principal");
    const result = await createStashStore(c.env, c.get("deps")).changeSets.createChangeSet(
      stash,
      c.req.valid("json"),
      {
        idempotencyKey: c.req.header("Idempotency-Key"),
        createdBy: principal.kind === "admin" ? "admin" : principal.tokenId,
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (!result.replayed) {
      publishEvents(c.env, c.executionCtx, stash, [
        {
          type: "change-set",
          changeSetId: result.value.id,
          stash,
          status: result.value.status,
          paths: result.value.entries.map(({ path }) => path),
          origin: eventOrigin(c.req.raw),
        },
      ]);
    }
    return c.json(result.value, 201);
  },
);

changeSets.get(
  "/v1/stashes/:stash/change-sets",
  zValidator("query", ListChangeSetsQuery, (result) => {
    if (!result.success) invalid("Invalid change-set query.");
  }),
  async (c) =>
    c.json(
      await createStashStore(c.env, c.get("deps")).changeSets.listChangeSets(
        c.get("routeStash").name,
        c.req.valid("query"),
      ),
    ),
);

changeSets.get("/v1/stashes/:stash/change-sets/:id", async (c) => {
  const value = await createStashStore(c.env, c.get("deps")).changeSets.getChangeSet(
    c.get("routeStash").name,
    c.req.param("id"),
  );
  if (value === null) throw new StashError("not-found", "Change set not found.");
  return c.json(value);
});

changeSets.get(
  "/v1/stashes/:stash/change-sets/:id/diff",
  zValidator("query", ChangeSetDiffQuery, (result) => {
    if (!result.success) invalid("Invalid change-set diff query.");
  }),
  async (c) => {
    const value = await createStashStore(c.env, c.get("deps")).changeSets.getChangeSetDiff(
      c.get("routeStash").name,
      c.req.param("id"),
      c.req.valid("query"),
    );
    if (value === null) throw new StashError("not-found", "Change set not found.");
    return c.json(value);
  },
);

changeSets.post(
  "/v1/stashes/:stash/change-sets/:id/approve",
  zValidator("json", ApproveChangeSetBody, (result) => {
    if (!result.success) invalid("Invalid change-set approval input.");
  }),
  async (c) => {
    const stash = c.get("routeStash").name;
    const principal = c.get("principal");
    const origin = eventOrigin(c.req.raw);
    try {
      const result = await createStashStore(c.env, c.get("deps")).changeSets.approveChangeSet(
        stash,
        c.req.param("id"),
        c.req.valid("json"),
        {
          decidedBy: principal.kind === "admin" ? "admin" : principal.tokenId,
          onApplied: (commit) =>
            publishEvents(c.env, c.executionCtx, stash, [
              ...commitEvents(commit, origin),
              {
                type: "change-set",
                changeSetId: c.req.param("id"),
                stash,
                status: "applied",
                paths: commit.entries.map(({ path }) => path),
                origin,
              },
            ]),
        },
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof StashError && "conflicts" in error) {
        return c.json(
          {
            error: { code: error.code, message: error.message },
            conflicts: (error as StashError & { conflicts: CommitConflict[] }).conflicts,
          },
          error.status as 404 | 409,
        );
      }
      throw error;
    }
  },
);

changeSets.post(
  "/v1/stashes/:stash/change-sets/:id/reject",
  zValidator("json", RejectChangeSetBody, (result) => {
    if (!result.success) invalid("Invalid change-set rejection input.");
  }),
  async (c) => {
    const stash = c.get("routeStash").name;
    const principal = c.get("principal");
    const origin = eventOrigin(c.req.raw);
    const result = await createStashStore(c.env, c.get("deps")).changeSets.rejectChangeSet(
      stash,
      c.req.param("id"),
      c.req.valid("json"),
      { decidedBy: principal.kind === "admin" ? "admin" : principal.tokenId },
    );
    publishEvents(c.env, c.executionCtx, stash, [
      {
        type: "change-set",
        changeSetId: result.id,
        stash,
        status: "rejected",
        paths: result.entries.map(({ path }) => path),
        origin,
      },
    ]);
    return c.json(result);
  },
);

export default changeSets;
