import { z } from "zod";
import { ERROR_CODES } from "../errors.js";
import type { DiffResult, DiffHunk, DiffStats } from "../diff.js";
import type {
  CandidateDiffResult,
  CapabilitiesResponse,
  CreateUploadSessionResult,
  GetUploadSessionResult,
  CompleteUploadResult,
  AbortUploadResult,
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
  CommitEntryRecord,
  CommitRecord,
  CommitResult,
  CommitSummary,
  CommitListResponse,
  CommitDiffResult,
  SnapshotResponse,
  ChangeSetRecord,
  ChangeSetListResponse,
  ChangeSetDiffResult,
  ApproveChangeSetResult,
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
import {
  StashChangeEventSchema,
  StashEventSchema,
  StashCommitEventSchema,
  StashChangeSetEventSchema,
  StashReadyEventSchema,
  StashReconnectEventSchema,
} from "../schemas.js";

const TimestampSchema = z.iso.datetime();
const HashSchema = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const VersionKindSchema = z.enum(["put", "delete", "rollback"]);
const GcKindSchema = z.enum(["r2-orphans", "ledger", "content"]);
const ChangeSetStatusSchema = z.enum(["open", "applied", "rejected", "expired"]);
const TokenScopeSchema = z.enum(["read", "write"]);
const MetaSchema = z.record(z.string(), z.json());
const IntegerSchema = z.number().int();
const NonNegativeIntegerSchema = IntegerSchema.nonnegative();
const PositiveIntegerSchema = IntegerSchema.positive();
const NullableHashSchema = HashSchema.nullable();
const RepresentationSchema = z.enum(["text", "binary"]);
const ContentAccessSchema = z.enum(["inline", "raw", "deleted"]);
const CompatibleContentFields = {
  representation: RepresentationSchema.optional(),
  contentAccess: ContentAccessSchema.optional(),
  contentType: z.string().optional(),
  byteSize: NonNegativeIntegerSchema.optional(),
  etag: NullableHashSchema.optional(),
};

export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal("zudo-history-stash"),
  marker: z.literal("ZHS_HEALTH_OK"),
});

export const CapabilitiesResponseSchema: z.ZodType<CapabilitiesResponse> = z.strictObject({
  representations: z.tuple([z.literal("text"), z.literal("binary")]),
  contentAccess: z.tuple([z.literal("inline"), z.literal("raw"), z.literal("deleted")]),
  transferModes: z.tuple([z.literal("json"), z.literal("single"), z.literal("multipart")]),
  storageTiers: z.tuple([z.literal("d1"), z.literal("r2")]),
  commitEntryKinds: z.tuple([
    z.literal("put"),
    z.literal("copy"),
    z.literal("delete"),
    z.literal("rollback"),
  ]),
  limits: z.strictObject({
    jsonInlineMaxBytes: z.number().int().positive(),
    d1InlineMaxBytes: z.number().int().positive(),
    httpRequestMaxBytes: z.number().int().positive(),
    singleUploadMaxBytes: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    diffMaxBytesPerSide: z.number().int().positive(),
    multipartPartBytes: z.number().int().positive(),
    maxMultipartParts: z.literal(10_000),
    maxOpenUploadSessionsPerStash: z.number().int().positive(),
    maxReservedUploadBytesPerStash: z.number().int().positive(),
    uploadSessionTtlSeconds: z.number().int().positive(),
  }),
});

export const MeResponseSchema = z.union([
  z.strictObject({ principal: z.literal("admin") }),
  z.strictObject({
    principal: z.literal("stash"),
    stash: z.string(),
    tokenId: z.string(),
    scope: TokenScopeSchema,
    expiresAt: TimestampSchema.nullable(),
  }),
]);

export const StashRecordSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  meta: MetaSchema,
  fileCount: NonNegativeIntegerSchema,
  deletedFileCount: NonNegativeIntegerSchema,
  lastChangeId: NonNegativeIntegerSchema.nullable(),
  lastChangeAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  restoreUntil: TimestampSchema.nullable(),
  restorable: z.boolean(),
});

export const StashSummarySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  fileCount: NonNegativeIntegerSchema,
  deletedFileCount: NonNegativeIntegerSchema,
  lastChangeId: NonNegativeIntegerSchema.nullable(),
  lastChangeAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  restoreUntil: TimestampSchema.nullable(),
  restorable: z.boolean(),
});

export const StashListResponseSchema = z.strictObject({
  stashes: z.array(StashSummarySchema),
  nextAfter: z.string().nullable(),
});

