import app from "./app.js";
import { runScheduledGc } from "./gc-scheduler.js";
import type { Env } from "./env.js";

export { StashRpc } from "./rpc.js";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    Promise.resolve(app.fetch(request, env, ctx)),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduledGc(env));
  },
} satisfies ExportedHandler<Env>;
