import type { z } from "zod";
import type { RESPONSE_SCHEMAS, ResponseSchemaName } from "./responses.js";

const CREATED_AT = "2026-08-26T00:00:00.000Z";
const UPDATED_AT = "2026-08-26T01:00:00.000Z";
const EXPIRES_AT = "2026-09-25T00:00:00.000Z";
const HASH_A = `sha256-${"a".repeat(64)}`;
const HASH_B = `sha256-${"b".repeat(64)}`;
const COMMIT_ID = "cmt_1787702400000deadbeef";

const stashRecord = {
  name: "demo",
  description: "Example stash",
  meta: { owner: "docs", retentionDays: 30 },
  fileCount: 2,
  deletedFileCount: 1,
  lastChangeId: 7,
  lastChangeAt: UPDATED_AT,
  createdAt: CREATED_AT,
  deletedAt: null,
  restoreUntil: null,
  restorable: false,
} as const;

const stashSummary = {
  name: stashRecord.name,
  description: stashRecord.description,
  fileCount: stashRecord.fileCount,
  deletedFileCount: stashRecord.deletedFileCount,
  lastChangeId: stashRecord.lastChangeId,
  lastChangeAt: stashRecord.lastChangeAt,
  createdAt: stashRecord.createdAt,
  deletedAt: stashRecord.deletedAt,
  restoreUntil: stashRecord.restoreUntil,
  restorable: stashRecord.restorable,
} as const;

const tokenRecord = {
  id: "tok_01HZX7Y3S5W5Q1R2P3A4B5C6D7",
  label: "read-only example",
  scope: "read",
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  rotatedFrom: null,
  rotatedTo: null,
  revokedAt: null,
  lastUsedAt: null,
} as const;

const createdToken = {
  id: tokenRecord.id,
  label: tokenRecord.label,
  scope: tokenRecord.scope,
  createdAt: tokenRecord.createdAt,
  token: "zhs_example_read_token",
  expiresAt: tokenRecord.expiresAt,
  rotatedFrom: tokenRecord.rotatedFrom,
} as const;

const rotatedToken = {
  ...createdToken,
  id: "tok_01HZX7Y3S5W5Q1R2P3A4B5C6D8",
  token: "zhs_example_rotated_token",
  rotatedFrom: tokenRecord.id,
  predecessor: { id: tokenRecord.id, expiresAt: "2026-08-26T00:05:00.000Z" },
} as const;

const fileSummary = {
  path: "docs/guide.md",
  headVersion: 3,
  hash: HASH_A,
  size: 13,
  deleted: false,
  updatedAt: UPDATED_AT,
} as const;

const fileRecord = {
  path: fileSummary.path,
  version: fileSummary.headVersion,
  hash: fileSummary.hash,
  size: fileSummary.size,
  kind: "put",
  author: "docs-bot",
  message: "Update guide",
  meta: { source: "example" },
  createdAt: UPDATED_AT,
  deleted: fileSummary.deleted,
  body: "Hello, stash!\n",
} as const;

const versionRecord = {
  commitId: COMMIT_ID,
  version: 3,
  kind: "put",
  hash: HASH_A,
  size: 13,
  rollbackOf: null,
  author: "docs-bot",
  message: "Update guide",
  meta: { source: "example" },
  createdAt: UPDATED_AT,
} as const;

const changeItem = {
  commitId: COMMIT_ID,
  changeId: 7,
  stash: "demo",
  path: "docs/guide.md",
  version: 3,
  kind: "put",
  author: "docs-bot",
  message: "Update guide",
  size: 13,
  createdAt: UPDATED_AT,
} as const;

