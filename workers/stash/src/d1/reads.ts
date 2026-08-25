import type { Env } from "../env.js";
import type { StoreDependencies } from "./store.js";

export interface StashReads {
  notImplemented(): never;
}

export function createReads(_env: Env, _deps: StoreDependencies): StashReads {
  return {
    notImplemented(): never {
      throw new Error("not-implemented");
    },
  };
}
