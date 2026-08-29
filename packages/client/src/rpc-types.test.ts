import { expectTypeOf, it } from "vitest";
import type { RpcRouteId } from "@takazudo/zudo-history-stash-core";
import type { StashRpcMethods } from "./rpc-types.js";

it("covers every transport-eligible route with a named method", () => {
  const methods = {
    health: "health", me: "me", listStashes: "listStashes", createStash: "createStash",
    getStash: "getStash", deleteStash: "deleteStash", restoreStash: "restoreStash",
    createToken: "createToken", listTokens: "listTokens", rotateToken: "rotateToken", revokeToken: "revokeToken",
    importHistory: "importHistory", listChanges: "listChanges", runGc: "runGc", listGcRuns: "listGcRuns",
    createCommit: "createCommit", getCommit: "getCommit", listCommits: "listCommits", getCommitDiff: "getCommitDiff",
    revertCommit: "revertCommit", getSnapshot: "getSnapshot", createChangeSet: "createChangeSet",
    listChangeSets: "listChangeSets", getChangeSet: "getChangeSet", getChangeSetDiff: "getChangeSetDiff",
    approveChangeSet: "approveChangeSet", rejectChangeSet: "rejectChangeSet",
    listFiles: "listFiles", getFile: "getFile", putFile: "putFile", deleteFile: "deleteFile",
    rollbackFile: "rollbackFile", getHistory: "getHistory", getDiff: "getDiff", diffCandidate: "diffCandidate",
    getStashChanges: "getStashChanges",
  } as const satisfies Record<RpcRouteId, keyof StashRpcMethods>;
  expectTypeOf(methods).toBeObject();
  expectTypeOf<ReturnType<StashRpcMethods["createCommit"]>>().toEqualTypeOf<Promise<Response>>();
});
