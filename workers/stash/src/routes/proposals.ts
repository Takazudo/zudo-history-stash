import { Hono, type Handler } from "hono";
import type { AppEnv } from "../context.js";

const proposals = new Hono<AppEnv>();

const notImplemented: Handler<AppEnv> = (c) =>
  c.json(
    {
      error: {
        code: "not-implemented",
        message: "Proposal routes are registered but not implemented yet.",
      },
    },
    501,
  );

proposals.post("/v1/stashes/:stash/proposals", notImplemented);
proposals.get("/v1/stashes/:stash/proposals", notImplemented);
proposals.get("/v1/stashes/:stash/proposals/:id", notImplemented);
proposals.get("/v1/stashes/:stash/proposals/:id/diff", notImplemented);
proposals.post("/v1/stashes/:stash/proposals/:id/approve", notImplemented);
proposals.post("/v1/stashes/:stash/proposals/:id/reject", notImplemented);

export default proposals;
