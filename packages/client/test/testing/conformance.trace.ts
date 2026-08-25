/**
 * Shared drift guard. The confirm issue imports this exact file and runs the same trace against
 * the real Worker; consumers can also import the runner from the published `./testing` subpath.
 */
export {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  CONFORMANCE_TRACE,
  runConformance,
} from "../../src/testing/index.js";
export type { ConformanceOptions, ConformanceReport } from "../../src/testing/index.js";
