import type { Env } from "../env.js";
import type { StoreDependencies } from "./store.js";

export interface StashWrites {
  notImplemented(): never;
}

export function createWrites(_env: Env, _deps: StoreDependencies): StashWrites {
  return {
    notImplemented(): never {
      throw new Error("not-implemented");
    },
  };
}
