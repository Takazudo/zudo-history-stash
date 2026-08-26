import app from "./app.js";
import type { Env } from "./env.js";

export { StashRpc } from "./rpc.js";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    Promise.resolve(app.fetch(request, env, ctx)),
};
