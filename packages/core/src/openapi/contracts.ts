import type { ZodType } from "zod";
import type { ErrorCode } from "../types.js";
import {
  ChangesQuery,
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  CreateChangeSetBody,
  CreateCommitBody,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  DiffCandidateBody,
  DiffQuery,
  EventsQuery,
  FileGetQuery,
  HistoryQuery,
  ImportBody,
  ListGcRunsQuery,
  ListChangeSetsQuery,
  ListCommitsQuery,
  ListFilesQuery,
  ListStashesQuery,
  PutFileBody,
  RejectChangeSetBody,
  RevertCommitBody,
  SnapshotQuery,
  RollbackBody,
  RunGcBody,
  RotateTokenBody,
  STASH_CLIENT_ID_HEADER,
  AbortUploadSessionBody,
  CompleteUploadSessionBody,
  CreateUploadSessionBody,
  UploadPartQuery,
} from "../schemas.js";
import type { RouteId, RouteTransport } from "../routes.js";
import type { RESPONSE_SCHEMAS } from "./responses.js";
import type { SAMPLES } from "./samples.js";

export type RequestHeader =
  | "Idempotency-Key"
  | "If-None-Match"
  | "If-Range"
  | "Range"
  | "Content-Length"
  | typeof STASH_CLIENT_ID_HEADER;
export type ResponseHeader =
  | "ETag"
  | "X-Stash-Version"
  | "Idempotent-Replayed"
  | "Retry-After"
  | "Cache-Control"
  | "X-Accel-Buffering"
  | "Accept-Ranges"
  | "Content-Length"
  | "Content-Range"
  | "Content-Type"
  | "Content-Disposition"
  | "X-Content-Type-Options";
export type ResponseStatus = 200 | 201 | 202 | 204 | 206 | 304;
export type ResponseMediaType =
  "application/json" | "application/octet-stream" | "text/event-stream";

export interface RouteResponse {
  schema?: keyof typeof RESPONSE_SCHEMAS;
  description: string;
  headers?: ResponseHeader[];
  example?: keyof typeof SAMPLES;
  mediaType?: ResponseMediaType;
}

export interface RouteError {
  code: ErrorCode;
  current: boolean;
  note?: string;
  headers?: ResponseHeader[];
}

export interface RouteContract {
  summary: string;
  description: string;
  principalNote: string;
  query?: ZodType;
  body?: ZodType;
  /** Exact byte stream body; mutually exclusive with the JSON `body` schema. */
  rawBody?: true;
  requestMediaType?: "application/json" | "application/octet-stream";
  requestHeaders?: RequestHeader[];
  responses: Partial<Record<ResponseStatus, RouteResponse>>;
  errors: RouteError[];
  wildcardPath: boolean;
  /** Defaults to `any`; fetch-only routes have no named RPC method. */
  transport?: RouteTransport;
}

const response = (
  description: string,
  schema: keyof typeof RESPONSE_SCHEMAS,
  example: keyof typeof SAMPLES,
  headers?: ResponseHeader[],
): RouteResponse => ({ description, schema, example, ...(headers ? { headers } : {}) });

const noContentResponse = (description: string, headers?: ResponseHeader[]): RouteResponse => ({
  description,
  ...(headers ? { headers } : {}),
});

const eventStreamResponse = (
  description: string,
  schema: keyof typeof RESPONSE_SCHEMAS,
  headers: ResponseHeader[],
): RouteResponse => ({ description, schema, headers, mediaType: "text/event-stream" });

const RAW_RESPONSE_HEADERS: ResponseHeader[] = [
  "ETag",
  "X-Stash-Version",
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Type",
  "Content-Disposition",
  "X-Content-Type-Options",
];
const rawResponse = (description: string): RouteResponse => ({
  description,
  headers: RAW_RESPONSE_HEADERS,
  mediaType: "application/octet-stream",
});

const error = (
  code: ErrorCode,
  current = false,
  note?: string,
  headers?: ResponseHeader[],
): RouteError => ({
  code,
  current,
  ...(note ? { note } : {}),
  ...(headers ? { headers } : {}),
});

const rateLimited = (): RouteError => error("rate-limited", false, undefined, ["Retry-After"]);

