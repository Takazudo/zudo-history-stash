import type { PreparedBlob } from "../blobs.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

const LIVE_STASH = "EXISTS (SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL)";

export interface ProposalInsert {
  id: string;
  stash: string;
  path: string;
  baseVersion: number | null;
  hash: string;
  size: number;
  author: string;
  message: string;
  metaJson: string;
  expiresAt: number;
  createdAt: number;
  idempotencyKey: string | null;
  requestHash: string | null;
}

export type CreateProposalBatchInput = ProposalInsert & PreparedBlob;

export function createProposalBatch(
  db: Preparer,
  input: CreateProposalBatchInput,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${LIVE_STASH}
         ON CONFLICT(stash_name, hash) DO NOTHING`,
      )
      .bind(
        input.stash,
        input.hash,
        input.body,
        input.r2_key,
        input.size,
        input.createdAt,
        input.stash,
      ),
    db
      .prepare(
        `INSERT INTO proposals
           (id, stash_name, path, base_version, blob_hash, size_bytes, author, message,
            meta_json, expires_at, created_at, idempotency_key, request_hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${LIVE_STASH}`,
      )
      .bind(
        input.id,
        input.stash,
        input.path,
        input.baseVersion,
        input.hash,
        input.size,
        input.author,
        input.message,
        input.metaJson,
        input.expiresAt,
        input.createdAt,
        input.idempotencyKey,
        input.requestHash,
        input.stash,
      ),
  ];
}

export const SELECT_PROPOSAL = `
  SELECT p.id, p.stash_name, p.path, p.base_version, p.blob_hash, p.size_bytes,
    p.author, p.message, p.meta_json, p.status, p.expires_at, p.created_at,
    p.idempotency_key, p.request_hash, p.decision_attempt, p.decided_at, p.decided_by,
    p.decision_reason, p.applied_version, p.applied_change_id,
    b.body AS blob_body, b.r2_key AS blob_r2_key, b.size_bytes AS blob_size
  FROM proposals p
  JOIN stashes s ON s.name = p.stash_name AND s.deleted_at IS NULL
  LEFT JOIN blobs b ON b.stash_name = p.stash_name AND b.hash = p.blob_hash
  WHERE p.stash_name = ? AND p.id = ?
  LIMIT 1
`;

export const SELECT_PROPOSAL_BY_KEY = `
  SELECT p.id, p.stash_name, p.path, p.base_version, p.blob_hash, p.size_bytes,
    p.author, p.message, p.meta_json, p.status, p.expires_at, p.created_at,
    p.idempotency_key, p.request_hash, p.decision_attempt, p.decided_at, p.decided_by,
    p.decision_reason, p.applied_version, p.applied_change_id,
    b.body AS blob_body, b.r2_key AS blob_r2_key, b.size_bytes AS blob_size
  FROM proposals p
  JOIN stashes s ON s.name = p.stash_name AND s.deleted_at IS NULL
  LEFT JOIN blobs b ON b.stash_name = p.stash_name AND b.hash = p.blob_hash
  WHERE p.stash_name = ? AND p.idempotency_key = ?
  LIMIT 1
`;

export interface ListProposalSqlInput {
  stash: string;
  status: "open" | "applied" | "rejected" | "expired" | "all";
  path: string | null;
  now: number;
  after: { createdAt: number; id: string } | null;
  limit: number;
}

function statusPredicate(status: ListProposalSqlInput["status"]): string {
  if (status === "all") return "1 = 1";
  if (status === "open") return "p.status = 'open' AND p.expires_at > ?";
  if (status === "expired") return "p.status = 'open' AND p.expires_at <= ?";
  return "p.status = ?";
}

function statusParams(input: ListProposalSqlInput): unknown[] {
  return input.status === "all"
    ? []
    : input.status === "open" || input.status === "expired"
      ? [input.now]
      : [input.status];
}

export function selectProposals(db: Preparer, input: ListProposalSqlInput): D1PreparedStatement {
  const cursor = input.after;
  return db
    .prepare(
      `SELECT p.id, p.stash_name, p.path, p.base_version, p.blob_hash, p.size_bytes,
         p.author, p.message, p.meta_json, p.status, p.expires_at, p.created_at,
         p.idempotency_key, p.request_hash, p.decision_attempt, p.decided_at, p.decided_by,
         p.decision_reason, p.applied_version, p.applied_change_id
       FROM proposals p
       JOIN stashes s ON s.name = p.stash_name AND s.deleted_at IS NULL
       WHERE p.stash_name = ?
         AND ${statusPredicate(input.status)}
         AND (? IS NULL OR p.path = ?)
         AND (? IS NULL OR p.created_at < ? OR (p.created_at = ? AND p.id < ?))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(
      input.stash,
      ...statusParams(input),
      input.path,
      input.path,
      cursor?.id ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      input.limit,
    );
}

export function countProposals(
  db: Preparer,
  input: Omit<ListProposalSqlInput, "after" | "limit">,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM proposals p
       JOIN stashes s ON s.name = p.stash_name AND s.deleted_at IS NULL
       WHERE p.stash_name = ?
         AND ${statusPredicate(input.status)}
         AND (? IS NULL OR p.path = ?)`,
    )
    .bind(
      input.stash,
      ...statusParams({ ...input, after: null, limit: 1 }),
      input.path,
      input.path,
    );
}

export const SELECT_PROPOSAL_BASE = `
  SELECT v.version, v.kind, v.blob_hash, v.size_bytes,
    b.body AS blob_body, b.r2_key AS blob_r2_key, b.size_bytes AS blob_size
  FROM versions v
  JOIN stashes s ON s.name = v.stash_name AND s.deleted_at IS NULL
  LEFT JOIN blobs b ON b.stash_name = v.stash_name AND b.hash = v.blob_hash
  WHERE v.stash_name = ? AND v.path = ? AND v.version = ?
  LIMIT 1
`;

export const SELECT_PROPOSAL_CURRENT = `
  SELECT f.head_version, f.head_hash, f.deleted, v.kind, v.author, v.created_at
  FROM files f
  JOIN stashes s ON s.name = f.stash_name AND s.deleted_at IS NULL
  JOIN versions v ON v.stash_name = f.stash_name AND v.path = f.path
    AND v.version = f.head_version
  WHERE f.stash_name = ? AND f.path = ?
  LIMIT 1
`;
