import { z } from "zod";
import { ERROR_CODES } from "../errors.js";
import type { DiffResult, DiffHunk, DiffStats } from "../diff.js";
import type {
  CandidateDiffResult,
  ChangesPage,
  ChangeItem,
  CreateStashResult,
  CreateTokenResult,
  Current,
  CreatedToken,
  DeleteResult,
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
  HealthResponse,
  HistoryPage,
  ImportResult,
  ListChangesResult,
  ListFilesResult,
  ListStashesResult,
  ListTokensResult,
  MeResponse,
  PutCreatedResult,
  PutUnchangedResult,
  RollbackResult,
  StashListResponse,
  StashRecord,
  StashSummary,
  TokenListResponse,
  TokenRecord,
  VersionRecord,
} from "../types.js";

const TimestampSchema = z.iso.datetime();
const HashSchema = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const VersionKindSchema = z.enum(["put", "delete", "rollback"]);
const TokenScopeSchema = z.enum(["read", "write"]);
const MetaSchema = z.record(z.string(), z.json());
const IntegerSchema = z.number().int();
const NonNegativeIntegerSchema = IntegerSchema.nonnegative();
const NullableHashSchema = HashSchema.nullable();

export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal("zudo-history-stash"),
  marker: z.literal("ZHS_HEALTH_OK"),
});

export const MeResponseSchema = z.union([
  z.strictObject({ principal: z.literal("admin") }),
  z.strictObject({
    principal: z.literal("stash"),
    stash: z.string(),
    tokenId: z.string(),
    scope: TokenScopeSchema,
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
});

export const StashSummarySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  fileCount: NonNegativeIntegerSchema,
  deletedFileCount: NonNegativeIntegerSchema,
  lastChangeId: NonNegativeIntegerSchema.nullable(),
  lastChangeAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
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
  revokedAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(),
});

export const CreatedTokenSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  scope: TokenScopeSchema,
  createdAt: TimestampSchema,
  token: z.string(),
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
});

export const FileListResponseSchema = z.strictObject({
  files: z.array(FileSummarySchema),
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
});

export const VersionRecordSchema = z.strictObject({
  version: NonNegativeIntegerSchema,
  kind: VersionKindSchema,
  hash: NullableHashSchema,
  size: NonNegativeIntegerSchema,
  rollbackOf: NonNegativeIntegerSchema.nullable(),
  author: z.string(),
  message: z.string(),
  meta: MetaSchema,
  createdAt: TimestampSchema,
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
  changeId: NonNegativeIntegerSchema,
  stash: z.string(),
  path: z.string(),
  version: NonNegativeIntegerSchema,
  kind: VersionKindSchema,
  author: z.string(),
  message: z.string(),
  size: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
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
  version: NonNegativeIntegerSchema,
  changeId: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
});

export const RollbackResultSchema = z.strictObject({
  version: NonNegativeIntegerSchema,
  hash: HashSchema,
  rollbackOf: NonNegativeIntegerSchema,
  identicalToHead: z.boolean(),
  changeId: NonNegativeIntegerSchema,
  createdAt: TimestampSchema,
});

export const ImportResultSchema = z.strictObject({
  path: z.string(),
  headVersion: NonNegativeIntegerSchema,
  firstChangeId: NonNegativeIntegerSchema,
});

export const DiffSideSchema = z.strictObject({
  version: NonNegativeIntegerSchema,
  hash: NullableHashSchema,
  deleted: z.boolean(),
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

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorDetailSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
});

export const ErrorResponseSchema = z.strictObject({
  error: ErrorDetailSchema,
  current: CurrentSchema.optional(),
});

interface ResponseTypeMap {
  HealthResponse: HealthResponse;
  MeResponse: MeResponse;
  StashRecord: StashRecord;
  StashSummary: StashSummary;
  StashListResponse: StashListResponse;
  CreateStashResult: CreateStashResult;
  GetStashResult: GetStashResult;
  TokenRecord: TokenRecord;
  CreatedToken: CreatedToken;
  TokenListResponse: TokenListResponse;
  CreateTokenResult: CreateTokenResult;
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
  MeResponse: MeResponseSchema,
  StashRecord: StashRecordSchema,
  StashSummary: StashSummarySchema,
  StashListResponse: StashListResponseSchema,
  CreateStashResult: StashRecordSchema,
  GetStashResult: StashRecordSchema,
  TokenRecord: TokenRecordSchema,
  CreatedToken: CreatedTokenSchema,
  TokenListResponse: TokenListResponseSchema,
  CreateTokenResult: CreatedTokenSchema,
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
