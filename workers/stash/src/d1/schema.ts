export interface StashRow {
  name: string;
  description: string;
  meta_json: string;
  created_at: number;
  deleted_at: number | null;
}

export interface TokenRow {
  id: string;
  stash_name: string;
  token_hash: string;
  label: string;
  scope: "read" | "write";
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  expires_at: number | null;
  rotated_from: string | null;
  rotated_to: string | null;
}

export interface BlobRow {
  stash_name: string;
  hash: string;
  body: string | null;
  r2_key: string | null;
  size_bytes: number;
  created_at: number;
}

export interface FileRow {
  stash_name: string;
  path: string;
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: number;
  stash_name: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  size_bytes: number;
  content_type: string;
  rollback_of: number | null;
  author: string;
  message: string;
  meta_json: string;
  created_at: number;
}

export interface IdempotencyRow {
  stash_name: string;
  key: string;
  request_hash: string;
  path: string;
  version: number;
  status_code: number;
  created_at: number;
}

export type GcJobKind = "r2-orphans" | "ledger";

export interface GcJobRow {
  kind: GcJobKind;
  next_cursor: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_until: number | null;
  updated_at: number;
}

export interface GcRunRow {
  id: string;
  job_kind: GcJobKind;
  lease_generation: number;
  dry_run: 0 | 1;
  input_cursor: string | null;
  next_cursor: string | null;
  scanned: number;
  eligible: number;
  deleted: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export const TABLE_NAMES = [
  "stashes",
  "tokens",
  "blobs",
  "files",
  "versions",
  "idempotency",
  "gc_jobs",
  "gc_runs",
] as const;

export const TABLE_COLUMNS = {
  stashes: ["name", "description", "meta_json", "created_at", "deleted_at"],
  tokens: [
    "id",
    "stash_name",
    "token_hash",
    "label",
    "scope",
    "created_at",
    "revoked_at",
    "last_used_at",
    "expires_at",
    "rotated_from",
    "rotated_to",
  ],
  blobs: ["stash_name", "hash", "body", "r2_key", "size_bytes", "created_at"],
  files: ["stash_name", "path", "head_version", "head_hash", "deleted", "created_at", "updated_at"],
  versions: [
    "id",
    "stash_name",
    "path",
    "version",
    "kind",
    "blob_hash",
    "size_bytes",
    "content_type",
    "rollback_of",
    "author",
    "message",
    "meta_json",
    "created_at",
  ],
  idempotency: [
    "stash_name",
    "key",
    "request_hash",
    "path",
    "version",
    "status_code",
    "created_at",
  ],
  gc_jobs: ["kind", "next_cursor", "lease_owner", "lease_generation", "lease_until", "updated_at"],
  gc_runs: [
    "id",
    "job_kind",
    "lease_generation",
    "dry_run",
    "input_cursor",
    "next_cursor",
    "scanned",
    "eligible",
    "deleted",
    "error",
    "started_at",
    "finished_at",
  ],
} as const satisfies Record<(typeof TABLE_NAMES)[number], readonly string[]>;

export interface DatabaseSchema {
  stashes: StashRow;
  tokens: TokenRow;
  blobs: BlobRow;
  files: FileRow;
  versions: VersionRow;
  idempotency: IdempotencyRow;
  gc_jobs: GcJobRow;
  gc_runs: GcRunRow;
}
