/** Package version exposed for diagnostics and compatibility checks. */
export const VERSION = "0.0.0";

// This is the minimal scaffold surface. The viewer-consumer integration task owns the final
// public export list after the leaf components have landed.
export * from "./provider/index.js";
export * from "./primitives/index.js";
