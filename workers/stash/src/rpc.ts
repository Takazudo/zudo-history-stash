import {
  createStashClient,
  parseClientResponse,
  type ChangesOptions,
  type ClientResult,
  type DiffOptions,
  type FileGetOptions,
  type FileGetResult,
  type HistoryOptions,
  type ListGcRunsOptions,
  type ListFilesOptions,
  type ListStashesRpcOptions,
  type MutationOptions,
  type StashRpcMethods,
} from "@takazudo/zudo-history-stash";
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
  ListChangeSetsQuery,
  ListCommitsQuery,
  ListStashesResult,
  ListTokensResult,
  MeResponse,
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
  RpcRouteId,
  RpcRequest,
  StashRecord,
} from "@takazudo/zudo-history-stash-core";
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app.js";
import type { Env } from "./env.js";

function acceptsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function requestUrl(init: RpcRequest): string {
  const query = new URLSearchParams(init.query).toString();
  return `https://stash.internal${init.path}${query === "" ? "" : `?${query}`}`;
}

function optionalQuery(
  values: Record<string, string | number | boolean | undefined>,
): Record<string, string> | undefined {
  const query = Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  return Object.keys(query).length === 0 ? undefined : query;
}

export class StashRpc extends WorkerEntrypoint<Env> implements StashRpcMethods {
  /**
   * Flow-controlled RPC bridge for raw upload/download bodies. Request and Response are RPC-aware
   * types, so their streams are not serialized into the RPC value payload.
   */
  async requestStream(request: Request, token: string): Promise<Response> {
    request.headers.delete("authorization");
    request.headers.set("Authorization", `Bearer ${token}`);
    return app.fetch(request, this.env, this.ctx);
  }

