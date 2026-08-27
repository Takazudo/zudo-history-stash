import type { DiffResult } from "./diff.js";
import type { JsonValue } from "./canonical.js";

export type VersionKind = "put" | "delete" | "rollback";
export type TokenScope = "read" | "write";
export type GcKind = "r2-orphans" | "ledger";
export type ProposalStatus = "open" | "applied" | "rejected" | "expired";
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
  | "proposal-expired"
  | "proposal-closed"
  | "rate-limited"
  | "payload-too-large"
  | "idempotency-key-reused"
  | "rollback-target-tombstone"
  | "internal";

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
export interface ProposalRecord {
  id: string;
  stash: string;
  path: string;
  baseVersion: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  size: number;
  hash: string;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  appliedVersion: number | null;
  appliedChangeId: number | null;
}
export type ProposalWithBody = ProposalRecord & { body: string };
export interface ProposalListResponse {
  proposals: ProposalRecord[];
  nextAfter: string | null;
  total: number;
}
export interface ApproveProposalResult {
  status: "applied";
  appliedVersion: number;
  appliedChangeId: number;
  hash: string;
  createdAt: string;
}
export type ProposalDiffResult = DiffResult & {
  base: { version: number | null; hash: string | null; deleted: boolean };
  candidate: { hash: string; size: number };
  current: Current | null;
  stale: boolean;
};
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
export interface FileSummary {
  path: string;
  headVersion: number;
  hash: string | null;
  size: number;
  deleted: boolean;
  updatedAt: string;
}
export interface FileListResponse {
  files: FileSummary[];
  nextAfter: string | null;
}
export interface FileRecord {
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
export interface VersionRecord {
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
export interface ChangeItem {
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
  version: number;
  changeId: number;
  createdAt: string;
}
export interface RollbackResult {
  version: number;
  hash: string;
  rollbackOf: number;
  identicalToHead: boolean;
  changeId: number;
  createdAt: string;
}
export interface ImportResult {
  path: string;
  headVersion: number;
  firstChangeId: number;
}
export interface DiffSide {
  version: number;
  hash: string | null;
  deleted: boolean;
}
export type FileDiffResult = DiffResult & { from: DiffSide; to: DiffSide };
export type GetDiffResult = FileDiffResult;
export type CandidateDiffResult = DiffResult;
export type CreateProposalResult = ProposalRecord;
export type ListProposalsResult = ProposalListResponse;
export type GetProposalResult = ProposalWithBody;
export type GetProposalDiffResult = ProposalDiffResult;
export type RejectProposalResult = ProposalRecord;
export type ListStashesResult = StashListResponse;
export type ListTokensResult = TokenListResponse;
export type ListFilesResult = FileListResponse;
export type GetFileResult = FileRecord;
export type GetHistoryResult = HistoryPage;
export type ListChangesResult = ChangesPage;