export const TokenRecordSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  scope: TokenScopeSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  rotatedFrom: z.string().nullable(),
  rotatedTo: z.string().nullable(),
  revokedAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(),
});

export const CreatedTokenSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  scope: TokenScopeSchema,
  createdAt: TimestampSchema,
  token: z.string(),
  expiresAt: TimestampSchema.nullable(),
  rotatedFrom: z.string().nullable(),
});

export const RotateTokenResultSchema: z.ZodType<RotateTokenResult> = CreatedTokenSchema.extend({
  predecessor: z.strictObject({
    id: z.string(),
    expiresAt: TimestampSchema.nullable(),
  }),
});

export const TokenListResponseSchema = z.strictObject({
  tokens: z.array(TokenRecordSchema),
});

export const FileSummarySchema = z.strictObject({
  path: z.string(),
  headVersion: NonNegativeIntegerSchema,
  hash: NullableHashSchema,
  size: NonNegativeIntegerSchema,
  deleted: z.boolean(),
  updatedAt: TimestampSchema,
  ...CompatibleContentFields,
});

export const FileListResponseSchema = z.strictObject({
  files: z.array(FileSummarySchema),
  commonPrefixes: z.array(z.string()).optional(),
  nextAfter: z.string().nullable(),
});

export const FileRecordSchema = z.strictObject({
  path: z.string(),
  version: NonNegativeIntegerSchema,
  hash: NullableHashSchema,
  size: NonNegativeIntegerSchema,
  kind: VersionKindSchema,
  author: z.string(),
  message: z.string(),
  meta: MetaSchema,
  createdAt: TimestampSchema,
  deleted: z.boolean(),
  body: z.string().nullable(),
  ...CompatibleContentFields,
});

export const VersionRecordSchema = z.strictObject({
  commitId: z.string(),
  version: NonNegativeIntegerSchema,
  kind: VersionKindSchema,
  hash: NullableHashSchema,
  size: NonNegativeIntegerSchema,
  rollbackOf: NonNegativeIntegerSchema.nullable(),
  author: z.string(),
  message: z.string(),
  meta: MetaSchema,
  createdAt: TimestampSchema,
  ...CompatibleContentFields,
});

export const HistoryPageSchema = z.strictObject({
  path: z.string(),
  headVersion: NonNegativeIntegerSchema,
  deleted: z.boolean(),
  total: NonNegativeIntegerSchema,
  versions: z.array(VersionRecordSchema),
  nextBefore: NonNegativeIntegerSchema.nullable(),
});

export const ChangeItemSchema = z.strictObject({
  commitId: z.string(),
  changeId: NonNegativeIntegerSchema,
  stash: z.string(),
  path: z.string(),
  version: NonNegativeIntegerSchema,
  kind: VersionKindSchema,
  author: z.string(),
  message: z.string(),
  size: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
  ...CompatibleContentFields,
});

export const ChangesPageSchema: z.ZodType<ChangesPage> = z.union([
  z.strictObject({
    changes: z.array(ChangeItemSchema),
    hasMore: z.boolean(),
    nextSince: NonNegativeIntegerSchema.nullable(),
    nextBefore: z.never().optional(),
  }),
  z.strictObject({
    changes: z.array(ChangeItemSchema),
    hasMore: z.boolean(),
    nextBefore: NonNegativeIntegerSchema.nullable(),
    nextSince: z.never().optional(),
  }),
]);

export const PutCreatedResultSchema = z.strictObject({
  commitId: z.string(),
  version: NonNegativeIntegerSchema,
  hash: HashSchema,
  size: NonNegativeIntegerSchema,
  changeId: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
});

export const PutUnchangedResultSchema = z.strictObject({
  unchanged: z.literal(true),
  version: NonNegativeIntegerSchema,
});

export const DeleteResultSchema = z.strictObject({
  commitId: z.string(),
  version: NonNegativeIntegerSchema,
  changeId: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
});

export const RollbackResultSchema = z.strictObject({
  commitId: z.string(),
  version: NonNegativeIntegerSchema,
  hash: HashSchema,
  rollbackOf: NonNegativeIntegerSchema,
  identicalToHead: z.boolean(),
  changeId: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
  representation: RepresentationSchema.optional(),
  contentType: z.string().optional(),
  byteSize: NonNegativeIntegerSchema.optional(),
  etag: HashSchema.optional(),
});

