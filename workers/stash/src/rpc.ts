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
  RouteId,
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

export class StashRpc extends WorkerEntrypoint<Env> implements StashRpcMethods {
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
    const query: Record<string, string> = {};
    if (options.limit !== undefined) query.limit = String(options.limit);
    if (options.after !== undefined) query.after = options.after;
    if (options.includeDeleted !== undefined) query.includeDeleted = String(options.includeDeleted);
    return rpcRequest(this, "listStashes", {
      method: "GET",
      path: "/v1/stashes",
      ...(Object.keys(query).length === 0 ? {} : { query }),
      token,
    });
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
    return rpcRequest(this, "deleteStash", {
      method: "DELETE",
      path: `/v1/stashes/${stash}`,
      token,
    });
  }

  async restoreStash(token: string, stash: string): Promise<ClientResult<RestoreStashResult>> {
    return rpcRequest(this, "restoreStash", {
      method: "POST",
      path: `/v1/stashes/${stash}/restore`,
      token,
    });
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
    return rpcRequest(this, "runGc", {
      method: "POST",
      path: "/v1/admin/gc",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      token,
    });
  }

  async listGcRuns(
    token: string,
    options: ListGcRunsOptions = {},
  ): Promise<ClientResult<GcRunsResponse>> {
    const query: Record<string, string> = {};
    if (options.kind !== undefined) query.kind = options.kind;
    if (options.limit !== undefined) query.limit = String(options.limit);
    return rpcRequest(this, "listGcRuns", {
      method: "GET",
      path: "/v1/admin/gc/runs",
      ...(Object.keys(query).length === 0 ? {} : { query }),
      token,
    });
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

async function rpcRequest<T>(
  binding: StashRpc,
  routeId: RouteId,
  init: RpcRequest,
): Promise<ClientResult<T>> {
  return noThrow(async () => {
    return (await parseClientResponse<T>(await binding.request(init), routeId)) as ClientResult<T>;
  });
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
  listFiles: "listFiles",
  getFile: "getFile",
  putFile: "putFile",
  deleteFile: "deleteFile",
  rollbackFile: "rollbackFile",
  getHistory: "getHistory",
  getDiff: "getDiff",
  diffCandidate: "diffCandidate",
  getStashChanges: "getStashChanges",
} as const satisfies Record<RouteId, keyof StashRpc>;

void rpcMethodsByRoute;