export const ROUTE_CONTRACTS = {
  health: {
    summary: "Health check",
    description: "Returns the service health marker without requiring authentication.",
    principalNote: "open; no capability or token is required.",
    responses: {
      200: response("The service is healthy.", "HealthResponse", "HealthResponse"),
    },
    errors: [],
    wildcardPath: false,
  },
  me: {
    summary: "Inspect the authenticated principal",
    description: "Returns whether the credential belongs to the administrator or a stash token.",
    principalNote: "any; any valid credential.",
    responses: {
      200: response("The authenticated principal.", "MeResponse", "MeResponse"),
    },
    errors: [error("unauthorized"), rateLimited()],
    wildcardPath: false,
  },
  listStashes: {
    summary: "List stashes",
    description: "Returns a keyset-paginated list of stashes.",
    principalNote: "admin; administrator only.",
    query: ListStashesQuery,
    responses: {
      200: response("A page of stash summaries.", "ListStashesResult", "ListStashesResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found")],
    wildcardPath: false,
  },
  createStash: {
    summary: "Create a stash",
    description: "Creates a new stash and returns its initial record.",
    principalNote: "admin; administrator only.",
    body: CreateStashBody,
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      201: response("The newly created stash record.", "CreateStashResult", "CreateStashResult"),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      error("exists"),
      error("payload-too-large"),
    ],
    wildcardPath: false,
  },
  getStash: {
    summary: "Get a stash",
    description: "Returns a stash record with its live file counts.",
    principalNote: "admin-or-stash; administrator or a token belonging to :stash.",
    responses: {
      200: response("The stash record.", "GetStashResult", "GetStashResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()],
    wildcardPath: false,
  },
  deleteStash: {
    summary: "Delete a stash",
    description:
      "Soft-deletes a stash, revokes its tokens, and returns the end of its restoration window.",
    principalNote: "admin; administrator only.",
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      200: response(
        "The soft-deleted stash and its restoration deadline.",
        "DeleteStashResult",
        "DeleteStashResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      error("already-deleted"),
    ],
    wildcardPath: false,
  },
  restoreStash: {
    summary: "Restore a stash",
    description: "Restores a soft-deleted stash during its restoration window.",
    principalNote: "admin; administrator only.",
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      200: response("The restored stash record.", "RestoreStashResult", "RestoreStashResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found")],
    wildcardPath: false,
  },
  createToken: {
    summary: "Create a stash token",
    description: "Creates a scoped stash token and returns the secret once.",
    principalNote: "admin; administrator only.",
    body: CreateTokenBody,
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      201: response(
        "The newly created token, including its secret.",
        "CreateTokenResult",
        "CreateTokenResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      error("payload-too-large"),
    ],
    wildcardPath: false,
  },
  listTokens: {
    summary: "List stash tokens",
    description: "Returns token metadata without exposing token secrets.",
    principalNote: "admin; administrator only.",
    responses: {
      200: response("The stash token records.", "ListTokensResult", "ListTokensResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found")],
    wildcardPath: false,
  },
  rotateToken: {
    summary: "Rotate a stash token",
    description: "Creates one successor token and shortens the predecessor to a grace period.",
    principalNote: "admin; administrator only.",
    body: RotateTokenBody,
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      201: response(
        "The newly created successor token and the predecessor's shortened expiry.",
        "RotateTokenResult",
        "RotateTokenResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      error("already-rotated"),
      error("token-expired"),
      error("payload-too-large"),
    ],
    wildcardPath: false,
  },
  revokeToken: {
    summary: "Revoke a stash token",
    description: "Revokes a token so it can no longer authenticate.",
    principalNote: "admin; administrator only.",
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      204: noContentResponse("The token was revoked; the response has no body."),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found")],
    wildcardPath: false,
  },
  importHistory: {
    summary: "Import file history",
    description: "Appends an existing file history in one fenced batch.",
    principalNote: "admin; administrator only.",
    body: ImportBody,
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      201: response(
        "The imported path and resulting head version.",
        "ImportResult",
        "ImportResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      error("stale", true),
      error("exists", true),
      error("payload-too-large"),
      error("unsupported-representation"),
      error("internal"),
    ],
    wildcardPath: false,
  },
  listChanges: {
    summary: "List all changes",
    description: "Returns a paginated administrator change feed.",
    principalNote: "admin; administrator only.",
    query: ChangesQuery,
    responses: {
      200: response(
        "A page of changes across all stashes.",
        "ListChangesResult",
        "ListChangesResult",
      ),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found")],
    wildcardPath: false,
  },
  runGc: {
    summary: "Run garbage collection",
    description:
      "Runs one bounded garbage-collection page synchronously for either private R2 orphans or the idempotency ledger. An invocation safety budget may stop a page below maxObjects.",
    principalNote: "admin; administrator only.",
    body: RunGcBody,
    requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: {
      200: response("The completed garbage-collection run page.", "GcRunResult", "GcRunResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("gc-busy")],
    wildcardPath: false,
  },
  listGcRuns: {
    summary: "List garbage-collection runs",
    description: "Returns recent garbage-collection run records, optionally filtered by kind.",
    principalNote: "admin; administrator only.",
    query: ListGcRunsQuery,
    responses: {
      200: response("Recent garbage-collection runs.", "GcRunsResponse", "GcRunsResponse"),
    },
    errors: [error("validation"), error("unauthorized")],
    wildcardPath: false,
  },
  createCommit: {
    summary: "Create a commit", description: "Atomically applies one or more file entries.",
    principalNote: "write; administrator or a matching write stash token.", body: CreateCommitBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: { 201: response("The committed entries.", "CommitResult", "CommitResult", ["Idempotent-Replayed"]) },
    errors: [error("validation"), error("body-not-well-formed"), error("unauthorized"), error("scope"), error("not-found"), error("commit-conflict"), error("payload-too-large"), error("idempotency-key-reused"), rateLimited(), error("internal")], wildcardPath: false,
  },
  getCommit: {
    summary: "Get a commit", description: "Returns a commit and its entries.", principalNote: "read; administrator or a matching read/write stash token.",
    responses: { 200: response("The commit record.", "CommitRecord", "CommitRecord") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()], wildcardPath: false,
  },
  listCommits: {
    summary: "List commits", description: "Returns commits newest first.", principalNote: "read; administrator or a matching read/write stash token.", query: ListCommitsQuery,
    responses: { 200: response("A page of commits.", "CommitListResponse", "CommitListResponse") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()], wildcardPath: false,
  },
  getCommitDiff: {
    summary: "Get a commit diff", description: "Returns per-entry diffs for a commit.", principalNote: "read; administrator or a matching read/write stash token.", query: CommitDiffQuery,
    responses: { 200: response("The commit diff.", "CommitDiffResult", "CommitDiffResult") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited(), error("internal")], wildcardPath: false,
  },
  revertCommit: {
    summary: "Revert a commit", description: "Creates a new commit that reverses the named commit.", principalNote: "write; administrator or a matching write stash token.", body: RevertCommitBody, requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: { 201: response("The revert commit.", "CommitResult", "CommitResult", ["Idempotent-Replayed"]) }, errors: [error("validation"), error("unauthorized"), error("scope"), error("not-found"), error("commit-conflict"), error("payload-too-large"), error("idempotency-key-reused"), rateLimited(), error("internal")], wildcardPath: false,
  },
  getSnapshot: {
    summary: "Get a snapshot", description: "Lists files as of a commit.", principalNote: "read; administrator or a matching read/write stash token.", query: SnapshotQuery,
    responses: { 200: response("The snapshot page.", "SnapshotResponse", "SnapshotResponse") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()], wildcardPath: false,
  },
  createChangeSet: {
    summary: "Create a change set", description: "Stores an expiring multi-file candidate.", principalNote: "write; administrator or a matching write stash token.", body: CreateChangeSetBody, requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: { 201: response("The change set.", "ChangeSetRecord", "ChangeSetRecord", ["Idempotent-Replayed"]) }, errors: [error("validation"), error("body-not-well-formed"), error("unauthorized"), error("scope"), error("not-found"), error("payload-too-large"), error("idempotency-key-reused"), rateLimited(), error("internal")], wildcardPath: false,
  },
  listChangeSets: {
    summary: "List change sets", description: "Returns filtered change sets newest first.", principalNote: "read; administrator or a matching read/write stash token.", query: ListChangeSetsQuery,
    responses: { 200: response("A page of change sets.", "ChangeSetListResponse", "ChangeSetListResponse") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()], wildcardPath: false,
  },
  getChangeSet: {
    summary: "Get a change set", description: "Returns a change set and current staleness.", principalNote: "read; administrator or a matching read/write stash token.",
    responses: { 200: response("The change set.", "ChangeSetRecord", "ChangeSetRecord") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()], wildcardPath: false,
  },
  getChangeSetDiff: {
    summary: "Get a change-set diff", description: "Returns candidate and current diffs.", principalNote: "read; administrator or a matching read/write stash token.", query: ChangeSetDiffQuery,
    responses: { 200: response("The change-set diff.", "ChangeSetDiffResult", "ChangeSetDiffResult") }, errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited(), error("internal")], wildcardPath: false,
  },
  approveChangeSet: {
    summary: "Approve a change set", description: "Atomically applies an open, current change set.", principalNote: "write; administrator or a matching write stash token.", body: ApproveChangeSetBody, requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: { 200: response("The applied commit.", "ApproveChangeSetResult", "ApproveChangeSetResult") }, errors: [error("validation"), error("unauthorized"), error("scope"), error("not-found"), error("commit-conflict"), error("change-set-expired"), error("change-set-closed"), error("payload-too-large"), rateLimited(), error("internal")], wildcardPath: false,
  },
  rejectChangeSet: {
    summary: "Reject a change set", description: "Rejects an open change set.", principalNote: "write; administrator or a matching write stash token.", body: RejectChangeSetBody, requestHeaders: [STASH_CLIENT_ID_HEADER],
    responses: { 200: response("The rejected change set.", "ChangeSetRecord", "RejectedChangeSetRecord") }, errors: [error("validation"), error("unauthorized"), error("scope"), error("not-found"), error("change-set-closed"), error("payload-too-large"), rateLimited()], wildcardPath: false,
  },
  stashEvents: {
    summary: "Stream stash events",
    description:
      "Streams advisory stash events as Server-Sent Events after subscribing live, replaying missed changes, and establishing a replay checkpoint.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: EventsQuery,
    responses: {
      200: eventStreamResponse(
        "A Server-Sent Events stream of ready, change, commit, change-set, and reconnect events.",
        "StashEvent",
        ["Cache-Control", "X-Accel-Buffering"],
      ),
    },
    errors: [error("unauthorized"), error("scope"), error("not-found"), rateLimited()],
    wildcardPath: false,
    transport: "fetch-only",
  },
  listFiles: {
    summary: "List files",
    description: "Returns a keyset-paginated list of file summaries.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: ListFilesQuery,
    responses: {
      200: response("A page of file summaries.", "ListFilesResult", "ListFilesResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()],
    wildcardPath: false,
  },
  getFile: {
    summary: "Get a file",
    description: "Returns a file version or a not-modified response for a matching ETag.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: FileGetQuery,
    requestHeaders: ["If-None-Match"],
    responses: {
      200: response("The requested file record.", "GetFileResult", "GetFileResult", [
        "ETag",
        "X-Stash-Version",
      ]),
      304: noContentResponse(
        "The requested representation has not changed; the response has no body.",
        ["ETag", "X-Stash-Version"],
      ),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("file-deleted", true),
      error("version-not-found"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  putFile: {
    summary: "Put a file",
    description: "Compares and sets a file head, appending history when content changes.",
    principalNote: "write; administrator or a matching write stash token.",
    body: PutFileBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      201: response("A new version was appended.", "PutCreatedResult", "PutCreatedResult", [
        "Idempotent-Replayed",
      ]),
      200: response(
        "The live content was unchanged and no version was appended.",
        "PutUnchangedResult",
        "PutUnchangedResult",
        ["Idempotent-Replayed"],
      ),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("body-not-well-formed"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("stale", true),
      error("exists", true),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  deleteFile: {
    summary: "Delete a file",
    description: "Appends a tombstone version for a file using compare-and-set semantics.",
    principalNote: "write; administrator or a matching write stash token.",
    body: DeleteFileBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      200: response("A tombstone version was appended.", "DeleteResult", "DeleteResult", [
        "Idempotent-Replayed",
      ]),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("stale", true),
      error("already-deleted", true),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  rollbackFile: {
    summary: "Roll back a file",
    description: "Restores a target version by appending a new rollback version.",
    principalNote: "write; administrator or a matching write stash token.",
    body: RollbackBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      201: response("A rollback version was appended.", "RollbackResult", "RollbackResult", [
        "Idempotent-Replayed",
      ]),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("version-not-found", true),
      error("stale", true),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      error("rollback-target-tombstone", true),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  getHistory: {
    summary: "Get file history",
    description: "Returns newest-first file versions without response bodies.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: HistoryQuery,
    responses: {
      200: response("A page of file history.", "GetHistoryResult", "GetHistoryResult"),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      rateLimited(),
    ],
    wildcardPath: true,
  },
  getDiff: {
    summary: "Get a stored diff",
    description: "Computes a diff between two stored file versions on demand.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: DiffQuery,
    responses: {
      200: response("The stored file diff and side metadata.", "GetDiffResult", "GetDiffResult"),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("version-not-found"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  diffCandidate: {
    summary: "Preview a candidate diff",
    description: "Computes an in-memory diff against a candidate body without writing history.",
    principalNote: "read; administrator or a matching read/write stash token.",
    body: DiffCandidateBody,
    responses: {
      200: response("The candidate file diff.", "CandidateDiffResult", "CandidateDiffResult"),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("body-not-well-formed"),
      error("unauthorized"),
      error("not-found"),
      error("version-not-found"),
      error("payload-too-large"),
      error("unsupported-representation"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
  },
  getStashChanges: {
    summary: "List stash changes",
    description: "Returns a paginated change feed restricted to one stash.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: ChangesQuery,
    responses: {
      200: response("A page of changes for the stash.", "ListChangesResult", "ListChangesResult"),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()],
    wildcardPath: false,
  },
  getCapabilities: {
    summary: "Get server capabilities",
    description:
      "Publishes authoritative exact-content byte limits. The HTTP request ceiling is operator supplied; it is not inferred from the Worker plan.",
    principalNote: "open; no capability or token is required.",
    responses: {
      200: response(
        "The server's binary and large-object capabilities.",
        "CapabilitiesResponse",
        "CapabilitiesResponse",
      ),
    },
    errors: [error("internal")],
    wildcardPath: false,
    transport: "fetch-only",
  },
  getRawFile: {
    summary: "Download current raw content",
    description: "Streams the current version's exact bytes using the application SHA-256 ETag.",
    principalNote: "read; administrator or a matching read/write stash token.",
    requestHeaders: ["If-None-Match", "If-Range", "Range"],
    responses: {
      200: rawResponse("Complete content."),
      206: rawResponse("One byte range."),
      304: noContentResponse("The ETag matched.", ["ETag"]),
    },
    errors: [
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("file-deleted"),
      error("range-not-satisfiable", false, undefined, ["Content-Range"]),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
    transport: "fetch-only",
  },
  headRawFile: {
    summary: "Inspect current raw content",
    description: "Returns the same status and metadata headers as current raw GET without a body.",
    principalNote: "read; administrator or a matching read/write stash token.",
    requestHeaders: ["If-None-Match", "If-Range", "Range"],
    responses: {
      200: noContentResponse("Complete content metadata.", RAW_RESPONSE_HEADERS),
      206: noContentResponse("Range metadata.", RAW_RESPONSE_HEADERS),
      304: noContentResponse("The ETag matched.", ["ETag"]),
    },
    errors: [
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("file-deleted"),
      error("range-not-satisfiable", false, undefined, ["Content-Range"]),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
    transport: "fetch-only",
  },
  getRawVersion: {
    summary: "Download historical raw content",
    description: "Streams one immutable historical version's exact bytes.",
    principalNote: "read; administrator or a matching read/write stash token.",
    requestHeaders: ["If-None-Match", "If-Range", "Range"],
    responses: {
      200: rawResponse("Complete historical content."),
      206: rawResponse("One historical byte range."),
      304: noContentResponse("The ETag matched.", ["ETag"]),
    },
    errors: [
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("version-not-found"),
      error("file-deleted"),
      error("range-not-satisfiable", false, undefined, ["Content-Range"]),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
    transport: "fetch-only",
  },
  headRawVersion: {
    summary: "Inspect historical raw content",
    description:
      "Returns the same status and metadata headers as historical raw GET without a body.",
    principalNote: "read; administrator or a matching read/write stash token.",
    requestHeaders: ["If-None-Match", "If-Range", "Range"],
    responses: {
      200: noContentResponse("Historical content metadata.", RAW_RESPONSE_HEADERS),
      206: noContentResponse("Historical range metadata.", RAW_RESPONSE_HEADERS),
      304: noContentResponse("The ETag matched.", ["ETag"]),
    },
    errors: [
      error("invalid-path"),
      error("unauthorized"),
      error("not-found"),
      error("version-not-found"),
      error("file-deleted"),
      error("range-not-satisfiable", false, undefined, ["Content-Range"]),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
    transport: "fetch-only",
  },
  createUploadSession: {
    summary: "Create a raw upload session",
    description:
      "Reserves declared exact content bytes and chooses single or multipart transfer plus D1 or R2 staging. Repeating the same idempotency fingerprint replays the session.",
    principalNote: "write; administrator or a matching write stash token.",
    body: CreateUploadSessionBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      201: response(
        "The created or replayed upload session.",
        "CreateUploadSessionResult",
        "CreateUploadSessionResult",
        ["Idempotent-Replayed"],
      ),
    },
    errors: [
      error("validation"),
      error("invalid-path"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("stale", true),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: true,
    transport: "fetch-only",
  },
  getUploadSession: {
    summary: "Get upload session status",
    description:
      "Returns durable state and server-recorded current-generation multipart parts without exposing R2 identifiers.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    responses: {
      200: response("Upload status and parts.", "GetUploadSessionResult", "GetUploadSessionResult"),
    },
    errors: [error("unauthorized"), error("scope"), error("not-found"), rateLimited()],
    wildcardPath: false,
    transport: "fetch-only",
  },
  uploadSingleContent: {
    summary: "Upload single raw content",
    description:
      "Consumes and validates one raw byte stream for a single-mode session. The upload fingerprint is distinct from creation and completion fingerprints.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    requestHeaders: ["Content-Length", "Idempotency-Key", STASH_CLIENT_ID_HEADER],
    rawBody: true,
    requestMediaType: "application/octet-stream",
    responses: {
      202: response(
        "The durable uploaded session.",
        "CreateUploadSessionResult",
        "CreateUploadSessionResult",
        ["Idempotent-Replayed"],
      ),
    },
    errors: [
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("upload-session-not-open"),
      error("upload-session-expired"),
      error("upload-size-mismatch"),
      error("upload-hash-mismatch"),
      error("body-not-well-formed"),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
    transport: "fetch-only",
  },
  uploadPart: {
    summary: "Upload or replace one multipart part",
    description:
      "Streams one raw part and records only the server-returned R2 ETag for the current generation.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    query: UploadPartQuery,
    requestHeaders: ["Content-Length", STASH_CLIENT_ID_HEADER],
    rawBody: true,
    requestMediaType: "application/octet-stream",
    responses: {
      202: response("Updated upload status.", "GetUploadSessionResult", "GetUploadSessionResult"),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("upload-session-not-open"),
      error("upload-session-expired"),
      error("upload-size-mismatch"),
      error("payload-too-large"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
    transport: "fetch-only",
  },
  completeUploadSession: {
    summary: "Complete or replay an upload",
    description:
      "Acquires the finalization lease, verifies staged bytes, rechecks CAS, and atomically commits one version; retries replay the durable result.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    body: CompleteUploadSessionBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      201: response("The committed file version.", "CompleteUploadResult", "CompleteUploadResult", [
        "Idempotent-Replayed",
      ]),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("stale", true),
      error("upload-session-not-open"),
      error("upload-session-expired"),
      error("upload-size-mismatch"),
      error("upload-hash-mismatch"),
      error("body-not-well-formed"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
    transport: "fetch-only",
  },
  resumeUploadSession: {
    summary: "Resume upload finalization",
    description:
      "Resumes recovery from durable D1/R2 staging or takes over a finalization lease after expiry.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    body: CompleteUploadSessionBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      200: response(
        "Current durable session or replayed result.",
        "CreateUploadSessionResult",
        "CreateUploadSessionResult",
        ["Idempotent-Replayed"],
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("upload-session-expired"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
    transport: "fetch-only",
  },
  abortUploadSession: {
    summary: "Abort an upload session",
    description:
      "Generation-fenced abort competes with finalization for one winner and is replayable after success.",
    principalNote: "write; the session-bound administrator or matching stash principal.",
    body: AbortUploadSessionBody,
    requestHeaders: ["Idempotency-Key", STASH_CLIENT_ID_HEADER],
    responses: {
      200: response(
        "The terminal aborted session identity.",
        "AbortUploadResult",
        "AbortUploadResult",
        ["Idempotent-Replayed"],
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("upload-session-not-open"),
      error("upload-session-expired"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
    transport: "fetch-only",
  },
} as const satisfies Record<RouteId, RouteContract>;