export const ImportResultSchema = z.strictObject({
  commitId: z.string(),
  path: z.string(),
  headVersion: NonNegativeIntegerSchema,
  firstChangeId: NonNegativeIntegerSchema,
});

export const DeleteStashResultSchema: z.ZodType<DeleteStashResult> = z.strictObject({
  name: z.string(),
  deletedAt: TimestampSchema,
  revokedTokens: NonNegativeIntegerSchema,
  restoreUntil: TimestampSchema,
});

export const GcRunResultSchema: z.ZodType<GcRunResult> = z
  .strictObject({
    runId: z.uuid(),
    jobId: GcKindSchema,
    kind: GcKindSchema,
    dryRun: z.boolean(),
    scanned: NonNegativeIntegerSchema,
    eligible: NonNegativeIntegerSchema,
    deleted: NonNegativeIntegerSchema,
    cursor: z.string().nullable(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    error: z.string().nullable(),
  })
  .refine((value) => value.jobId === value.kind, {
    path: ["jobId"],
    message: "jobId must equal kind.",
  });

export const GcRunsResponseSchema: z.ZodType<GcRunsResponse> = z.strictObject({
  runs: z.array(GcRunResultSchema),
});

export const DiffSideSchema = z.strictObject({
  version: NonNegativeIntegerSchema,
  hash: NullableHashSchema,
  deleted: z.boolean(),
  ...CompatibleContentFields,
});

export const UploadCommitResultSchema = z.strictObject({
  commitId: z.string(),
  version: z.number().int().positive(),
  hash: HashSchema,
  size: NonNegativeIntegerSchema,
  representation: RepresentationSchema,
  storageTier: z.enum(["d1", "r2"]).optional(),
  contentType: z.string(),
  changeId: z.number().int().positive(),
  createdAt: TimestampSchema,
});

export const UploadCompletionResultSchema = z.union([
  UploadCommitResultSchema,
  z.strictObject({
    unchanged: z.literal(true),
    version: z.number().int().positive(),
    hash: HashSchema,
    size: NonNegativeIntegerSchema,
    representation: RepresentationSchema,
    contentType: z.string(),
  }),
]);

export const UploadPartRecordSchema = z.strictObject({
  partNumber: z.number().int().min(1).max(10_000),
  size: NonNegativeIntegerSchema,
  generation: NonNegativeIntegerSchema,
  etag: z.string(),
});

export const UploadSessionRecordSchema = z.strictObject({
  id: z.string(),
  stash: z.string(),
  path: z.string(),
  principal: z.union([
    z.strictObject({ kind: z.literal("admin") }),
    z.strictObject({ kind: z.literal("stash"), tokenId: z.string() }),
  ]),
  state: z.enum([
    "open",
    "uploaded",
    "finalizing",
    "committed",
    "aborted",
    "expired",
    "stale",
    "failed",
  ]),
  expectedVersion: z.number().int().positive().nullable(),
  declaredSize: NonNegativeIntegerSchema,
  declaredHash: HashSchema.nullable(),
  representation: RepresentationSchema,
  contentType: z.string(),
  mode: z.enum(["single", "multipart"]),
  storageTier: z.enum(["d1", "r2"]),
  partSize: z.number().int().positive().nullable(),
  expiresAt: TimestampSchema,
  attemptGeneration: NonNegativeIntegerSchema,
  uploadedSize: NonNegativeIntegerSchema.nullable(),
  uploadedHash: HashSchema.nullable(),
  finalizationLeaseOwner: z.string().nullable(),
  finalizationLeaseExpiresAt: TimestampSchema.nullable(),
  result: UploadCompletionResultSchema.nullable(),
});

export const GetUploadSessionResultSchema = UploadSessionRecordSchema.extend({
  parts: z.array(UploadPartRecordSchema),
});

export const AbortUploadResultSchema = z.strictObject({
  id: z.string(),
  state: z.literal("aborted"),
});

export const DiffHunkSchema = z.strictObject({
  oldStart: NonNegativeIntegerSchema,
  oldLines: NonNegativeIntegerSchema,
  newStart: NonNegativeIntegerSchema,
  newLines: NonNegativeIntegerSchema,
  lines: z.array(z.string()),
});

export const DiffStatsSchema = z.strictObject({
  added: NonNegativeIntegerSchema,
  removed: NonNegativeIntegerSchema,
});

export const DiffResultSchema = z.union([
  z.strictObject({ state: z.literal("same") }),
  z.strictObject({ state: z.literal("binary") }),
  z.strictObject({ state: z.literal("oversized"), reason: z.enum(["bytes", "complexity"]) }),
  z.strictObject({
    state: z.literal("ready"),
    unified: z.string(),
    truncated: z.boolean(),
    hunks: z.array(DiffHunkSchema),
    stats: DiffStatsSchema,
  }),
]);

export const FileDiffResultSchema: z.ZodType<FileDiffResult> = z.union([
  z.strictObject({
    state: z.literal("binary"),
    from: DiffSideSchema,
    to: DiffSideSchema,
  }),
  z.strictObject({
    state: z.literal("same"),
    from: DiffSideSchema,
    to: DiffSideSchema,
  }),
  z.strictObject({
    state: z.literal("oversized"),
    reason: z.enum(["bytes", "complexity"]),
    from: DiffSideSchema,
    to: DiffSideSchema,
  }),
  z.strictObject({
    state: z.literal("ready"),
    unified: z.string(),
    truncated: z.boolean(),
    hunks: z.array(DiffHunkSchema),
    stats: DiffStatsSchema,
    from: DiffSideSchema,
    to: DiffSideSchema,
  }),
]);

export const CurrentSchema = z.strictObject({
  version: NonNegativeIntegerSchema,
  hash: NullableHashSchema,
  deleted: z.boolean(),
  kind: VersionKindSchema,
  author: z.string(),
  createdAt: TimestampSchema,
});

const CommitOperationSchema = z.enum(["put", "copy", "delete", "rollback"]);
export const CommitEntryRecordSchema: z.ZodType<CommitEntryRecord> = z.strictObject({
  path: z.string(),
  op: CommitOperationSchema,
  version: PositiveIntegerSchema,
  kind: VersionKindSchema,
  changeId: PositiveIntegerSchema,
  hash: NullableHashSchema,
  size: NonNegativeIntegerSchema,
  contentType: z.string(),
  representation: RepresentationSchema,
  rollbackOf: PositiveIntegerSchema.nullable(),
  copiedFrom: z.strictObject({ path: z.string(), version: PositiveIntegerSchema }).optional(),
  identicalToHead: z.boolean().optional(),
});
const CommitRecordFields = {
  id: z.string(),
  stash: z.string(),
  source: z.string(),
  sourceId: z.string().nullable(),
  author: z.string(),
  message: z.string(),
  meta: MetaSchema,
  entryCount: PositiveIntegerSchema,
  firstChangeId: PositiveIntegerSchema,
  lastChangeId: PositiveIntegerSchema,
  revertsCommitId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: TimestampSchema,
};
export const CommitRecordSchema = z.strictObject({
  ...CommitRecordFields,
  entries: z.array(CommitEntryRecordSchema),
});
export const CommitResultSchema: z.ZodType<CommitResult> = CommitRecordSchema.extend({
  skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })).optional(),
});
export const CommitSummarySchema = z.strictObject(CommitRecordFields);
export const CommitListResponseSchema = z.strictObject({
  commits: z.array(CommitSummarySchema),
  nextAfter: z.string().nullable(),
  total: NonNegativeIntegerSchema,
});
const DiffEnvelopeSchema = z.union([
  DiffResultSchema,
  z.strictObject({ state: z.enum(["binary", "oversized"]) }),
]);
export const CommitDiffResultSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      path: z.string(),
      op: CommitOperationSchema,
      from: z.strictObject({ version: PositiveIntegerSchema, hash: NullableHashSchema }).nullable(),
      to: z.strictObject({ version: PositiveIntegerSchema, hash: NullableHashSchema }),
      diff: DiffEnvelopeSchema,
    }),
  ),
  truncated: z.boolean(),
});
export const SnapshotResponseSchema = z.strictObject({
  at: z.strictObject({ commitId: z.string(), changeId: PositiveIntegerSchema }),
  files: z.array(FileSummarySchema),
  commonPrefixes: z.array(z.string()).optional(),
  nextAfter: z.string().nullable(),
});
export const ChangeSetEntryRecordSchema = z.strictObject({
  path: z.string(),
  op: CommitOperationSchema,
  baseVersion: PositiveIntegerSchema.nullable(),
  current: CurrentSchema.nullable(),
  stale: z.boolean(),
});
export const ChangeSetRecordSchema = z.strictObject({
  id: z.string(),
  stash: z.string(),
  status: ChangeSetStatusSchema,
  author: z.string(),
  message: z.string(),
  meta: MetaSchema,
  expiresAt: TimestampSchema,
  createdBy: z.string(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  commitId: z.string().nullable(),
  entries: z.array(ChangeSetEntryRecordSchema),
});
export const ChangeSetListResponseSchema = z.strictObject({
  changeSets: z.array(ChangeSetRecordSchema),
  nextAfter: z.string().nullable(),
  total: NonNegativeIntegerSchema,
});
export const ChangeSetDiffResultSchema: z.ZodType<ChangeSetDiffResult> = z.strictObject({
  entries: z.array(
    z.strictObject({
      path: z.string(),
      op: CommitOperationSchema,
      base: CurrentSchema.nullable(),
      candidate: CurrentSchema.nullable(),
      current: CurrentSchema.nullable(),
      stale: z.boolean(),
      diff: z.union([
        z.strictObject({ state: z.literal("same") }),
        z.strictObject({
          state: z.literal("oversized"),
          reason: z.enum(["bytes", "complexity"]).optional(),
        }),
        z.strictObject({
          state: z.literal("ready"),
          unified: z.string(),
          truncated: z.boolean(),
          hunks: z.array(DiffHunkSchema),
          stats: DiffStatsSchema,
        }),
        z.strictObject({
          state: z.literal("binary"),
          base: z.strictObject({ hash: HashSchema, size: NonNegativeIntegerSchema }).nullable(),
          candidate: z
            .strictObject({ hash: HashSchema, size: NonNegativeIntegerSchema })
            .nullable(),
        }),
      ]),
    }),
  ),
  stale: z.boolean(),
  status: ChangeSetStatusSchema,
  truncated: z.boolean(),
});
export const ApproveChangeSetResultSchema: z.ZodType<ApproveChangeSetResult> = z.strictObject({
  status: z.literal("applied"),
  commit: CommitResultSchema,
});

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorDetailSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
  successorId: z.string().optional(),
});

