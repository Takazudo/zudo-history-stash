import type { Env } from "./env.js";
import type { StoreDependencies } from "./d1/store.js";
import type { StashRow } from "./d1/schema.js";

export type Principal =
  | { kind: "admin" }
  | {
      kind: "stash";
      stash: string;
      tokenId: string;
      scope: "read" | "write";
      expiresAt: string | null;
    };

export type AppDependencies = Pick<StoreDependencies, "now">;

export interface AppEnv {
  Bindings: Env;
  Variables: { principal: Principal; deps: AppDependencies; routeStash: StashRow };
}
