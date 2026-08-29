import type { DiffResult } from "./diff.js";
import type { JsonValue } from "./canonical.js";
import type {
  ContentAccess,
  Representation,
  StorageTier,
  UploadMode,
  ResolvedContent,
} from "./binary.js";
import type { UploadCompletionResult, UploadPartRecord, UploadSessionRecord } from "./upload.js";

export type VersionKind = "put" | "delete" | "rollback";
export type TokenScope = "read" | "write";
export type GcKind = "r2-orphans" | "ledger";
export type ChangeSetStatus = "open" | "applied" | "rejected" | "expired";
export type ReconnectReason = "lifetime" | "replay-limit" | "shutdown";

export interface StashReadyEvent {
  type: "ready";
  head: number | null;
  checkpoint: number | null;
}

export interface StashChangeEvent {
  type: "change";
  changeId: number;
  commitId: string;
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  origin: string | null;
  createdAt: string;
}

export interface StashCommitEvent {
  type: "commit";
  commitId: string;
  stash: string;
  entryCount: number;
  firstChangeId: number;
  lastChangeId: number;
  origin: string | null;
}
export interface StashChangeSetEvent {
  type: "change-set";
  changeSetId: string;
  stash: string;
  status: ChangeSetStatus;
  paths: string[];
  origin: string | null;
}

export interface StashReconnectEvent {
  type: "reconnect";
  reason: ReconnectReason;
}

/** One validated advisory event yielded by the fetch-only live stream. */
export type StashEvent =
  StashReadyEvent | StashChangeEvent | StashCommitEvent | StashChangeSetEvent | StashReconnectEvent;

/** Stream lifecycle state. Client packages bind the failure parameter to their HTTP error type. */
export type LiveStatus<Failure = unknown> =
  "connecting" | "live" | "reconnecting" | "closed" | { failed: Failure };
export type ErrorCode =
  | "validation"
  | "invalid-path"
  | "body-not-well-formed"
  | "unauthorized"
  | "scope"
  | "not-found"
  | "file-deleted"
  | "version-not-found"
  | "stale"
  | "exists"
  | "already-deleted"
  | "gc-busy"
  | "already-rotated"
  | "token-expired"
  | "commit-conflict"
  | "change-set-expired"
  | "change-set-closed"
  | "rate-limited"
  | "payload-too-large"
  | "idempotency-key-reused"
  | "rollback-target-tombstone"
  | "unsupported-representation"
  | "upload-session-not-open"
  | "upload-session-expired"
  | "upload-size-mismatch"
  | "upload-hash-mismatch"
  | "range-not-satisfiable"
  | "internal";

/**
 * Additive byte metadata. Fields are optional on the legacy JSON model so existing callers remain
 * source-compatible; servers fill the documented text/inline defaults for pre-migration rows.
 */
export interface CompatibleContentMetadata {
  representation?: Representation;
  contentAccess?: ContentAccess;
  contentType?: string;
  byteSize?: number;
  etag?: string | null;
}

export interface CapabilitiesResponse {
  representations: readonly Representation[];
  contentAccess: readonly ContentAccess[];
  transferModes: readonly ["json", "single", "multipart"];
  storageTiers: readonly StorageTier[];
  commitEntryKinds: readonly ["put", "copy", "delete", "rollback"];
  limits: {
    jsonInlineMaxBytes: number;
    d1InlineMaxBytes: number;
    httpRequestMaxBytes: number;
    singleUploadMaxBytes: number;
    maxFileBytes: number;
    diffMaxBytesPerSide: number;
    multipartPartBytes: number;
    maxMultipartParts: 10_000;
    maxOpenUploadSessionsPerStash: number;
    maxReservedUploadBytesPerStash: number;
    uploadSessionTtlSeconds: number;
  };
}

export interface Current {
  version: number;
  hash: string | null;
  deleted: boolean;
  kind: VersionKind;
  author: string;
  createdAt: string;
}
export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  successorId?: string;
}
export interface ErrorResponse {
  error: ErrorDetail;
  current?: Current;
  conflicts?: CommitConflict[];
}
export interface ApiError extends ErrorDetail {
  status: number;
}
export type Result<T, E = ApiError> =
  { ok: true; value: T } | { ok: false; error: E; current?: Current };