export const ErrorResponseSchema = z.strictObject({
  error: ErrorDetailSchema,
  current: CurrentSchema.optional(),
  conflicts: z
    .array(
      z.strictObject({
        path: z.string(),
        expectedVersion: IntegerSchema.nullable(),
        current: CurrentSchema.nullable(),
      }),
    )
    .optional(),
});

interface ResponseTypeMap {
  HealthResponse: HealthResponse;
  CapabilitiesResponse: CapabilitiesResponse;
  MeResponse: MeResponse;
  StashRecord: StashRecord;
  StashSummary: StashSummary;
  StashListResponse: StashListResponse;
  CreateStashResult: CreateStashResult;
  GetStashResult: GetStashResult;
  DeleteStashResult: DeleteStashResult;
  RestoreStashResult: RestoreStashResult;
  GcRunResult: GcRunResult;
  GcRunsResponse: GcRunsResponse;
  StashReadyEvent: StashReadyEvent;
  StashChangeEvent: StashChangeEvent;
  StashCommitEvent: StashCommitEvent;
  StashChangeSetEvent: StashChangeSetEvent;
  StashReconnectEvent: StashReconnectEvent;
  StashEvent: StashEvent;
  CommitEntryRecord: CommitEntryRecord;
  CommitRecord: CommitRecord;
  CommitResult: CommitResult;
  CommitSummary: CommitSummary;
  CommitListResponse: CommitListResponse;
  CommitDiffResult: CommitDiffResult;
  SnapshotResponse: SnapshotResponse;
  ChangeSetRecord: ChangeSetRecord;
  ChangeSetListResponse: ChangeSetListResponse;
  ChangeSetDiffResult: ChangeSetDiffResult;
  ApproveChangeSetResult: ApproveChangeSetResult;
  TokenRecord: TokenRecord;
  CreatedToken: CreatedToken;
  TokenListResponse: TokenListResponse;
  CreateTokenResult: CreateTokenResult;
  RotateTokenResult: RotateTokenResult;
  FileSummary: FileSummary;
  FileListResponse: FileListResponse;
  FileRecord: FileRecord;
  VersionRecord: VersionRecord;
  HistoryPage: HistoryPage;
  ChangeItem: ChangeItem;
  ChangesPage: ChangesPage;
  PutCreatedResult: PutCreatedResult;
  PutUnchangedResult: PutUnchangedResult;
  DeleteResult: DeleteResult;
  RollbackResult: RollbackResult;
  ImportResult: ImportResult;
  DiffSide: DiffSide;
  DiffHunk: DiffHunk;
  DiffStats: DiffStats;
  DiffResult: DiffResult;
  FileDiffResult: FileDiffResult;
  Current: Current;
  ErrorDetail: ErrorDetail;
  ErrorResponse: ErrorResponse;
  CreateUploadSessionResult: CreateUploadSessionResult;
  GetUploadSessionResult: GetUploadSessionResult;
  CompleteUploadResult: CompleteUploadResult;
  AbortUploadResult: AbortUploadResult;
  ListStashesResult: ListStashesResult;
  ListTokensResult: ListTokensResult;
  ListFilesResult: ListFilesResult;
  GetFileResult: GetFileResult;
  GetHistoryResult: GetHistoryResult;
  ListChangesResult: ListChangesResult;
  GetDiffResult: GetDiffResult;
  CandidateDiffResult: CandidateDiffResult;
}

