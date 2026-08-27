import { describe, expect, expectTypeOf, it } from "vitest";
import type { Current, RouteId } from "@takazudo/zudo-history-stash-core";
import {
  isProposalClosedResult,
  isProposalExpiredResult,
  isProposalStaleResult,
} from "./client.js";
import type {
  ApproveProposalClientResult,
  ListGcRunsOptions,
  ListStashesOptions,
  RejectProposalClientResult,
  StashClient,
} from "./client.js";
import type { StashRpcMethods } from "./rpc-types.js";

const rpcMethodsByRoute = {
  health: "health",
  me: "me",
  listStashes: "listStashes",
  createStash: "createStash",
  getStash: "getStash",
  deleteStash: "deleteStash",
  restoreStash: "restoreStash",
  createToken: "createToken",
  listTokens: "listTokens",
  rotateToken: "rotateToken",
  revokeToken: "revokeToken",
  importHistory: "importHistory",
  listChanges: "listChanges",
  runGc: "runGc",
  listGcRuns: "listGcRuns",
  createProposal: "createProposal",
  listProposals: "listProposals",
  getProposal: "getProposal",
  getProposalDiff: "getProposalDiff",
  approveProposal: "approveProposal",
  rejectProposal: "rejectProposal",
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

  it("keeps GC RPC inputs caller-optional where schemas supply defaults", () => {
    const runInput: Parameters<StashRpcMethods["runGc"]>[1] = {
      kind: "ledger",
    };
    const listInput: Parameters<StashRpcMethods["listGcRuns"]>[1] = {
      kind: "r2-orphans",
    };
    expect(runInput).toEqual({ kind: "ledger" });
    expect(listInput).toEqual({ kind: "r2-orphans" });
  });

  it("exposes includeDeleted on the raw stash-list RPC query", () => {
    const input: Parameters<StashRpcMethods["listStashes"]>[1] = {
      includeDeleted: true,
    };
    expect(input).toEqual({ includeDeleted: true });
  });

  it("keeps high-level list options strict after schema preprocessing", () => {
    expectTypeOf<ListStashesOptions["includeDeleted"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ListStashesOptions["limit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ListStashesOptions["after"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ListGcRunsOptions["kind"]>().toEqualTypeOf<"r2-orphans" | "ledger" | undefined>();
    expectTypeOf<ListGcRunsOptions["limit"]>().toEqualTypeOf<number | undefined>();
  });

  it("types high-level proposal decisions while retaining the staged raw RPC bridge", () => {
    type ProposalsClient = ReturnType<StashClient["proposals"]>;
    expectTypeOf<ReturnType<ProposalsClient["approve"]>>().toEqualTypeOf<
      Promise<ApproveProposalClientResult>
    >();
    expectTypeOf<ReturnType<ProposalsClient["reject"]>>().toEqualTypeOf<
      Promise<RejectProposalClientResult>
    >();
    expectTypeOf<ReturnType<StashRpcMethods["createProposal"]>>().toEqualTypeOf<
      Promise<Response>
    >();
    expectTypeOf<ReturnType<StashRpcMethods["approveProposal"]>>().toEqualTypeOf<
      Promise<Response>
    >();

    const verifyApprovalNarrowing = (result: ApproveProposalClientResult) => {
      if (isProposalStaleResult(result)) {
        expectTypeOf(result.current).toEqualTypeOf<Current>();
      }
      if (isProposalExpiredResult(result)) {
        expectTypeOf(result.error.code).toEqualTypeOf<"proposal-expired">();
      }
      if (isProposalClosedResult(result)) {
        expectTypeOf(result.error.code).toEqualTypeOf<"proposal-closed">();
      }
    };
    expectTypeOf(verifyApprovalNarrowing).toBeFunction();
  });
});