export interface HealthResponse {
  ok: true;
  service: "zudo-history-stash";
  marker: "ZHS_HEALTH_OK";
}
export type MeResponse =
  | { principal: "admin" }
  | {
      principal: "stash";
      stash: string;
      tokenId: string;
      scope: TokenScope;
      expiresAt: string | null;
    };
export interface StashRecord {
  name: string;
  description: string;
  meta: Record<string, JsonValue>;
  fileCount: number;
  deletedFileCount: number;
  lastChangeId: number | null;
  lastChangeAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  restoreUntil: string | null;
  restorable: boolean;
}
export type StashSummary = Omit<StashRecord, "meta">;
export interface StashListResponse {
  stashes: StashSummary[];
  nextAfter: string | null;
}
export type CreateStashResult = StashRecord;
export type GetStashResult = StashRecord;
export interface DeleteStashResult {
  name: string;
  deletedAt: string;
  revokedTokens: number;
  restoreUntil: string;
}
export type RestoreStashResult = StashRecord;
export interface GcRunResult {
  runId: string;
  jobId: GcKind;
  kind: GcKind;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  deleted: number;
  cursor: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface GcRunsResponse {
  runs: GcRunResult[];
}
export interface CommitConflict {
  path: string;
  expectedVersion: number | null;
  current: Current | null;
}
export interface CommitEntryRecord {
  path: string;
  op: "put" | "copy" | "delete" | "rollback";
  version: number;
  kind: VersionKind;
  changeId: number;
  hash: string | null;
  size: number;
  contentType: string;
  representation: Representation;
  storageTier?: StorageTier;
  rollbackOf: number | null;
  copiedFrom?: { path: string; version: number };
  identicalToHead?: boolean;
}
export interface CommitRecord {
  id: string;
  stash: string;
  source: string;
  sourceId: string | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  entryCount: number;
  firstChangeId: number;
  lastChangeId: number;
  revertsCommitId: string | null;
  createdBy: string;
  createdAt: string;
  entries: CommitEntryRecord[];
}
export type CommitResult = CommitRecord & { skipped?: { path: string; reason: string }[] };
export type CommitSummary = Omit<CommitRecord, "entries">;
export interface CommitListResponse {
  commits: CommitSummary[];
  nextAfter: string | null;
  total: number;
}
export interface CommitDiffEntry {
  path: string;
  op: CommitEntryRecord["op"];
  from: { version: number; hash: string | null } | null;
  to: { version: number; hash: string | null };
  diff: DiffResult | { state: "binary" | "oversized" };
}
export interface CommitDiffResult {
  entries: CommitDiffEntry[];
  truncated: boolean;
}
export interface SnapshotResponse {
  at: { commitId: string; changeId: number };
  files: FileSummary[];
  commonPrefixes?: string[];
  nextAfter: string | null;
}
export interface ChangeSetEntryRecord {
  path: string;
  op: CommitEntryRecord["op"];
  baseVersion: number | null;
  current: Current | null;
  stale: boolean;
}
export interface ChangeSetRecord {
  id: string;
  stash: string;
  status: ChangeSetStatus;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  commitId: string | null;
  entries: ChangeSetEntryRecord[];
}
export interface ChangeSetListResponse {
  changeSets: ChangeSetRecord[];
  nextAfter: string | null;
  total: number;
}
export interface ChangeSetDiffResult {
  entries: Array<{
    path: string;
    op: CommitEntryRecord["op"];
    base: Current | null;
    candidate: Current | null;
    current: Current | null;
    stale: boolean;
    diff:
      | Exclude<DiffResult, { state: "binary" }>
      | {
          state: "binary";
          base: { hash: string; size: number } | null;
          candidate: { hash: string; size: number } | null;
        }
      | { state: "oversized" };
  }>;
  stale: boolean;
  status: ChangeSetStatus;
  truncated: boolean;
}
export interface ApproveChangeSetResult {
  status: "applied";
  commit: CommitResult;
}
export interface TokenRecord {
  id: string;
  label: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string | null;
  rotatedFrom: string | null;
  rotatedTo: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}
export interface CreatedToken extends Omit<
  TokenRecord,
  "expiresAt" | "rotatedFrom" | "rotatedTo" | "revokedAt" | "lastUsedAt"
> {
  token: string;
  expiresAt: string | null;
  rotatedFrom: string | null;
}
export interface TokenListResponse {
  tokens: TokenRecord[];
}
export type CreateTokenResult = CreatedToken;
export type RotateTokenResult = CreatedToken & {
  predecessor: { id: string; expiresAt: string | null };
};
export type RevokeTokenResult = undefined;
export interface FileSummary extends CompatibleContentMetadata {
  path: string;
  headVersion: number;
  hash: string | null;
  size: number;
  deleted: boolean;
  updatedAt: string;
}
export interface FileListResponse {
  files: FileSummary[];
  commonPrefixes?: string[];
  nextAfter: string | null;
}
export interface FileRecord extends CompatibleContentMetadata {
  path: string;
  version: number;
  hash: string | null;
  size: number;
  kind: VersionKind;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: string;
  deleted: boolean;
  body: string | null;
}
export type ResolvedFileRecord = Omit<
  FileRecord,
  "body" | "deleted" | "contentAccess" | "representation"
> &
  ResolvedContent;
export interface VersionRecord extends CompatibleContentMetadata {
  commitId: string;
  version: number;
  kind: VersionKind;
  hash: string | null;
  size: number;
  rollbackOf: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: string;
}
export interface HistoryPage {
  path: string;
  headVersion: number;
  deleted: boolean;
  total: number;
  versions: VersionRecord[];
  nextBefore: number | null;
}
export interface ChangeItem extends CompatibleContentMetadata {
  commitId: string;
  changeId: number;
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  author: string;
  message: string;
  size: number;
  createdAt: string;
}
interface ChangesPageBase {
  changes: ChangeItem[];
  hasMore: boolean;
}
export type ChangesPage = ChangesPageBase &
  (
    | { nextSince: number | null; nextBefore?: never }
    | { nextBefore: number | null; nextSince?: never }
  );
export interface PutCreatedResult {
  commitId: string;
  version: number;
  hash: string;
  size: number;
  changeId: number;
  createdAt: string;
}
export interface PutUnchangedResult {
  unchanged: true;
  version: number;
}
export type PutResult = PutCreatedResult | PutUnchangedResult;
export interface DeleteResult {
  commitId: string;
  version: number;
  changeId: number;
  createdAt: string;
}
export interface RollbackResult {
  commitId: string;
  version: number;
  hash: string;
  rollbackOf: number;
  identicalToHead: boolean;
  changeId: number;
  createdAt: string;
  representation?: Representation;
  contentType?: string;
  byteSize?: number;
  etag?: string;
}
export interface ImportResult {
  commitId: string;
  path: string;
  headVersion: number;
  firstChangeId: number;
}
export interface DiffSide extends CompatibleContentMetadata {
  version: number;
  hash: string | null;
  deleted: boolean;
}
export type FileDiffResult = DiffResult & { from: DiffSide; to: DiffSide };
export type GetDiffResult = FileDiffResult;
export type CandidateDiffResult = DiffResult;
export type CreateUploadSessionResult = UploadSessionRecord;
export type GetUploadSessionResult = UploadSessionRecord & { parts: UploadPartRecord[] };
export type CompleteUploadResult = UploadCompletionResult;
export interface AbortUploadResult {
  id: string;
  state: "aborted";
}
export interface CreateUploadSessionInput {
  expectedVersion: number | null;
  size: number;
  hash?: string;
  representation: Representation;
  contentType: string;
  mode?: UploadMode | "auto";
  resumable?: boolean;
  skipIfUnchanged?: boolean;
}
export type CreateCommitResult = CommitResult;
export type GetCommitResult = CommitRecord;
export type ListCommitsResult = CommitListResponse;
export type GetCommitDiffResult = CommitDiffResult;
export type RevertCommitResult = CommitResult;
export type GetSnapshotResult = SnapshotResponse;
export type CreateChangeSetResult = ChangeSetRecord;
export type ListChangeSetsResult = ChangeSetListResponse;
export type GetChangeSetResult = ChangeSetRecord;
export type GetChangeSetDiffResult = ChangeSetDiffResult;
export type RejectChangeSetResult = ChangeSetRecord;
export type ListStashesResult = StashListResponse;
export type ListTokensResult = TokenListResponse;
export type ListFilesResult = FileListResponse;
export type GetFileResult = FileRecord;
export type GetHistoryResult = HistoryPage;
export type ListChangesResult = ChangesPage;
