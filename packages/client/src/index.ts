/** Package version exposed for diagnostics and compatibility checks. */
export const VERSION = "0.0.0";

export * from "./client.js";
export * from "./parse.js";
export * from "./rpc-types.js";
export {
  ROUTES,
  formatEtag,
  statusForCode,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
export type * from "@takazudo/zudo-history-stash-core";
