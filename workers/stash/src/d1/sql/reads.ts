/**
 * Read queries deliberately use explicit projections.  The store never needs
 * to materialize a blob while listing files, history, or changes, and keeping
 * the projections here makes that boundary easy to audit.
 */

export const SELECT_FILE_HEAD = `
  SELECT
    f.path AS path,
    v.version AS version,
    v.blob_hash AS hash,
    v.size_bytes AS size,
    v.kind AS kind,
    v.rollback_of AS rollback_of,
    v.author AS author,
    v.message AS message,
    v.meta_json AS meta_json,
    v.created_at AS created_at,
    v.content_type AS content_type,
    CASE WHEN v.kind = 'delete' THEN 1 ELSE 0 END AS deleted,
    b.body AS body
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
   AND v.version = f.head_version
  LEFT JOIN blobs AS b
    ON b.stash_name = v.stash_name
   AND b.hash = v.blob_hash
  WHERE f.stash_name = ?
    AND f.path = ?
  LIMIT 1
`;

export const SELECT_FILE_VERSION = `
  SELECT
    f.path AS path,
    v.version AS version,
    v.blob_hash AS hash,
    v.size_bytes AS size,
    v.kind AS kind,
    v.rollback_of AS rollback_of,
    v.author AS author,
    v.message AS message,
    v.meta_json AS meta_json,
    v.created_at AS created_at,
    v.content_type AS content_type,
    CASE WHEN v.kind = 'delete' THEN 1 ELSE 0 END AS deleted,
    b.body AS body
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
  LEFT JOIN blobs AS b
    ON b.stash_name = v.stash_name
   AND b.hash = v.blob_hash
  WHERE f.stash_name = ?
    AND f.path = ?
    AND v.version = ?
  LIMIT 1
`;

export const SELECT_FILES = `
  SELECT
    f.path AS path,
    f.head_version AS head_version,
    f.head_hash AS hash,
    v.size_bytes AS size,
    f.deleted AS deleted,
    f.updated_at AS updated_at
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
   AND v.version = f.head_version
  WHERE f.stash_name = ?
    AND (? = 1 OR f.deleted = 0)
    AND (? IS NULL OR f.path > ?)
  ORDER BY f.path ASC
  LIMIT ?
`;

export const SELECT_HISTORY_HEAD = `
  SELECT
    f.head_version AS head_version,
    f.deleted AS deleted,
    COUNT(v.version) AS total
  FROM files AS f
  LEFT JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
  WHERE f.stash_name = ?
    AND f.path = ?
  GROUP BY f.head_version, f.deleted
  LIMIT 1
`;

export const SELECT_HISTORY_VERSIONS = `
  SELECT
    v.version AS version,
    v.kind AS kind,
    v.blob_hash AS hash,
    v.size_bytes AS size,
    v.rollback_of AS rollback_of,
    v.author AS author,
    v.message AS message,
    v.meta_json AS meta_json,
    v.created_at AS created_at
  FROM versions AS v
  WHERE v.stash_name = ?
    AND v.path = ?
    AND (? IS NULL OR v.version < ?)
  ORDER BY v.version DESC
  LIMIT ?
`;

export const SELECT_CHANGES_ASC = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at
  FROM versions AS v
  WHERE v.stash_name = ?
    AND v.id > ?
  ORDER BY v.id ASC
  LIMIT ?
`;

export const SELECT_CHANGES_BEFORE = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at
  FROM versions AS v
  WHERE v.stash_name = ?
    AND v.id < ?
  ORDER BY v.id DESC
  LIMIT ?
`;

export const SELECT_CHANGES_NEWEST = `
  SELECT
    v.id AS change_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at
  FROM versions AS v
  WHERE v.stash_name = ?
  ORDER BY v.id DESC
  LIMIT ?
`;

export interface FileReadRow {
  path: string;
  version: number;
  hash: string | null;
  size: number;
  kind: "put" | "delete" | "rollback";
  rollback_of: number | null;
  author: string;
  message: string;
  meta_json: string;
  created_at: number;
  content_type: string;
  deleted: number;
  body: string | null;
}

export interface FileSummaryRow {
  path: string;
  head_version: number;
  hash: string | null;
  size: number;
  deleted: number;
  updated_at: number;
}

export interface HistoryHeadRow {
  head_version: number;
  deleted: number;
  total: number;
}

export interface HistoryVersionRow {
  version: number;
  kind: "put" | "delete" | "rollback";
  hash: string | null;
  size: number;
  rollback_of: number | null;
  author: string;
  message: string;
  meta_json: string;
  created_at: number;
}

export interface ChangeRow {
  change_id: number;
  stash: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  author: string;
  message: string;
  size: number;
  created_at: number;
}
