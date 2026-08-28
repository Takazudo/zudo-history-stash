/** Package version exposed for diagnostics and compatibility checks. */
export const VERSION = "0.0.0";

export * from "./client.js";
export * from "./binary.js";
export type { EventsOptions, StashEventStream, StashLiveStatus } from "./events.js";
export * from "./parse.js";
export {
  type ListGcRunsOptions,
  type ListStashesRpcOptions,
  type StashRpcBinding,
  type StashRpcEntrypoint,
  type StashRpcMethods,
} from "./rpc-types.js";
export {
  ROUTES,
  formatEtag,
  statusForCode,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
export type * from "@takazudo/zudo-history-stash-core";
