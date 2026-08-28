import type { RouteMethod } from "./routes.js";

/** A structured-clone-friendly request sent through the stash RPC entrypoint. */
export interface RpcRequest {
  method: RouteMethod;
  /** A `/v1/...` path with route parameters substituted and left unencoded. */
  path: string;
  query?: Record<string, string>;
  /** Request metadata. `Authorization` is ignored because {@link token} always wins. */
  headers?: Record<string, string>;
  body?: string;
  token: string;
}
