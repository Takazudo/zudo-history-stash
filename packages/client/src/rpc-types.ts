import type {
  CandidateDiffResult,
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  ChangesPage,
  CreateStashBody,
  CreateChangeSetBody,
  CreateCommitBody,
  CreateStashResult,
  CreateTokenBody,
  CreateTokenResult,
  DeleteStashResult,
  DeleteFileBody,
  DeleteResult,
  DiffCandidateBody,
  FileListResponse,
  GetDiffResult,
  GetHistoryResult,
  HealthResponse,
  ImportBody,
  ImportResult,
  GcRunResult,
  GcRunsResponse,
  ListChangesResult,
  ListStashesResult,
  ListTokensResult,
  MeResponse,
  ListChangeSetsQuery,
  ListCommitsQuery,
  PutFileBody,
  PutResult,
  RollbackBody,
  RollbackResult,
  RestoreStashResult,
  RejectChangeSetBody,
  RevertCommitBody,
  SnapshotQuery,
  RunGcBody,
  RotateTokenBody,
  RotateTokenResult,
  RpcRequest,
  StashRecord,
} from "@takazudo/zudo-history-stash-core";
import type {
  ChangesOptions,
  ClientResult,
  DiffOptions,
  FileGetOptions,
  FileGetResult,
  HistoryOptions,
  ListGcRunsOptions as ClientListGcRunsOptions,
  ListFilesOptions,
  ListStashesOptions,
  MutationOptions,
} from "./client.js";

/** Optional query values for the GC run history RPC. */
export type ListGcRunsOptions = ClientListGcRunsOptions;

/** Optional raw query values for the stash list RPC, including deleted-row visibility. */
export type ListStashesRpcOptions = ListStashesOptions;

/** The minimal named RPC binding exposed by the stash Worker. */
export interface StashRpcBinding {
  request(init: RpcRequest): Promise<Response>;
  /** Optional flow-controlled bridge used for request/response byte streams. */
  requestStream?(request: Request, token: string): Promise<Response>;
}

/**
 * One explicit RPC method per transport-eligible core route. Fetch-only routes remain available
 * through `request()` and are deliberately absent here. New contract routes return their
 * registered HTTP 501 skeleton response until their implementation waves land.
 */
export interface StashRpcMethods {
  health(token: string): Promise<ClientResult<HealthResponse>>;
  me(token: string): Promise<ClientResult<MeResponse>>;
  listStashes(
    token: string,
    options?: ListStashesRpcOptions,
  ): Promise<ClientResult<ListStashesResult>>;
  createStash(token: string, input: CreateStashBody): Promise<ClientResult<CreateStashResult>>;
  getStash(token: string, stash: string): Promise<ClientResult<StashRecord>>;
  deleteStash(token: string, stash: string): Promise<ClientResult<DeleteStashResult>>;
  restoreStash(token: string, stash: string): Promise<ClientResult<RestoreStashResult>>;
  createToken(
    token: string,
    stash: string,
    input: CreateTokenBody,
  ): Promise<ClientResult<CreateTokenResult>>;
  listTokens(token: string, stash: string): Promise<ClientResult<ListTokensResult>>;
  rotateToken(
    token: string,
    stash: string,
    id: string,
    input: RotateTokenBody,
  ): Promise<ClientResult<RotateTokenResult>>;
  revokeToken(token: string, stash: string, id: string): Promise<ClientResult<undefined>>;
  importHistory(
    token: string,
    stash: string,
    input: ImportBody,
  ): Promise<ClientResult<ImportResult>>;
  listChanges(token: string, options?: ChangesOptions): Promise<ClientResult<ChangesPage>>;
  runGc(token: string, input: RunGcBody): Promise<ClientResult<GcRunResult>>;
  listGcRuns(token: string, options?: ListGcRunsOptions): Promise<ClientResult<GcRunsResponse>>;
  createCommit(token: string, stash: string, input: CreateCommitBody, idempotencyKey?: string): Promise<Response>;
  getCommit(token: string, stash: string, id: string): Promise<Response>;
  listCommits(token: string, stash: string, query?: Partial<ListCommitsQuery>): Promise<Response>;
  getCommitDiff(token: string, stash: string, id: string, query?: CommitDiffQuery): Promise<Response>;
  revertCommit(token: string, stash: string, id: string, input: RevertCommitBody, idempotencyKey?: string): Promise<Response>;
  getSnapshot(token: string, stash: string, query: SnapshotQuery): Promise<Response>;
  createChangeSet(token: string, stash: string, input: CreateChangeSetBody, idempotencyKey?: string): Promise<Response>;
  listChangeSets(token: string, stash: string, query?: Partial<ListChangeSetsQuery>): Promise<Response>;
  getChangeSet(token: string, stash: string, id: string): Promise<Response>;
  getChangeSetDiff(token: string, stash: string, id: string, query?: ChangeSetDiffQuery): Promise<Response>;
  approveChangeSet(token: string, stash: string, id: string, input: ApproveChangeSetBody): Promise<Response>;
  rejectChangeSet(token: string, stash: string, id: string, input: RejectChangeSetBody): Promise<Response>;
  listFiles(
    token: string,
    stash: string,
    options?: ListFilesOptions,
  ): Promise<ClientResult<FileListResponse>>;
  getFile(
    token: string,
    stash: string,
    path: string,
    options?: FileGetOptions,
  ): Promise<FileGetResult>;
  putFile(
    token: string,
    stash: string,
    path: string,
    input: PutFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<PutResult>>;
  deleteFile(
    token: string,
    stash: string,
    path: string,
    input: DeleteFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<DeleteResult>>;
  rollbackFile(
    token: string,
    stash: string,
    path: string,
    input: RollbackBody,
    options?: MutationOptions,
  ): Promise<ClientResult<RollbackResult>>;
  getHistory(
    token: string,
    stash: string,
    path: string,
    options?: HistoryOptions,
  ): Promise<ClientResult<GetHistoryResult>>;
  getDiff(
    token: string,
    stash: string,
    path: string,
    options: DiffOptions,
  ): Promise<ClientResult<GetDiffResult>>;
  diffCandidate(
    token: string,
    stash: string,
    path: string,
    input: DiffCandidateBody,
  ): Promise<ClientResult<CandidateDiffResult>>;
  getStashChanges(
    token: string,
    stash: string,
    options?: ChangesOptions,
  ): Promise<ClientResult<ListChangesResult>>;
}

/** The complete type of the named RPC entrypoint bound by a consumer Worker. */
export type StashRpcEntrypoint = StashRpcBinding & StashRpcMethods;
