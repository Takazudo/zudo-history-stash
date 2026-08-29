import {
  ROUTES,
  STASH_CLIENT_ID_HEADER,
  isStashClientId,
  routeAcceptsClientId,
  statusForCode,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";
import type {
  ApiError,
  CandidateDiffResult,
  CapabilitiesResponse,
  ChangesPage,
  CompleteUploadResult,
  CreateStashBody,
  CreateStashResult,
  CreateTokenBody,
  CreateTokenResult,
  Current,
  DeleteStashResult,
  DeleteFileBody,
  DeleteResult,
  DiffCandidateBody,
  ErrorCode,
  FileListResponse,
  FileRecord,
  FileGetQuery,
  GcRunResult,
  GcRunsResponse,
  GetDiffResult,
  GetHistoryResult,
  HealthResponse,
  HistoryQuery,
  ImportBody,
  ImportResult,
  ParsedListGcRunsQuery,
  ListChangesResult,
  ListFilesQuery,
  ParsedListStashesQuery,
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
  RouteMethod,
  StashRecord,
} from "@takazudo/zudo-history-stash-core";
import {
  createUploadSessionsClient,
  getRaw,
  upload,
  type BinaryClientContext,
  type RawDownloadOptions,
  type RawDownloadResult,
  type StashUploadSessionsClient,
  type UploadOptions,
  type UploadSource,
} from "./binary.js";
import type { StashRpcBinding } from "./rpc-types.js";
import { createStashEventStream, type EventsOptions, type StashEventStream } from "./events.js";
import { parseClientResponse, StashHttpError } from "./parse.js";
import {
  createFetchSend,
  createRpcSend,
  type Send,
  type StashFetch,
  type TransportQuery,
} from "./transport.js";

export { ROUTES, validatePath, validateStashName } from "@takazudo/zudo-history-stash-core";
export type { StashFetch } from "./transport.js";

/** Configuration for the existing fetch transport. */
export interface StashFetchClientOptions {
  baseUrl: string;
  token?: string;
  clientId?: string;
  fetch?: StashFetch;
  idempotencyKey?: () => string | Promise<string>;
  transport?: { kind: "fetch" };
}

/** Configuration for an in-process Worker RPC binding. */
export interface StashRpcClientOptions {
  transport: { kind: "rpc"; binding: StashRpcBinding; token: string };
  clientId?: string;
  baseUrl?: never;
  token?: never;
  fetch?: never;
  idempotencyKey?: never;
}

/** Configuration for {@link createStashClient}. */
export type StashClientOptions = StashFetchClientOptions | StashRpcClientOptions;

function isRpcClientOptions(options: StashClientOptions): options is StashRpcClientOptions {
  return options.transport?.kind === "rpc";
}

/** An optional key for a mutation that should be safely replayable. */
export interface MutationOptions {
  idempotencyKey?: string;
}

/** A successful result, with replay metadata when the server replayed a ledger entry. */
export type ClientSuccess<T> = { ok: true; value: T; replayed?: true };

/** A typed business failure returned without throwing. */
export type ClientFailure<Code extends ErrorCode = ErrorCode> = {
  ok: false;
  error: Omit<ApiError, "code"> & { code: Code };
  current?: Current;
  retryAfter?: number;
};

/** A client-facing business result. HTTP 4xx responses remain values, not thrown errors. */
export type ClientResult<T> = ClientSuccess<T> | ClientFailure;

/** A representation cache hit. This is deliberately separate from a file value. */
export type NotModifiedResult = { ok: true; notModified: true };

/** The file representation returned by `files.get`, including its response ETag. */
export type FileRecordWithEtag = FileRecord & { etag: string };

/** Result returned by `files.get`, including the distinct 304 branch. */
export type FileGetResult = ClientResult<FileRecordWithEtag> | NotModifiedResult;

/** Options for listing stashes. */
export type ListStashesOptions = Partial<ParsedListStashesQuery>;
/** Options for listing garbage-collection run history. */
export type ListGcRunsOptions = Partial<ParsedListGcRunsQuery>;
/** Options for listing files. */
export type ListFilesOptions = Partial<ListFilesQuery>;
/** Options for a change feed. */
export type ChangesOptions = {
  since?: number;
  before?: number;
  limit?: number;
};
/** Options for reading one representation. */
export type FileGetOptions = Partial<FileGetQuery> & { ifNoneMatch?: string };
/** Options for file history. */
export type HistoryOptions = Partial<HistoryQuery>;
/** Options for a stored diff. */
export interface DiffOptions {
  from: number;
  to: number | "head";
  context?: number;
  maxUnifiedBytes?: number;
}

/** The input accepted by `putLatest`. */
export type PutLatestOptions = Omit<PutFileBody, "body" | "expectedVersion"> & {
  retries?: number;
};

type RouteTemplate = Record<RouteId, string>;

type RequestTarget = {
  path: string;
  query?: TransportQuery;
};

const routeTemplates = Object.fromEntries(
  ROUTES.map((route) => [route.id, route.template]),
) as RouteTemplate;

const mutationRouteIds = new Set<RouteId>(ROUTES.filter(routeAcceptsClientId).map(({ id }) => id));

/**
 * The route set used by this package. It is exported so contract tests can assert that the SDK
 * never invents an endpoint outside the core route table.
 */
export const CLIENT_ROUTES = ROUTES;

function route(id: RouteId, stash?: string, operationPath?: string, tokenId?: string): string {
  let template = routeTemplates[id];
  if (stash !== undefined) template = template.replace(":stash", stash);
  if (tokenId !== undefined) template = template.replace(":id", tokenId);
  if (operationPath !== undefined) template = template.replace("*path", operationPath);
  return template;
}

function target(
  path: string,
  entries: readonly (readonly [string, string | number | boolean | undefined])[] = [],
): RequestTarget {
  const query: TransportQuery = {};
  for (const [key, value] of entries) {
    if (value !== undefined) query[key] = String(value);
  }
  return Object.keys(query).length === 0 ? { path } : { path, query };
}

function validationResult<T>(
  code: "invalid-path" | "validation",
  message: string,
): ClientResult<T> {
  return {
    ok: false,
    error: { code, message, status: statusForCode(code) },
  };
}

function validateStash<T>(stash: string): ClientResult<T> | undefined {
  const result = validateStashName(stash);
  return result.ok ? undefined : validationResult(result.error, result.message);
}

function validateFilePath<T>(path: string): ClientResult<T> | undefined {
  const result = validatePath(path);
  return result.ok ? undefined : validationResult(result.error, result.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function requestHeaders(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | undefined,
  ifNoneMatch: string | undefined,
  clientId: string | undefined,
  routeId: RouteId,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  if (ifNoneMatch !== undefined) headers["If-None-Match"] = ifNoneMatch;
  if (clientId !== undefined && mutationRouteIds.has(routeId)) {
    headers[STASH_CLIENT_ID_HEADER] = clientId;
  }
  return headers;
}

async function request<T>(
  send: Send,
  authorizationToken: string | undefined,
  routeId: RouteId,
  method: RouteMethod,
  requestTarget: RequestTarget,
  body?: unknown,
  idempotencyKey?: string,
  ifNoneMatch?: string,
  clientId?: string,
): Promise<ClientResult<T> | NotModifiedResult> {
  let response: Response;
  try {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    response = await send(
      method,
      requestTarget.path,
      requestTarget.query,
      requestHeaders(authorizationToken, body, idempotencyKey, ifNoneMatch, clientId, routeId),
      serializedBody,
    );
  } catch (error) {
    throw new StashHttpError(0, undefined, undefined, error);
  }

  return parseClientResponse<T>(response, routeId);
}

async function mintKey(
  factory: () => string | Promise<string>,
  supplied: string | undefined,
): Promise<string> {
  return supplied === undefined ? await factory() : supplied;
}

function getFileVersion(result: FileGetResult): number | null | undefined {
  if (result.ok) return "notModified" in result ? undefined : result.value.version;
  if (result.error.code === "not-found") return null;
  return result.current?.version;
}

/** The token operations for one stash. */
export interface StashTokensClient {
  create(input: CreateTokenBody): Promise<ClientResult<CreateTokenResult>>;
  list(): Promise<ClientResult<ListTokensResult>>;
  rotate(id: string, input: RotateTokenBody): Promise<ClientResult<RotateTokenResult>>;
  revoke(id: string): Promise<ClientResult<undefined>>;
}

/** The operations scoped to one stash's files. */
export interface StashFilesClient {
  events(options?: EventsOptions): StashEventStream;
  get(path: string, options?: FileGetOptions): Promise<FileGetResult>;
  put(
    path: string,
    input: PutFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<PutResult>>;
  delete(
    path: string,
    input: DeleteFileBody,
    options?: MutationOptions,
  ): Promise<ClientResult<DeleteResult>>;
  rollback(
    path: string,
    input: RollbackBody,
    options?: MutationOptions,
  ): Promise<ClientResult<RollbackResult>>;
  list(options?: ListFilesOptions): Promise<ClientResult<FileListResponse>>;
  history(path: string, options?: HistoryOptions): Promise<ClientResult<GetHistoryResult>>;
  diff(path: string, options: DiffOptions): Promise<ClientResult<GetDiffResult>>;
  diffCandidate(path: string, input: DiffCandidateBody): Promise<ClientResult<CandidateDiffResult>>;
  changes(options?: ChangesOptions): Promise<ClientResult<ListChangesResult>>;
  raw: {
    get(path: string, options?: RawDownloadOptions): Promise<RawDownloadResult>;
    head(path: string, options?: RawDownloadOptions): Promise<RawDownloadResult>;
  };
  upload(
    path: string,
    source: UploadSource,
    options: UploadOptions,
  ): Promise<ClientResult<CompleteUploadResult>>;
  uploads: StashUploadSessionsClient;
}

/** Administrative garbage-collection operations. */
export interface StashGcClient {
  run(input: RunGcBody): Promise<ClientResult<GcRunResult>>;
  runs(options?: ListGcRunsOptions): Promise<ClientResult<GcRunsResponse>>;
}

/** Administrative operations that are not scoped to one stash. */
export interface StashAdminClient {
  gc: StashGcClient;
}

/** The complete typed client returned by {@link createStashClient}. */
export interface StashClient {
  health(): Promise<ClientResult<HealthResponse>>;
  capabilities(): Promise<ClientResult<CapabilitiesResponse>>;
  me(): Promise<ClientResult<MeResponse>>;
  stashes: {
    list(options?: ListStashesOptions): Promise<ClientResult<ListStashesResult>>;
    create(input: CreateStashBody): Promise<ClientResult<CreateStashResult>>;
    get(stash: string): Promise<ClientResult<StashRecord>>;
    delete(stash: string): Promise<ClientResult<DeleteStashResult>>;
    restore(stash: string): Promise<ClientResult<RestoreStashResult>>;
    tokens(stash: string): StashTokensClient;
    import(stash: string, input: ImportBody): Promise<ClientResult<ImportResult>>;
  };
  admin: StashAdminClient;
  changes(options?: ChangesOptions): Promise<ClientResult<ChangesPage>>;
  files(stash: string): StashFilesClient;
  putLatest(
    stash: string,
    path: string,
    body: string,
    options?: PutLatestOptions,
  ): Promise<ClientResult<PutResult>>;
}

/**
 * Creates an isomorphic stash client over fetch or an in-process RPC binding. Fetch can be
 * replaced with a Cloudflare service binding: `fetch: (input, init) => env.STASH.fetch(input, init)`.
 */
export function createStashClient(options: StashClientOptions): StashClient {
  const clientId = options.clientId;
  if (clientId !== undefined && !isStashClientId(clientId)) {
    throw new TypeError(
      "clientId must contain between 1 and 64 characters and use printable ASCII without leading or trailing whitespace",
    );
  }

  let send: Send;
  let authorizationToken: string | undefined;
  let keyFactory: () => string | Promise<string>;
  let connectEvents:
    | ((stash: string, since: number | undefined, signal: AbortSignal) => Promise<Response>)
    | undefined;

  if (isRpcClientOptions(options)) {
    if ("baseUrl" in options || "fetch" in options) {
      throw new TypeError("rpc transport does not accept baseUrl or fetch");
    }
    if (
      !isRecord(options.transport.binding) ||
      typeof options.transport.binding.request !== "function"
    ) {
      throw new TypeError("rpc transport requires a binding with a request function");
    }
    if (
      typeof options.transport.token !== "string" ||
      options.transport.token.trim().length === 0
    ) {
      throw new TypeError("rpc transport requires a non-empty token");
    }
    send = createRpcSend(options.transport.binding, options.transport.token);
    authorizationToken = undefined;
    keyFactory = () => globalThis.crypto.randomUUID();
    connectEvents = undefined;
  } else {
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const eventBaseUrl = options.baseUrl.replace(/\/+$/, "");
    const eventToken = options.token;
    send = createFetchSend(fetcher, options.baseUrl);
    authorizationToken = options.token;
    keyFactory = options.idempotencyKey ?? (() => globalThis.crypto.randomUUID());
    connectEvents = (stash, since, signal) => {
      const path = route("stashEvents", stash);
      const url = `${eventBaseUrl}${path}`;
      const query = since === undefined ? "" : `?${new URLSearchParams({ since: String(since) })}`;
      return fetcher(`${url}${query}`, {
        method: "GET",
        headers: eventToken === undefined ? {} : { Authorization: `Bearer ${eventToken}` },
        signal,
      });
    };
  }

  const call = <T>(
    routeId: RouteId,
    method: RouteMethod,
    requestTarget: RequestTarget,
    body?: unknown,
    idempotencyKey?: string,
    ifNoneMatch?: string,
  ): Promise<ClientResult<T> | NotModifiedResult> =>
    request(
      send,
      authorizationToken,
      routeId,
      method,
      requestTarget,
      body,
      idempotencyKey,
      ifNoneMatch,
      clientId,
    );

  const stashError = <T>(stash: string): ClientResult<T> | undefined => validateStash<T>(stash);

  const filePath = <T>(stash: string, path: string): ClientResult<T> | undefined => {
    const stashResult = stashError<T>(stash);
    if (stashResult !== undefined) return stashResult;
    return validateFilePath<T>(path);
  };

  const binaryContext: BinaryClientContext = {
    send,
    authorizationToken,
    clientId,
    mintKey: (supplied) => mintKey(keyFactory, supplied),
  };

  const getFileClient = (stash: string): StashFilesClient => ({
    events(eventOptions = {}) {
      if (connectEvents === undefined) {
        throw new TypeError("unsupported-transport: events are fetch-only");
      }
      const connect = connectEvents;
      return createStashEventStream(
        {
          connect(since, signal) {
            return connect(stash, since, signal);
          },
        },
        eventOptions,
      );
    },
    async get(path, getOptions = {}) {
      const invalid = filePath<FileRecordWithEtag>(stash, path);
      if (invalid !== undefined) return invalid;
      return (await call<FileRecordWithEtag>(
        "getFile",
        "GET",
        target(route("getFile", stash, path), [["version", getOptions.version]]),
        undefined,
        undefined,
        getOptions.ifNoneMatch,
      )) as FileGetResult;
    },
    async put(path, input, mutationOptions = {}) {
      const invalid = filePath<PutResult>(stash, path);
      if (invalid !== undefined) return invalid;
      const idempotencyKey = await mintKey(keyFactory, mutationOptions.idempotencyKey);
      return (await call<PutResult>(
        "putFile",
        "PUT",
        target(route("putFile", stash, path)),
        input,
        idempotencyKey,
      )) as ClientResult<PutResult>;
    },
    async delete(path, input, mutationOptions = {}) {
      const invalid = filePath<DeleteResult>(stash, path);
      if (invalid !== undefined) return invalid;
      const idempotencyKey = await mintKey(keyFactory, mutationOptions.idempotencyKey);
      return (await call<DeleteResult>(
        "deleteFile",
        "POST",
        target(route("deleteFile", stash, path)),
        input,
        idempotencyKey,
      )) as ClientResult<DeleteResult>;
    },
    async rollback(path, input, mutationOptions = {}) {
      const invalid = filePath<RollbackResult>(stash, path);
      if (invalid !== undefined) return invalid;
      const idempotencyKey = await mintKey(keyFactory, mutationOptions.idempotencyKey);
      return (await call<RollbackResult>(
        "rollbackFile",
        "POST",
        target(route("rollbackFile", stash, path)),
        input,
        idempotencyKey,
      )) as ClientResult<RollbackResult>;
    },
    async list(listOptions = {}) {
      const invalid = stashError<FileListResponse>(stash);
      if (invalid !== undefined) return invalid;
      return (await call<FileListResponse>(
        "listFiles",
        "GET",
        target(route("listFiles", stash), [
          ["includeDeleted", listOptions.includeDeleted],
          ["limit", listOptions.limit],
          ["after", listOptions.after],
        ]),
      )) as ClientResult<FileListResponse>;
    },
    async history(path, historyOptions = {}) {
      const invalid = filePath<GetHistoryResult>(stash, path);
      if (invalid !== undefined) return invalid;
      return (await call<GetHistoryResult>(
        "getHistory",
        "GET",
        target(route("getHistory", stash, path), [
          ["limit", historyOptions.limit],
          ["before", historyOptions.before],
        ]),
      )) as ClientResult<GetHistoryResult>;
    },
    async diff(path, diffOptions) {
      const invalid = filePath<GetDiffResult>(stash, path);
      if (invalid !== undefined) return invalid;
      return (await call<GetDiffResult>(
        "getDiff",
        "GET",
        target(route("getDiff", stash, path), [
          ["from", diffOptions.from],
          ["to", diffOptions.to],
          ["context", diffOptions.context],
          ["maxUnifiedBytes", diffOptions.maxUnifiedBytes],
        ]),
      )) as ClientResult<GetDiffResult>;
    },
    async diffCandidate(path, input) {
      const invalid = filePath<CandidateDiffResult>(stash, path);
      if (invalid !== undefined) return invalid;
      return (await call<CandidateDiffResult>(
        "diffCandidate",
        "POST",
        target(route("diffCandidate", stash, path)),
        input,
      )) as ClientResult<CandidateDiffResult>;
    },
    async changes(changesOptions = {}) {
      const invalid = stashError<ListChangesResult>(stash);
      if (invalid !== undefined) return invalid;
      if (changesOptions.since !== undefined && changesOptions.before !== undefined) {
        return validationResult("validation", "since and before are mutually exclusive");
      }
      return (await call<ListChangesResult>(
        "getStashChanges",
        "GET",
        target(route("getStashChanges", stash), [
          ["since", changesOptions.since],
          ["before", changesOptions.before],
          ["limit", changesOptions.limit],
        ]),
      )) as ClientResult<ListChangesResult>;
    },
    raw: {
      async get(path, rawOptions = {}) {
        const invalid = filePath<never>(stash, path);
        if (invalid !== undefined) return invalid;
        return getRaw(binaryContext, stash, path, rawOptions);
      },
      async head(path, rawOptions = {}) {
        const invalid = filePath<never>(stash, path);
        if (invalid !== undefined) return invalid;
        return getRaw(binaryContext, stash, path, rawOptions, true);
      },
    },
    async upload(path, source, uploadOptions) {
      const invalid = filePath<never>(stash, path);
      if (invalid !== undefined) return invalid;
      const capabilities = (await call<CapabilitiesResponse>(
        "getCapabilities",
        "GET",
        target(route("getCapabilities")),
      )) as ClientResult<CapabilitiesResponse>;
      if (!capabilities.ok) return capabilities;
      return upload(
        binaryContext,
        stash,
        path,
        source,
        uploadOptions,
        capabilities.value,
        async (body, idempotencyKey) =>
          (await call(
            "putFile",
            "PUT",
            target(route("putFile", stash, path)),
            {
              body,
              expectedVersion: uploadOptions.expectedVersion,
              skipIfUnchanged: uploadOptions.skipIfUnchanged,
              contentType: uploadOptions.contentType,
            },
            idempotencyKey,
          )) as ClientResult<PutResult>,
      );
    },
    uploads: createUploadSessionsClient(binaryContext, stash),
  });

  const stashes = {
    async list(listOptions: ListStashesOptions = {}) {
      return (await call<ListStashesResult>(
        "listStashes",
        "GET",
        target(route("listStashes"), [
          ["limit", listOptions.limit],
          ["after", listOptions.after],
          ["includeDeleted", listOptions.includeDeleted],
        ]),
      )) as ClientResult<ListStashesResult>;
    },
    async create(input: CreateStashBody) {
      const stashResult = validateStash<CreateStashResult>(input.name);
      if (stashResult !== undefined) return stashResult;
      return (await call<CreateStashResult>(
        "createStash",
        "POST",
        target(route("createStash")),
        input,
      )) as ClientResult<CreateStashResult>;
    },
    async get(stash: string) {
      const invalid = stashError<StashRecord>(stash);
      if (invalid !== undefined) return invalid;
      return (await call<StashRecord>(
        "getStash",
        "GET",
        target(route("getStash", stash)),
      )) as ClientResult<StashRecord>;
    },
    async delete(stash: string) {
      const invalid = stashError<DeleteStashResult>(stash);
      if (invalid !== undefined) return invalid;
      return (await call<DeleteStashResult>(
        "deleteStash",
        "DELETE",
        target(route("deleteStash", stash)),
      )) as ClientResult<DeleteStashResult>;
    },
    async restore(stash: string) {
      const invalid = stashError<RestoreStashResult>(stash);
      if (invalid !== undefined) return invalid;
      return (await call<RestoreStashResult>(
        "restoreStash",
        "POST",
        target(route("restoreStash", stash)),
      )) as ClientResult<RestoreStashResult>;
    },
    tokens(stash: string): StashTokensClient {
      return {
        async create(input) {
          const invalid = stashError<CreateTokenResult>(stash);
          if (invalid !== undefined) return invalid;
          return (await call<CreateTokenResult>(
            "createToken",
            "POST",
            target(route("createToken", stash)),
            input,
          )) as ClientResult<CreateTokenResult>;
        },
        async list() {
          const invalid = stashError<ListTokensResult>(stash);
          if (invalid !== undefined) return invalid;
          return (await call<ListTokensResult>(
            "listTokens",
            "GET",
            target(route("listTokens", stash)),
          )) as ClientResult<ListTokensResult>;
        },
        async rotate(id, input) {
          const invalid = stashError<RotateTokenResult>(stash);
          if (invalid !== undefined) return invalid;
          return (await call<RotateTokenResult>(
            "rotateToken",
            "POST",
            target(route("rotateToken", stash, undefined, id)),
            input,
          )) as ClientResult<RotateTokenResult>;
        },
        async revoke(id) {
          const invalid = stashError<undefined>(stash);
          if (invalid !== undefined) return invalid;
          return (await call<undefined>(
            "revokeToken",
            "DELETE",
            target(route("revokeToken", stash, undefined, id)),
          )) as ClientResult<undefined>;
        },
      };
    },
    async import(stash: string, input: ImportBody) {
      const invalidStash = stashError<ImportResult>(stash);
      if (invalidStash !== undefined) return invalidStash;
      const invalidPath = validateFilePath<ImportResult>(input.path);
      if (invalidPath !== undefined) return invalidPath;
      return (await call<ImportResult>(
        "importHistory",
        "POST",
        target(route("importHistory", stash)),
        input,
      )) as ClientResult<ImportResult>;
    },
  };

  const changes = async (changesOptions: ChangesOptions = {}) => {
    if (changesOptions.since !== undefined && changesOptions.before !== undefined) {
      return validationResult<ChangesPage>("validation", "since and before are mutually exclusive");
    }
    return (await call<ChangesPage>(
      "listChanges",
      "GET",
      target(route("listChanges"), [
        ["since", changesOptions.since],
        ["before", changesOptions.before],
        ["limit", changesOptions.limit],
      ]),
    )) as ClientResult<ChangesPage>;
  };

  const admin: StashAdminClient = {
    gc: {
      async run(input) {
        return (await call<GcRunResult>(
          "runGc",
          "POST",
          target(route("runGc")),
          input,
        )) as ClientResult<GcRunResult>;
      },
      async runs(listOptions: ListGcRunsOptions = {}) {
        return (await call<GcRunsResponse>(
          "listGcRuns",
          "GET",
          target(route("listGcRuns"), [
            ["kind", listOptions.kind],
            ["limit", listOptions.limit],
          ]),
        )) as ClientResult<GcRunsResponse>;
      },
    },
  };

  const client: StashClient = {
    async health() {
      return (await call<HealthResponse>(
        "health",
        "GET",
        target(route("health")),
      )) as ClientResult<HealthResponse>;
    },
    async capabilities() {
      return (await call<CapabilitiesResponse>(
        "getCapabilities",
        "GET",
        target(route("getCapabilities")),
      )) as ClientResult<CapabilitiesResponse>;
    },
    async me() {
      return (await call<MeResponse>("me", "GET", target(route("me")))) as ClientResult<MeResponse>;
    },
    stashes,
    admin,
    changes,
    files: getFileClient,
    async putLatest(stash, path, body, putOptions = {}) {
      const invalid = filePath<PutResult>(stash, path);
      if (invalid !== undefined) return invalid;
      const files = getFileClient(stash);
      const retries = Number.isFinite(putOptions.retries)
        ? Math.max(0, Math.floor(putOptions.retries ?? 3))
        : 3;
      let head = await files.get(path);
      if (!head.ok && head.error.code !== "not-found" && head.error.code !== "file-deleted") {
        return head as ClientResult<PutResult>;
      }
      let expectedVersion = getFileVersion(head);
      for (let attempt = 0; ; attempt += 1) {
        const result = await files.put(path, {
          body,
          expectedVersion: expectedVersion ?? null,
          ...(putOptions.author === undefined ? {} : { author: putOptions.author }),
          ...(putOptions.message === undefined ? {} : { message: putOptions.message }),
          ...(putOptions.meta === undefined ? {} : { meta: putOptions.meta }),
          ...(putOptions.contentType === undefined ? {} : { contentType: putOptions.contentType }),
          ...(putOptions.skipIfUnchanged === undefined
            ? {}
            : { skipIfUnchanged: putOptions.skipIfUnchanged }),
        });
        if (result.ok || result.error.code !== "stale" || attempt >= retries) return result;
        head = await files.get(path);
        if (!head.ok && head.error.code !== "not-found" && head.error.code !== "file-deleted") {
          return head as ClientResult<PutResult>;
        }
        expectedVersion = getFileVersion(head);
      }
    },
  };
  return client;
}
