import { describe, expect, it } from "vitest";
import type { RouteId } from "@takazudo/zudo-history-stash-core";
import type { StashRpcMethods } from "./rpc-types.js";

const rpcMethodsByRoute = {
  health: "health",
  me: "me",
  listStashes: "listStashes",
  createStash: "createStash",
  getStash: "getStash",
  createToken: "createToken",
  listTokens: "listTokens",
  rotateToken: "rotateToken",
  revokeToken: "revokeToken",
  importHistory: "importHistory",
  listChanges: "listChanges",
  listFiles: "listFiles",
  getFile: "getFile",
  putFile: "putFile",
  deleteFile: "deleteFile",
  rollbackFile: "rollbackFile",
  getHistory: "getHistory",
  getDiff: "getDiff",
  diffCandidate: "diffCandidate",
  getStashChanges: "getStashChanges",
} as const satisfies Record<RouteId, keyof StashRpcMethods>;

const routesByRpcMethod = rpcMethodsByRoute satisfies Record<keyof StashRpcMethods, RouteId>;

describe("StashRpcMethods route pin", () => {
  it("covers every RouteId and exposes no extra method keys", () => {
    expect(routesByRpcMethod).toBe(rpcMethodsByRoute);
  });

  it("accepts an omitted rotation grace period at the public RPC boundary", () => {
    const input: Parameters<StashRpcMethods["rotateToken"]>[3] = {};
    expect(input).toEqual({});
  });
});
