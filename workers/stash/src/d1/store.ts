import { createReads } from "./reads.js";
import { createWrites } from "./writes.js";

/** Shared store seam. Feature tasks replace read/write modules independently. */
export const createStashStore = (env: unknown) => ({
  reads: createReads(env),
  writes: createWrites(env),
});