const stashReadyEvent = { type: "ready", head: 7, checkpoint: 7 } as const;
const stashChangeEvent = {
  type: "change",
  changeId: 7,
  commitId: COMMIT_ID,
  stash: "demo",
  path: "docs/guide.md",
  version: 3,
  kind: "put",
  origin: "viewer-1",
  createdAt: UPDATED_AT,
} as const;
const stashCommitEvent = {
  type: "commit",
  commitId: COMMIT_ID,
  stash: "demo",
  entryCount: 1,
  firstChangeId: 7,
  lastChangeId: 7,
  origin: "viewer-1",
} as const;
const stashChangeSetEvent = {
  type: "change-set",
  changeSetId: "chs_1787702400000deadbeef",
  stash: "demo",
  status: "open",
  paths: ["docs/guide.md"] as string[],
  origin: "viewer-1",
} as const;
const stashReconnectEvent = { type: "reconnect", reason: "lifetime" } as const;

const diffLines = ["-Hello, stash!", "+Hello, history stash!"];
const diffHunk = {
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: diffLines,
} as const;

const diffStats = { added: 1, removed: 1 } as const;

const diffSideFrom = { version: 2, hash: HASH_B, deleted: false } as const;
const diffSideTo = { version: 3, hash: HASH_A, deleted: false } as const;
const oneStash = [stashSummary];
const oneToken = [tokenRecord];
const oneFile = [fileSummary];
const oneVersion = [versionRecord];
const oneChange = [changeItem];
const oneHunk = [diffHunk];
const gcRun = {
  runId: "00000000-0000-4000-8000-000000000001",
  jobId: "r2-orphans",
  kind: "r2-orphans",
  dryRun: false,
  scanned: 100,
  eligible: 3,
  deleted: 3,
  cursor: null,
  startedAt: UPDATED_AT,
  finishedAt: UPDATED_AT,
  error: null,
} as const;

const readyDiff = {
  state: "ready",
  unified: "@@ -1 +1 @@\n-Hello, stash!\n+Hello, history stash!\n",
  truncated: false,
  hunks: oneHunk,
  stats: diffStats,
} as const;

const currentHead = {
  version: 3,
  hash: HASH_A,
  deleted: false,
  kind: "put",
  author: "docs-bot",
  createdAt: UPDATED_AT,
} as const;

const commitEntry = {
  path: "docs/guide.md",
  op: "put",
  version: 3,
  kind: "put",
  changeId: 7,
  hash: HASH_A,
  size: 13,
  contentType: "text/markdown",
  representation: "text",
  rollbackOf: null,
} as const;
const commitRecord = {
  id: COMMIT_ID,
  stash: "demo",
  source: "api",
  sourceId: null,
  author: "docs-bot",
  message: "Update guide",
  meta: { source: "example" },
  entryCount: 1,
  firstChangeId: 7,
  lastChangeId: 7,
  revertsCommitId: null,
  createdBy: "tok_example",
  createdAt: UPDATED_AT,
  entries: [commitEntry] as (typeof commitEntry)[],
} as const;
const commitSummary = {
  id: COMMIT_ID,
  stash: "demo",
  source: "api",
  sourceId: null,
  author: "docs-bot",
  message: "Update guide",
  meta: { source: "example" },
  entryCount: 1,
  firstChangeId: 7,
  lastChangeId: 7,
  revertsCommitId: null,
  createdBy: "tok_example",
  createdAt: UPDATED_AT,
} as const;
const commitDiffEntry = {
  path: "docs/guide.md",
  op: "put",
  from: { version: 2, hash: HASH_B },
  to: { version: 3, hash: HASH_A },
  diff: readyDiff,
} as const;
const commitDiff = {
  entries: [commitDiffEntry] as (typeof commitDiffEntry)[],
  truncated: false,
} as const;
const changeSetEntry = {
  path: "docs/guide.md",
  op: "put",
  baseVersion: 2,
  current: currentHead,
  stale: true,
} as const;
const changeSetRecord = {
  id: "chs_1787702400000deadbeef",
  stash: "demo",
  status: "open",
  author: "review-bot",
  message: "Review guide",
  meta: {},
  expiresAt: EXPIRES_AT,
  createdBy: "tok_example",
  createdAt: CREATED_AT,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  commitId: null,
  entries: [changeSetEntry] as (typeof changeSetEntry)[],
} as const;
const rejectedChangeSetRecord = {
  ...changeSetRecord,
  status: "rejected",
  decidedAt: UPDATED_AT,
  decidedBy: "admin",
  decisionReason: "Superseded",
} as const;
const changeSetDiffEntry = {
  path: "docs/guide.md",
  op: "put",
  base: currentHead,
  candidate: currentHead,
  current: currentHead,
  stale: false,
  diff: readyDiff,
} as const;
const changeSetDiff = {
  entries: [changeSetDiffEntry] as (typeof changeSetDiffEntry)[],
  stale: false,
  status: "open",
  truncated: false,
} as const;