  async request(init: RpcRequest): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    headers.set("Authorization", `Bearer ${init.token}`);
    const request = new Request(requestUrl(init), {
      method: init.method,
      headers,
      body: acceptsBody(init.method) ? init.body : undefined,
    });
    return app.fetch(request, this.env, this.ctx);
  }

  async health(token: string): Promise<ClientResult<HealthResponse>> {
    return noThrow(() => rpcClient(this, token).health());
  }

  async me(token: string): Promise<ClientResult<MeResponse>> {
    return noThrow(() => rpcClient(this, token).me());
  }

  async listStashes(
    token: string,
    options: ListStashesRpcOptions = {},
  ): Promise<ClientResult<ListStashesResult>> {
    return noThrow(() => rpcClient(this, token).stashes.list(options));
  }

  async createStash(
    token: string,
    input: CreateStashBody,
  ): Promise<ClientResult<CreateStashResult>> {
    return noThrow(() => rpcClient(this, token).stashes.create(input));
  }

  async getStash(token: string, stash: string): Promise<ClientResult<StashRecord>> {
    return noThrow(() => rpcClient(this, token).stashes.get(stash));
  }

  async deleteStash(token: string, stash: string): Promise<ClientResult<DeleteStashResult>> {
    return noThrow(() => rpcClient(this, token).stashes.delete(stash));
  }

  async restoreStash(token: string, stash: string): Promise<ClientResult<RestoreStashResult>> {
    return noThrow(() => rpcClient(this, token).stashes.restore(stash));
  }

  async createToken(
    token: string,
    stash: string,
    input: CreateTokenBody,
  ): Promise<ClientResult<CreateTokenResult>> {
    return noThrow(() => rpcClient(this, token).stashes.tokens(stash).create(input));
  }

  async listTokens(token: string, stash: string): Promise<ClientResult<ListTokensResult>> {
    return noThrow(() => rpcClient(this, token).stashes.tokens(stash).list());
  }

  async rotateToken(
    token: string,
    stash: string,
    id: string,
    input: RotateTokenBody,
  ): Promise<ClientResult<RotateTokenResult>> {
    return noThrow(async () => {
      const response = await this.request({
        method: "POST",
        path: `/v1/stashes/${stash}/tokens/${id}/rotate`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        token,
      });
      return (await parseClientResponse<RotateTokenResult>(
        response,
        "rotateToken",
      )) as ClientResult<RotateTokenResult>;
    });
  }

  async revokeToken(token: string, stash: string, id: string): Promise<ClientResult<undefined>> {
    return noThrow(() => rpcClient(this, token).stashes.tokens(stash).revoke(id));
  }

  async importHistory(
    token: string,
    stash: string,
    input: ImportBody,
  ): Promise<ClientResult<ImportResult>> {
    return noThrow(() => rpcClient(this, token).stashes.import(stash, input));
  }

  async listChanges(token: string, options?: ChangesOptions): Promise<ClientResult<ChangesPage>> {
    return noThrow(() => rpcClient(this, token).changes(options));
  }

  async runGc(token: string, input: RunGcBody): Promise<ClientResult<GcRunResult>> {
    return noThrow(() => rpcClient(this, token).admin.gc.run(input));
  }

  async listGcRuns(
    token: string,
    options: ListGcRunsOptions = {},
  ): Promise<ClientResult<GcRunsResponse>> {
    return noThrow(() => rpcClient(this, token).admin.gc.runs(options));
  }

  async createCommit(token: string, stash: string, input: CreateCommitBody, idempotencyKey?: string): Promise<Response> { return this.jsonSkeleton("POST", `/v1/stashes/${stash}/commits`, token, input, idempotencyKey); }
  async getCommit(token: string, stash: string, id: string): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/commits/${id}`, token }); }
  async listCommits(token: string, stash: string, query: Partial<ListCommitsQuery> = {}): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/commits`, query: optionalQuery(query), token }); }
  async getCommitDiff(token: string, stash: string, id: string, query: CommitDiffQuery = {}): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/commits/${id}/diff`, query: optionalQuery(query), token }); }
  async revertCommit(token: string, stash: string, id: string, input: RevertCommitBody, idempotencyKey?: string): Promise<Response> { return this.jsonSkeleton("POST", `/v1/stashes/${stash}/commits/${id}/revert`, token, input, idempotencyKey); }
  async getSnapshot(token: string, stash: string, query: SnapshotQuery): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/snapshot`, query: optionalQuery(query), token }); }
  async createChangeSet(token: string, stash: string, input: CreateChangeSetBody, idempotencyKey?: string): Promise<Response> { return this.jsonSkeleton("POST", `/v1/stashes/${stash}/change-sets`, token, input, idempotencyKey); }
  async listChangeSets(token: string, stash: string, query: Partial<ListChangeSetsQuery> = {}): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/change-sets`, query: optionalQuery(query), token }); }
  async getChangeSet(token: string, stash: string, id: string): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/change-sets/${id}`, token }); }
  async getChangeSetDiff(token: string, stash: string, id: string, query: ChangeSetDiffQuery = {}): Promise<Response> { return this.request({ method: "GET", path: `/v1/stashes/${stash}/change-sets/${id}/diff`, query: optionalQuery(query), token }); }
  async approveChangeSet(token: string, stash: string, id: string, input: ApproveChangeSetBody): Promise<Response> { return this.jsonSkeleton("POST", `/v1/stashes/${stash}/change-sets/${id}/approve`, token, input); }
  async rejectChangeSet(token: string, stash: string, id: string, input: RejectChangeSetBody): Promise<Response> { return this.jsonSkeleton("POST", `/v1/stashes/${stash}/change-sets/${id}/reject`, token, input); }

  private jsonSkeleton(method: "POST", path: string, token: string, input: unknown, idempotencyKey?: string): Promise<Response> {
    return this.request({ method, path, headers: { "Content-Type": "application/json", ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }) }, body: JSON.stringify(input), token });
  }

  async listFiles(
    token: string,
    stash: string,
    options?: ListFilesOptions,
  ): Promise<ClientResult<FileListResponse>> {
    return noThrow(() => rpcClient(this, token).files(stash).list(options));
  }

  async getFile(
    token: string,
    stash: string,
    path: string,
    options?: FileGetOptions,
  ): Promise<FileGetResult> {
    return noThrowFile(() => rpcClient(this, token).files(stash).get(path, options));
  }

  async putFile(
    token: string,
    stash: string,
    path: string,
    input: PutFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<PutResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).put(path, input, options));
  }

  async deleteFile(
    token: string,
    stash: string,
    path: string,
    input: DeleteFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<DeleteResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).delete(path, input, options));
  }

  async rollbackFile(
    token: string,
    stash: string,
    path: string,
    input: RollbackBody,
    options?: MutationOptions,
  ): Promise<ClientResult<RollbackResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).rollback(path, input, options));
  }

  async getHistory(
    token: string,
    stash: string,
    path: string,
    options?: HistoryOptions,
  ): Promise<ClientResult<GetHistoryResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).history(path, options));
  }

  async getDiff(
    token: string,
    stash: string,
    path: string,
    options: DiffOptions,
  ): Promise<ClientResult<GetDiffResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).diff(path, options));
  }

  async diffCandidate(
    token: string,
    stash: string,
    path: string,
    input: DiffCandidateBody,
  ): Promise<ClientResult<CandidateDiffResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).diffCandidate(path, input));
  }

  async getStashChanges(
    token: string,
    stash: string,
    options?: ChangesOptions,
  ): Promise<ClientResult<ListChangesResult>> {
    return noThrow(() => rpcClient(this, token).files(stash).changes(options));
  }
}

