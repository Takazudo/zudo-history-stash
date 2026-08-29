import {
  ChangeSetDiffQuery,
  CreateChangeSetBody,
  ListChangeSetsQuery,
  StashError,
} from "@takazudo/zudo-history-stash-core";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Handler } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";
import { eventOrigin, publishEvents } from "../events/publish.js";

const changeSets = new Hono<AppEnv>();

function invalid(message: string): never {
  throw new StashError("validation", message);
}

changeSets.post(
  "/v1/stashes/:stash/change-sets",
  zValidator("json", CreateChangeSetBody, (result) => {
    if (!result.success) invalid("Invalid change-set input.");
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

const notImplemented: Handler<AppEnv> = (c) =>
  c.json(
    { error: { code: "not-implemented", message: "This route is not implemented yet." } },
    501,
  );
changeSets.post("/v1/stashes/:stash/change-sets/:id/approve", notImplemented);
changeSets.post("/v1/stashes/:stash/change-sets/:id/reject", notImplemented);

export default changeSets;