export const RESPONSE_SCHEMAS = {
  HealthResponse: HealthResponseSchema,
  CapabilitiesResponse: CapabilitiesResponseSchema,
  MeResponse: MeResponseSchema,
  StashRecord: StashRecordSchema,
  StashSummary: StashSummarySchema,
  StashListResponse: StashListResponseSchema,
  CreateStashResult: StashRecordSchema,
  GetStashResult: StashRecordSchema,
  DeleteStashResult: DeleteStashResultSchema,
  RestoreStashResult: StashRecordSchema,
  GcRunResult: GcRunResultSchema,
  GcRunsResponse: GcRunsResponseSchema,
  StashReadyEvent: StashReadyEventSchema,
  StashChangeEvent: StashChangeEventSchema,
  StashCommitEvent: StashCommitEventSchema,
  StashChangeSetEvent: StashChangeSetEventSchema,
  StashReconnectEvent: StashReconnectEventSchema,
  StashEvent: StashEventSchema,
  CommitEntryRecord: CommitEntryRecordSchema,
  CommitRecord: CommitRecordSchema,
  CommitResult: CommitResultSchema,
  CommitSummary: CommitSummarySchema,
  CommitListResponse: CommitListResponseSchema,
  CommitDiffResult: CommitDiffResultSchema,
  SnapshotResponse: SnapshotResponseSchema,
  ChangeSetRecord: ChangeSetRecordSchema,
  ChangeSetListResponse: ChangeSetListResponseSchema,
  ChangeSetDiffResult: ChangeSetDiffResultSchema,
  ApproveChangeSetResult: ApproveChangeSetResultSchema,
  TokenRecord: TokenRecordSchema,
  CreatedToken: CreatedTokenSchema,
  TokenListResponse: TokenListResponseSchema,
  CreateTokenResult: CreatedTokenSchema,
  RotateTokenResult: RotateTokenResultSchema,
  FileSummary: FileSummarySchema,
  FileListResponse: FileListResponseSchema,
  FileRecord: FileRecordSchema,
  VersionRecord: VersionRecordSchema,
  HistoryPage: HistoryPageSchema,
  ChangeItem: ChangeItemSchema,
  ChangesPage: ChangesPageSchema,
  PutCreatedResult: PutCreatedResultSchema,
  PutUnchangedResult: PutUnchangedResultSchema,
  DeleteResult: DeleteResultSchema,
  RollbackResult: RollbackResultSchema,
  ImportResult: ImportResultSchema,
  DiffSide: DiffSideSchema,
  DiffHunk: DiffHunkSchema,
  DiffStats: DiffStatsSchema,
  DiffResult: DiffResultSchema,
  FileDiffResult: FileDiffResultSchema,
  Current: CurrentSchema,
  ErrorDetail: ErrorDetailSchema,
  ErrorResponse: ErrorResponseSchema,
  CreateUploadSessionResult: UploadSessionRecordSchema,
  GetUploadSessionResult: GetUploadSessionResultSchema,
  CompleteUploadResult: UploadCompletionResultSchema,
  AbortUploadResult: AbortUploadResultSchema,
  ListStashesResult: StashListResponseSchema,
  ListTokensResult: TokenListResponseSchema,
  ListFilesResult: FileListResponseSchema,
  GetFileResult: FileRecordSchema,
  GetHistoryResult: HistoryPageSchema,
  ListChangesResult: ChangesPageSchema,
  GetDiffResult: FileDiffResultSchema,
  CandidateDiffResult: DiffResultSchema,
} as const satisfies {
  [K in keyof ResponseTypeMap]: z.ZodType<ResponseTypeMap[K]>;
};

export type ResponseSchemaName = keyof typeof RESPONSE_SCHEMAS;
