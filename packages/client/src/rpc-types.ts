import type {
  CandidateDiffResult,
  ChangesPage,
  CreateStashBody,
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
  PutFileBody,
  PutResult,
  RollbackBody,
  RollbackResult,
  RestoreStashResult,
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

/** One explicit RPC method per core route, using the same inputs and results as {@link StashClient}. */
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
