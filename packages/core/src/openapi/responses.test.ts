import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { DiffHunk, DiffResult, DiffStats } from "../diff.js";
import type { ERROR_CODES } from "../errors.js";
import type {
  CandidateDiffResult,
  ApproveChangeSetResult,
  ChangesPage,
  ChangeItem,
  CreateStashResult,
  CreateTokenResult,
  Current,
  CreatedToken,
  DeleteResult,
  DeleteStashResult,
  DiffSide,
  ErrorDetail,
  ErrorResponse,
  ErrorCode,
  FileDiffResult,
  FileListResponse,
  FileRecord,
  FileSummary,
  GetDiffResult,
  GetFileResult,
  GetHistoryResult,
  GetStashResult,
  GcRunResult,
  GcRunsResponse,
  HealthResponse,
  HistoryPage,
  ImportResult,
  ListChangesResult,
  ListFilesResult,
  ListStashesResult,
  ListTokensResult,
  MeResponse,
  ChangeSetDiffResult,
  ChangeSetListResponse,
  ChangeSetRecord,
  CommitDiffResult,
  CommitEntryRecord,
  CommitListResponse,
  CommitRecord,
  CommitResult,
  CommitSummary,
  SnapshotResponse,
  PutCreatedResult,
  PutUnchangedResult,
  RotateTokenResult,
  RollbackResult,
  RestoreStashResult,
  StashListResponse,
  StashChangeEvent,
  StashEvent,
  StashCommitEvent,
  StashChangeSetEvent,
  StashReadyEvent,
  StashReconnectEvent,
  StashRecord,
  StashSummary,
  TokenListResponse,
  TokenRecord,
  VersionRecord,
} from "../types.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";
import { ROUTE_CONTRACTS } from "./contracts.js";

describe("response schema type locks", () => {
  it("keeps every registry entry aligned with its root response type", () => {
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.HealthResponse>>().toEqualTypeOf<HealthResponse>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.MeResponse>>().toEqualTypeOf<MeResponse>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.StashRecord>>().toEqualTypeOf<StashRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.StashSummary>>().toEqualTypeOf<StashSummary>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashListResponse>
    >().toEqualTypeOf<StashListResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CreateStashResult>
    >().toEqualTypeOf<CreateStashResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.GetStashResult>>().toEqualTypeOf<GetStashResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.DeleteStashResult>
    >().toEqualTypeOf<DeleteStashResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.RestoreStashResult>
    >().toEqualTypeOf<RestoreStashResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.GcRunResult>>().toEqualTypeOf<GcRunResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.GcRunsResponse>>().toEqualTypeOf<GcRunsResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashReadyEvent>
    >().toEqualTypeOf<StashReadyEvent>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashChangeEvent>
    >().toEqualTypeOf<StashChangeEvent>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashCommitEvent>
    >().toEqualTypeOf<StashCommitEvent>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashChangeSetEvent>
    >().toEqualTypeOf<StashChangeSetEvent>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.StashReconnectEvent>
    >().toEqualTypeOf<StashReconnectEvent>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.StashEvent>>().toEqualTypeOf<StashEvent>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CommitEntryRecord>
    >().toEqualTypeOf<CommitEntryRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.CommitRecord>>().toEqualTypeOf<CommitRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.CommitResult>>().toEqualTypeOf<CommitResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.CommitSummary>>().toEqualTypeOf<CommitSummary>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CommitListResponse>
    >().toEqualTypeOf<CommitListResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CommitDiffResult>
    >().toEqualTypeOf<CommitDiffResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.SnapshotResponse>
    >().toEqualTypeOf<SnapshotResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ChangeSetRecord>
    >().toEqualTypeOf<ChangeSetRecord>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ChangeSetListResponse>
    >().toEqualTypeOf<ChangeSetListResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ChangeSetDiffResult>
    >().toEqualTypeOf<ChangeSetDiffResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ApproveChangeSetResult>
    >().toEqualTypeOf<ApproveChangeSetResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.TokenRecord>>().toEqualTypeOf<TokenRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.CreatedToken>>().toEqualTypeOf<CreatedToken>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.TokenListResponse>
    >().toEqualTypeOf<TokenListResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CreateTokenResult>
    >().toEqualTypeOf<CreateTokenResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.RotateTokenResult>
    >().toEqualTypeOf<RotateTokenResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.FileSummary>>().toEqualTypeOf<FileSummary>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.FileListResponse>
    >().toEqualTypeOf<FileListResponse>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.FileRecord>>().toEqualTypeOf<FileRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.VersionRecord>>().toEqualTypeOf<VersionRecord>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.HistoryPage>>().toEqualTypeOf<HistoryPage>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.ChangeItem>>().toEqualTypeOf<ChangeItem>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.ChangesPage>>().toEqualTypeOf<ChangesPage>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.PutCreatedResult>
    >().toEqualTypeOf<PutCreatedResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.PutUnchangedResult>
    >().toEqualTypeOf<PutUnchangedResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.DeleteResult>>().toEqualTypeOf<DeleteResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.RollbackResult>>().toEqualTypeOf<RollbackResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.ImportResult>>().toEqualTypeOf<ImportResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.DiffSide>>().toEqualTypeOf<DiffSide>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.DiffHunk>>().toEqualTypeOf<DiffHunk>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.DiffStats>>().toEqualTypeOf<DiffStats>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.DiffResult>>().toEqualTypeOf<DiffResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.FileDiffResult>>().toEqualTypeOf<FileDiffResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.Current>>().toEqualTypeOf<Current>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.ErrorDetail>>().toEqualTypeOf<ErrorDetail>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.ErrorResponse>>().toEqualTypeOf<ErrorResponse>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ListStashesResult>
    >().toEqualTypeOf<ListStashesResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ListTokensResult>
    >().toEqualTypeOf<ListTokensResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ListFilesResult>
    >().toEqualTypeOf<ListFilesResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.GetFileResult>>().toEqualTypeOf<GetFileResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.GetHistoryResult>
    >().toEqualTypeOf<GetHistoryResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.ListChangesResult>
    >().toEqualTypeOf<ListChangesResult>();
    expectTypeOf<z.infer<typeof RESPONSE_SCHEMAS.GetDiffResult>>().toEqualTypeOf<GetDiffResult>();
    expectTypeOf<
      z.infer<typeof RESPONSE_SCHEMAS.CandidateDiffResult>
    >().toEqualTypeOf<CandidateDiffResult>();
  });
});

