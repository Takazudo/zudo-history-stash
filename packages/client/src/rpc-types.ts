import type {
  CandidateDiffResult,
  ApproveProposalBody,
  ChangesPage,
  CreateStashBody,
  CreateProposalBody,
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
  ParsedListProposalsQuery,
  ProposalDiffQuery,
  PutFileBody,
  PutResult,
  RollbackBody,
  RollbackResult,
  RestoreStashResult,
  RejectProposalBody,
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
}

/**
 * One explicit RPC method per core route. Proposal methods temporarily return their registered
 * HTTP skeleton response until the proposal client lifecycle is implemented.
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
  createProposal(
    token: string,
    stash: string,
    input: CreateProposalBody,
    idempotencyKey?: string,
  ): Promise<Response>;
  listProposals(
    token: string,
    stash: string,
    query?: Partial<ParsedListProposalsQuery>,
  ): Promise<Response>;
  getProposal(token: string, stash: string, id: string): Promise<Response>;
  getProposalDiff(
    token: string,
    stash: string,
    id: string,
    query?: ProposalDiffQuery,
  ): Promise<Response>;
  approveProposal(
    token: string,
    stash: string,
    id: string,
    input: ApproveProposalBody,
  ): Promise<Response>;
  rejectProposal(
    token: string,
    stash: string,
    id: string,
    input: RejectProposalBody,
  ): Promise<Response>;
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
