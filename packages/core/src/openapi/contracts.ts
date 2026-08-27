import type { ZodType } from "zod";
import type { ErrorCode } from "../types.js";
import {
  ChangesQuery,
  ApproveProposalBody,
  CreateProposalBody,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  DiffCandidateBody,
  DiffQuery,
  FileGetQuery,
  HistoryQuery,
  ImportBody,
  ListGcRunsQuery,
  ListProposalsQuery,
  ListFilesQuery,
  ListStashesQuery,
  PutFileBody,
  ProposalDiffQuery,
  RejectProposalBody,
  RollbackBody,
  RunGcBody,
  RotateTokenBody,
} from "../schemas.js";
import type { RouteId } from "../routes.js";
import type { RESPONSE_SCHEMAS } from "./responses.js";
import type { SAMPLES } from "./samples.js";

export type RequestHeader = "Idempotency-Key" | "If-None-Match";
export type ResponseHeader = "ETag" | "X-Stash-Version" | "Idempotent-Replayed" | "Retry-After";
export type ResponseStatus = 200 | 201 | 204 | 304;

export interface RouteResponse {
  schema?: keyof typeof RESPONSE_SCHEMAS;
  description: string;
  headers?: ResponseHeader[];
  example?: keyof typeof SAMPLES;
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
  requestHeaders?: RequestHeader[];
  responses: Partial<Record<ResponseStatus, RouteResponse>>;
  errors: RouteError[];
  wildcardPath: boolean;
}

const response = (
  description: string,
  schema: keyof typeof RESPONSE_SCHEMAS,
  example: keyof typeof SAMPLES,
  headers?: ResponseHeader[],
): RouteResponse => ({ description, schema, example, ...(headers ? { headers } : {}) });

const noContentResponse = (description: string): RouteResponse => ({ description });

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

export const ROUTE_CONTRACTS: Record<RouteId, RouteContract> = {
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
  createProposal: {
    summary: "Create a proposal",
    description:
      "Stores an expiring candidate write against an exact base version. An Idempotency-Key can replay the same proposal creation safely.",
    principalNote: "write; administrator or a matching write stash token.",
    body: CreateProposalBody,
    requestHeaders: ["Idempotency-Key"],
    responses: {
      201: response("The stored proposal record.", "ProposalRecord", "ProposalRecord", [
        "Idempotent-Replayed",
      ]),
    },
    errors: [
      error("validation"),
      error("body-not-well-formed"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("payload-too-large"),
      error("idempotency-key-reused"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
  },
  listProposals: {
    summary: "List proposals",
    description:
      "Returns proposals newest first with an opaque keyset cursor and a total for the selected status and path filters.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: ListProposalsQuery,
    responses: {
      200: response(
        "A filtered page of proposals.",
        "ProposalListResponse",
        "ProposalListResponse",
      ),
    },
    errors: [error("validation"), error("unauthorized"), error("not-found"), rateLimited()],
    wildcardPath: false,
  },
  getProposal: {
    summary: "Get a proposal",
    description: "Returns one proposal and its immutable candidate body.",
    principalNote: "read; administrator or a matching read/write stash token.",
    responses: {
      200: response(
        "The proposal record and candidate body.",
        "ProposalWithBody",
        "ProposalWithBody",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
  },
  getProposalDiff: {
    summary: "Get a proposal diff",
    description:
      "Computes the immutable base-to-candidate diff and separately reports the current head and whether it has moved.",
    principalNote: "read; administrator or a matching read/write stash token.",
    query: ProposalDiffQuery,
    responses: {
      200: response(
        "The immutable proposal diff and current-head state.",
        "ProposalDiffResult",
        "ProposalDiffResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("not-found"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
  },
  approveProposal: {
    summary: "Approve a proposal",
    description:
      "Applies an open, unexpired proposal only when the current head still equals its exact base. Re-approving an applied proposal returns its stored result.",
    principalNote: "write; administrator or a matching write stash token.",
    body: ApproveProposalBody,
    responses: {
      200: response(
        "The applied proposal result.",
        "ApproveProposalResult",
        "ApproveProposalResult",
      ),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("stale", true),
      error("proposal-expired"),
      error("proposal-closed"),
      error("payload-too-large"),
      rateLimited(),
      error("internal"),
    ],
    wildcardPath: false,
  },
  rejectProposal: {
    summary: "Reject a proposal",
    description:
      "Rejects an open proposal with an optional reason. Re-rejecting it is idempotent; applied proposals are closed.",
    principalNote: "write; administrator or a matching write stash token.",
    body: RejectProposalBody,
    responses: {
      200: response("The rejected proposal record.", "ProposalRecord", "RejectedProposalRecord"),
    },
    errors: [
      error("validation"),
      error("unauthorized"),
      error("scope"),
      error("not-found"),
      error("proposal-closed"),
      error("payload-too-large"),
      rateLimited(),
    ],
    wildcardPath: false,
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
      304: {
        description: "The requested representation has not changed; the response has no body.",
        headers: ["ETag", "X-Stash-Version"],
      },
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
    requestHeaders: ["Idempotency-Key"],
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
    requestHeaders: ["Idempotency-Key"],
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
    requestHeaders: ["Idempotency-Key"],
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
};
