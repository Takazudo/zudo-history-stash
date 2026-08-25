import type { Env } from "./env.js";

export type Principal =
  { kind: "admin" } | { kind: "stash"; stash: string; tokenId: string; scope: "read" | "write" };

export interface AppEnv {
  Bindings: Env;
  Variables: { principal: Principal };
}