describe("response schema samples", () => {
  it("parses one valid sample for every registry entry", () => {
    for (const name of Object.keys(RESPONSE_SCHEMAS) as Array<keyof typeof RESPONSE_SCHEMAS>) {
      expect(RESPONSE_SCHEMAS[name].safeParse(SAMPLES[name]).success, name).toBe(true);
    }
  });

  it("enforces documented discriminants and hash formats", () => {
    expect(RESPONSE_SCHEMAS.MeResponse.safeParse({ principal: "operator" }).success).toBe(false);
    expect(
      RESPONSE_SCHEMAS.PutCreatedResult.safeParse({
        version: 1,
        hash: "sha256-not-a-64-hex-hash",
        size: 1,
        changeId: 1,
        createdAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      RESPONSE_SCHEMAS.ChangesPage.safeParse({
        changes: [],
        hasMore: false,
        nextSince: null,
        nextBefore: null,
      }).success,
    ).toBe(false);
    expect(
      RESPONSE_SCHEMAS.ErrorResponse.safeParse({
        error: {
          code: "already-rotated",
          message: "Token was already rotated",
          successorId: "tok_successor",
        },
      }).success,
    ).toBe(true);
    expect(
      RESPONSE_SCHEMAS.GcRunResult.safeParse({
        ...SAMPLES.GcRunResult,
        runId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      RESPONSE_SCHEMAS.GcRunResult.safeParse({
        ...SAMPLES.GcRunResult,
        jobId: "ledger",
      }).success,
    ).toBe(false);
    expect(
      RESPONSE_SCHEMAS.StashChangeEvent.safeParse({
        ...SAMPLES.StashChangeEvent,
        commitId: undefined,
      }).success,
    ).toBe(false);
    expect(
      RESPONSE_SCHEMAS.ErrorResponse.safeParse({
        error: { code: "commit-conflict", message: "Conflict" },
        conflicts: [{ path: "docs/a.md", expectedVersion: null, current: null }],
      }).success,
    ).toBe(true);
  });
});

describe("ERROR_CODES type lock", () => {
  it("covers ErrorCode in both directions", () => {
    expectTypeOf<Exclude<ErrorCode, (typeof ERROR_CODES)[number]>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<(typeof ERROR_CODES)[number], ErrorCode>>().toEqualTypeOf<never>();
  });
});

it("keeps response registry keys aligned with ROUTE_CONTRACTS", () => {
  for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
    for (const [status, response] of Object.entries(contract.responses)) {
      if (!response?.schema) continue;
      expect(RESPONSE_SCHEMAS[response.schema], `${routeId} ${status}`).toBeDefined();
    }
  }
});
