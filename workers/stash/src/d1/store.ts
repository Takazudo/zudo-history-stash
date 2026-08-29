import { createReads } from "./reads.js";
import { createWrites } from "./writes.js";
import { createChangeSets } from "./change-sets.js";
import type { Env } from "../env.js";

export interface StoreDependencies {
  now: () => number;
  createId: () => string;
}

const defaultDependencies: StoreDependencies = {
  now: () => Date.now(),
  createId: () => crypto.randomUUID(),
};

export function createStashStore(env: Env, deps: Partial<StoreDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...deps };
  return {
    reads: createReads(env, dependencies),
    writes: createWrites(env, dependencies),
    changeSets: createChangeSets(env, dependencies),
    deps: dependencies,
  };
}