function rpcClient(binding: StashRpc, token: string) {
  return createStashClient({ transport: { kind: "rpc", binding, token } });
}

function internalFailure(error: unknown): ClientResult<never> {
  return {
    ok: false,
    error: {
      code: "internal",
      status: 500,
      message: error instanceof Error ? error.message : "An internal error occurred.",
    },
  };
}

async function noThrow<T>(run: () => Promise<ClientResult<T>>): Promise<ClientResult<T>> {
  try {
    return await run();
  } catch (error) {
    return internalFailure(error);
  }
}

async function noThrowFile(run: () => Promise<FileGetResult>): Promise<FileGetResult> {
  try {
    return await run();
  } catch (error) {
    return internalFailure(error);
  }
}

const rpcMethodsByRoute = {
  health: "health",
  me: "me",
  listStashes: "listStashes",
  createStash: "createStash",
  getStash: "getStash",
  deleteStash: "deleteStash",
  restoreStash: "restoreStash",
  createToken: "createToken",
  listTokens: "listTokens",
  rotateToken: "rotateToken",
  revokeToken: "revokeToken",
  importHistory: "importHistory",
  listChanges: "listChanges",
  runGc: "runGc",
  listGcRuns: "listGcRuns",
  createCommit: "createCommit",
  getCommit: "getCommit",
  listCommits: "listCommits",
  getCommitDiff: "getCommitDiff",
  revertCommit: "revertCommit",
  getSnapshot: "getSnapshot",
  createChangeSet: "createChangeSet",
  listChangeSets: "listChangeSets",
  getChangeSet: "getChangeSet",
  getChangeSetDiff: "getChangeSetDiff",
  approveChangeSet: "approveChangeSet",
  rejectChangeSet: "rejectChangeSet",
  listFiles: "listFiles",
  getFile: "getFile",
  putFile: "putFile",
  deleteFile: "deleteFile",
  rollbackFile: "rollbackFile",
  getHistory: "getHistory",
  getDiff: "getDiff",
  diffCandidate: "diffCandidate",
  getStashChanges: "getStashChanges",
} as const satisfies Record<RpcRouteId, keyof StashRpcMethods>;

void rpcMethodsByRoute;

type MappedRpcMethod = (typeof rpcMethodsByRoute)[keyof typeof rpcMethodsByRoute];
const rpcMethodCoverage: Record<Exclude<keyof StashRpcMethods, MappedRpcMethod>, never> = {};
void rpcMethodCoverage;
