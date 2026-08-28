import type { z } from "zod";
import type { RESPONSE_SCHEMAS, ResponseSchemaName } from "./responses.js";

const CREATED_AT = "2026-08-26T00:00:00.000Z";
const UPDATED_AT = "2026-08-26T01:00:00.000Z";
const EXPIRES_AT = "2026-09-25T00:00:00.000Z";
const HASH_A = `sha256-${"a".repeat(64)}`;
const HASH_B = `sha256-${"b".repeat(64)}`;

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
  stash: "demo",
  path: "docs/guide.md",
  version: 3,
  kind: "put",
  origin: "viewer-1",
  createdAt: UPDATED_AT,
} as const;
const stashProposalEvent = {
  type: "proposal",
  proposalId: "prp_1787702400000deadbeef",
  stash: "demo",
  path: "docs/proposed.md",
  status: "open",
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

const proposalRecord = {
  id: "prp_1787702400000deadbeef",
  stash: "demo",
  path: "docs/proposed.md",
  baseVersion: 2,
  author: "review-bot",
  message: "Propose documentation update",
  meta: { source: "automation" },
  size: 22,
  hash: HASH_A,
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  status: "open",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  appliedVersion: null,
  appliedChangeId: null,
} as const;
const rejectedProposalRecord = {
  ...proposalRecord,
  status: "rejected",
  decidedAt: UPDATED_AT,
  decidedBy: "admin",
  decisionReason: "Superseded by a newer proposal",
} as const;
const oneProposal = [proposalRecord];

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

const responseSamples = {
  HealthResponse: {
    ok: true,
    service: "zudo-history-stash",
    marker: "ZHS_HEALTH_OK",
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
  StashProposalEvent: stashProposalEvent,
  StashReconnectEvent: stashReconnectEvent,
  StashEvent: stashChangeEvent,
  ProposalRecord: proposalRecord,
  RejectedProposalRecord: rejectedProposalRecord,
  ProposalWithBody: { ...proposalRecord, body: "Hello, proposed docs!\n" },
  ProposalListResponse: { proposals: oneProposal, nextAfter: null, total: 1 },
  ApproveProposalResult: {
    status: "applied",
    appliedVersion: 3,
    appliedChangeId: 8,
    hash: HASH_A,
    createdAt: UPDATED_AT,
  },
  ProposalDiffResult: {
    ...readyDiff,
    base: { version: 2, hash: HASH_B, deleted: false },
    candidate: { hash: HASH_A, size: 22 },
    current: currentHead,
    stale: true,
  },
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
    version: 3,
    hash: HASH_A,
    size: 13,
    changeId: 7,
    createdAt: UPDATED_AT,
  },
  PutUnchangedResult: { unchanged: true, version: 3 },
  DeleteResult: { version: 4, changeId: 8, createdAt: UPDATED_AT },
  RollbackResult: {
    version: 5,
    hash: HASH_A,
    rollbackOf: 3,
    identicalToHead: false,
    changeId: 9,
    createdAt: UPDATED_AT,
  },
  ImportResult: { path: "docs/guide.md", headVersion: 3, firstChangeId: 7 },
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
  RejectedProposalRecord: z.input<(typeof RESPONSE_SCHEMAS)["ProposalRecord"]>;
};

export const RESPONSE_SAMPLES = SAMPLES;
