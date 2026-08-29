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

export interface ByteBlobRow {
  stash_name: string;
  hash: string;
  body_bytes: ArrayBuffer | null;
  r2_key: string | null;
  storage_generation: number;
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
  representation: "text" | "binary";
  application_etag: string | null;
  content_storage: "legacy" | "bytes";
  commit_id: string;
  copied_from_path: string | null;
  copied_from_version: number | null;
}

export interface CommitRow {
  id: string;
  stash_name: string;
  source: "put" | "delete" | "rollback" | "import" | "upload" | "change-set" | "revert" | "commit";
  source_id: string | null;
  author: string;
  message: string;
  meta_json: string;
  entry_count: number;
  change_count: number;
  sealed: 0 | 1;
  first_change_id: number | null;
  last_change_id: number | null;
  reverts_commit_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_by: string;
  created_at: number;
}

export interface ChangeSetRow {
  id: string;
  stash_name: string;
  status: "open" | "applied" | "rejected";
  author: string;
  message: string;
  meta_json: string;
  expires_at: number;
  created_by: string;
  created_at: number;
  idempotency_key: string | null;
  request_hash: string | null;
  expected_last_change_id: number | null;
  expected_last_change_prefix: string | null;
  decision_attempt: string | null;
  decided_at: number | null;
  decided_by: string | null;
  decision_reason: string | null;
  commit_id: string | null;
}

export interface ChangeSetEntryRow {
  change_set_id: string;
  stash_name: string;
  path: string;
  op: "put" | "copy" | "delete" | "rollback";
  base_version: number | null;
  blob_hash: string | null;
  content_storage: "legacy" | "bytes" | null;
  representation: "text" | "binary" | null;
  content_type: string | null;
  size_bytes: number | null;
  rollback_to: number | null;
  copied_from_path: string | null;
  copied_from_version: number | null;
  application_etag: string | null;
}

export type UploadSessionState =
  "open" | "uploaded" | "finalizing" | "committed" | "aborted" | "expired" | "stale" | "failed";

export interface UploadSessionRow {
  id: string;
  stash_name: string;
  path: string;
  principal_kind: "admin" | "stash";
  principal_id: string | null;
  expected_version: number | null;
  declared_size: number;
  declared_hash: string | null;
  representation: "text" | "binary";
  content_type: string;
  upload_mode: "single" | "multipart";
  storage_tier: "d1" | "r2";
  part_size: number | null;
  state: UploadSessionState;
  expires_at: number;
  attempt_generation: number;
  create_fingerprint: string;
  upload_fingerprint: string | null;
  complete_fingerprint: string | null;
  uploaded_size: number | null;
  uploaded_hash: string | null;
  staged_r2_key: string | null;
  r2_upload_id: string | null;
  r2_completed_at: number | null;
  verification_completed_at: number | null;
  finalization_lease_owner: string | null;
  finalization_lease_until: number | null;
  result_status: number | null;
  result_json: string | null;
  error_code: string | null;
  reservation_released_at: number | null;
  created_at: number;
  updated_at: number;
  skip_if_unchanged: 0 | 1;
  event_published_at: number | null;
  event_publish_owner: string | null;
  event_publish_until: number | null;
  event_origin: string | null;
}

export interface UploadStagedBytesRow {
  session_id: string;
  generation: number;
  body_bytes: ArrayBuffer;
  size_bytes: number;
  hash: string;
  created_at: number;
}

export interface UploadPartRow {
  session_id: string;
  generation: number;
  part_number: number;
  size_bytes: number;
  r2_etag: string;
  recorded_at: number;
}

export interface UploadPartWriteRow {
  session_id: string;
  generation: number;
  part_number: number;
  owner: string;
  started_at: number;
}

export interface UploadObjectRow {
  object_key: string;
  session_id: string;
  generation: number;
  purpose: "multipart" | "staging" | "committed";
  created_at: number;
  completed_at: number | null;
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
  "change_set_entries",
  "change_sets",
  "commits",
  "idempotency",
  "gc_jobs",
  "gc_runs",
  "byte_blobs",
  "upload_sessions",
  "upload_staged_bytes",
  "upload_parts",
  "upload_part_writes",
  "upload_objects",
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
    "representation",
    "application_etag",
    "content_storage",
    "commit_id",
    "copied_from_path",
    "copied_from_version",
  ],
  change_set_entries: [
    "change_set_id",
    "stash_name",
    "path",
    "op",
    "base_version",
    "blob_hash",
    "content_storage",
    "representation",
    "content_type",
    "size_bytes",
    "rollback_to",
    "copied_from_path",
    "copied_from_version",
    "application_etag",
  ],
  change_sets: [
    "id",
    "stash_name",
    "status",
    "author",
    "message",
    "meta_json",
    "expires_at",
    "created_by",
    "created_at",
    "idempotency_key",
    "request_hash",
    "expected_last_change_id",
    "decision_attempt",
    "decided_at",
    "decided_by",
    "decision_reason",
    "commit_id",
    "expected_last_change_prefix",
  ],
  commits: [
    "id",
    "stash_name",
    "source",
    "source_id",
    "author",
    "message",
    "meta_json",
    "entry_count",
    "change_count",
    "sealed",
    "first_change_id",
    "last_change_id",
    "reverts_commit_id",
    "idempotency_key",
    "request_hash",
    "created_by",
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
  byte_blobs: [
    "stash_name",
    "hash",
    "body_bytes",
    "r2_key",
    "storage_generation",
    "size_bytes",
    "created_at",
  ],
  upload_sessions: [
    "id",
    "stash_name",
    "path",
    "principal_kind",
    "principal_id",
    "expected_version",
    "declared_size",
    "declared_hash",
    "representation",
    "content_type",
    "upload_mode",
    "storage_tier",
    "part_size",
    "state",
    "expires_at",
    "attempt_generation",
    "create_fingerprint",
    "upload_fingerprint",
    "complete_fingerprint",
    "uploaded_size",
    "uploaded_hash",
    "staged_r2_key",
    "r2_upload_id",
    "r2_completed_at",
    "verification_completed_at",
    "finalization_lease_owner",
    "finalization_lease_until",
    "result_status",
    "result_json",
    "error_code",
    "reservation_released_at",
    "created_at",
    "updated_at",
    "skip_if_unchanged",
    "event_published_at",
    "event_publish_owner",
    "event_publish_until",
    "event_origin",
  ],
  upload_staged_bytes: [
    "session_id",
    "generation",
    "body_bytes",
    "size_bytes",
    "hash",
    "created_at",
  ],
  upload_parts: ["session_id", "generation", "part_number", "size_bytes", "r2_etag", "recorded_at"],
  upload_part_writes: ["session_id", "generation", "part_number", "owner", "started_at"],
  upload_objects: [
    "object_key",
    "session_id",
    "generation",
    "purpose",
    "created_at",
    "completed_at",
  ],
} as const satisfies Record<(typeof TABLE_NAMES)[number], readonly string[]>;

export interface DatabaseSchema {
  stashes: StashRow;
  tokens: TokenRow;
  blobs: BlobRow;
  files: FileRow;
  versions: VersionRow;
  change_sets: ChangeSetRow;
  change_set_entries: ChangeSetEntryRow;
  idempotency: IdempotencyRow;
  gc_jobs: GcJobRow;
  gc_runs: GcRunRow;
  byte_blobs: ByteBlobRow;
  upload_sessions: UploadSessionRow;
  upload_staged_bytes: UploadStagedBytesRow;
  upload_parts: UploadPartRow;
  upload_part_writes: UploadPartWriteRow;
  upload_objects: UploadObjectRow;
}