const uploadCommitResult = {
  commitId: COMMIT_ID,
  version: 4,
  hash: HASH_A,
  size: 13,
  representation: "binary",
  contentType: "application/octet-stream",
  changeId: 8,
  createdAt: UPDATED_AT,
} as const;

const uploadSession = {
  id: "upl_1787702400000deadbeef",
  stash: "demo",
  path: "assets/archive.bin",
  principal: { kind: "stash", tokenId: tokenRecord.id },
  state: "open",
  expectedVersion: null,
  declaredSize: 13,
  declaredHash: HASH_A,
  representation: "binary",
  contentType: "application/octet-stream",
  mode: "single",
  storageTier: "d1",
  partSize: null,
  expiresAt: EXPIRES_AT,
  attemptGeneration: 0,
  uploadedSize: null,
  uploadedHash: null,
  finalizationLeaseOwner: null,
  finalizationLeaseExpiresAt: null,
  result: null,
} as const;
const noUploadParts: { partNumber: number; size: number; generation: number; etag: string }[] = [];

const responseSamples = {
  HealthResponse: {
    ok: true,
    service: "zudo-history-stash",
    marker: "ZHS_HEALTH_OK",
  },
  CapabilitiesResponse: {
    representations: ["text", "binary"],
    contentAccess: ["inline", "raw", "deleted"],
    transferModes: ["json", "single", "multipart"],
    storageTiers: ["d1", "r2"],
    limits: {
      jsonInlineMaxBytes: 5_000_000,
      d1InlineMaxBytes: 524_288,
      httpRequestMaxBytes: 100_000_000,
      singleUploadMaxBytes: 33_554_432,
      maxFileBytes: 100_000_000,
      diffMaxBytesPerSide: 524_288,
      multipartPartBytes: 8_388_608,
      maxMultipartParts: 10_000,
      maxOpenUploadSessionsPerStash: 8,
      maxReservedUploadBytesPerStash: 500_000_000,
      uploadSessionTtlSeconds: 86_400,
    },
  },
  MeResponse: {
    principal: "stash",
    stash: "demo",
    tokenId: tokenRecord.id,
    scope: "read",
    expiresAt: tokenRecord.expiresAt,
  },
  StashRecord: stashRecord,
  StashSummary: stashSummary,
  StashListResponse: { stashes: oneStash, nextAfter: null },
  CreateStashResult: stashRecord,
  GetStashResult: stashRecord,
  DeleteStashResult: {
    name: "demo",
    deletedAt: UPDATED_AT,
    revokedTokens: 2,
    restoreUntil: "2026-09-02T01:00:00.000Z",
  },
  RestoreStashResult: stashRecord,
  GcRunResult: gcRun,
  GcRunsResponse: { runs: [gcRun] },
  StashReadyEvent: stashReadyEvent,
  StashChangeEvent: stashChangeEvent,
  StashCommitEvent: stashCommitEvent,
  StashChangeSetEvent: stashChangeSetEvent,
  StashReconnectEvent: stashReconnectEvent,
  StashEvent: stashChangeEvent,
  CommitEntryRecord: commitEntry,
  CommitRecord: commitRecord,
  CommitResult: commitRecord,
  CommitSummary: commitSummary,
  CommitListResponse: {
    commits: [commitSummary] as (typeof commitSummary)[],
    nextAfter: null,
    total: 1,
  },
  CommitDiffResult: commitDiff,
  SnapshotResponse: { at: { commitId: COMMIT_ID, changeId: 7 }, files: oneFile, nextAfter: null },
  ChangeSetRecord: changeSetRecord,
  RejectedChangeSetRecord: rejectedChangeSetRecord,
  ChangeSetListResponse: {
    changeSets: [changeSetRecord] as (typeof changeSetRecord)[],
    nextAfter: null,
    total: 1,
  },
  ChangeSetDiffResult: changeSetDiff,
  ApproveChangeSetResult: { status: "applied", commit: commitRecord },
  TokenRecord: tokenRecord,
  CreatedToken: createdToken,
  TokenListResponse: { tokens: oneToken },
  CreateTokenResult: createdToken,
  RotateTokenResult: rotatedToken,
  FileSummary: fileSummary,
  FileListResponse: { files: oneFile, nextAfter: null },
  FileRecord: fileRecord,
  VersionRecord: versionRecord,
  HistoryPage: {
    path: "docs/guide.md",
    headVersion: 3,
    deleted: false,
    total: 3,
    versions: oneVersion,
    nextBefore: null,
  },
  ChangeItem: changeItem,
  ChangesPage: { changes: oneChange, hasMore: false, nextSince: 7 },
  PutCreatedResult: {
    commitId: COMMIT_ID,
    version: 3,
    hash: HASH_A,
    size: 13,
    changeId: 7,
    createdAt: UPDATED_AT,
  },
  PutUnchangedResult: { unchanged: true, version: 3 },
  DeleteResult: { commitId: COMMIT_ID, version: 4, changeId: 8, createdAt: UPDATED_AT },
  RollbackResult: {
    commitId: COMMIT_ID,
    version: 5,
    hash: HASH_A,
    rollbackOf: 3,
    identicalToHead: false,
    changeId: 9,
    createdAt: UPDATED_AT,
  },
  ImportResult: { commitId: COMMIT_ID, path: "docs/guide.md", headVersion: 3, firstChangeId: 7 },
  DiffSide: diffSideFrom,
  DiffHunk: diffHunk,
  DiffStats: diffStats,
  DiffResult: readyDiff,
  FileDiffResult: { ...readyDiff, from: diffSideFrom, to: diffSideTo },
  Current: currentHead,
  ErrorDetail: { code: "stale", message: "Expected version is stale" },
  ErrorResponse: {
    error: { code: "stale", message: "Expected version is stale" },
    current: currentHead,
  },
  CreateUploadSessionResult: uploadSession,
  GetUploadSessionResult: { ...uploadSession, parts: noUploadParts },
  CompleteUploadResult: uploadCommitResult,
  AbortUploadResult: { id: uploadSession.id, state: "aborted" },
  ListStashesResult: { stashes: oneStash, nextAfter: null },
  ListTokensResult: { tokens: oneToken },
  ListFilesResult: { files: oneFile, nextAfter: null },
  GetFileResult: fileRecord,
  GetHistoryResult: {
    path: "docs/guide.md",
    headVersion: 3,
    deleted: false,
    total: 3,
    versions: oneVersion,
    nextBefore: null,
  },
  ListChangesResult: { changes: oneChange, hasMore: false, nextSince: 7 },
  GetDiffResult: { ...readyDiff, from: diffSideFrom, to: diffSideTo },
  CandidateDiffResult: readyDiff,
} as const;

export const SAMPLES = responseSamples satisfies {
  [K in ResponseSchemaName]: z.input<(typeof RESPONSE_SCHEMAS)[K]>;
} & {
  RejectedChangeSetRecord: z.input<(typeof RESPONSE_SCHEMAS)["ChangeSetRecord"]>;
};

export const RESPONSE_SAMPLES = SAMPLES;
