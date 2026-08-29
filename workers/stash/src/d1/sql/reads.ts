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
    v.representation AS representation,
    v.application_etag AS application_etag,
    v.content_storage AS content_storage,
    CASE WHEN v.kind = 'delete' THEN 1 ELSE 0 END AS deleted,
    CASE v.content_storage WHEN 'legacy' THEN lb.hash ELSE bb.hash END AS stored_hash,
    CASE v.content_storage WHEN 'legacy' THEN lb.size_bytes ELSE bb.size_bytes END AS stored_size,
    CASE v.content_storage WHEN 'legacy' THEN lb.r2_key ELSE bb.r2_key END AS stored_r2_key
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
   AND v.version = f.head_version
  LEFT JOIN blobs AS lb
    ON v.content_storage = 'legacy'
   AND lb.stash_name = v.stash_name
   AND lb.hash = v.blob_hash
  LEFT JOIN byte_blobs AS bb
    ON v.content_storage = 'bytes'
   AND bb.stash_name = v.stash_name
   AND bb.hash = v.blob_hash
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
    v.representation AS representation,
    v.application_etag AS application_etag,
    v.content_storage AS content_storage,
    CASE WHEN v.kind = 'delete' THEN 1 ELSE 0 END AS deleted,
    CASE v.content_storage WHEN 'legacy' THEN lb.hash ELSE bb.hash END AS stored_hash,
    CASE v.content_storage WHEN 'legacy' THEN lb.size_bytes ELSE bb.size_bytes END AS stored_size,
    CASE v.content_storage WHEN 'legacy' THEN lb.r2_key ELSE bb.r2_key END AS stored_r2_key
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
  LEFT JOIN blobs AS lb
    ON v.content_storage = 'legacy'
   AND lb.stash_name = v.stash_name
   AND lb.hash = v.blob_hash
  LEFT JOIN byte_blobs AS bb
    ON v.content_storage = 'bytes'
   AND bb.stash_name = v.stash_name
   AND bb.hash = v.blob_hash
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
    f.updated_at AS updated_at,
    v.content_type AS content_type,
    v.representation AS representation,
    v.application_etag AS application_etag
  FROM files AS f
  JOIN versions AS v
    ON v.stash_name = f.stash_name
   AND v.path = f.path
   AND v.version = f.head_version
  WHERE f.stash_name = ?
    AND (? = 1 OR f.deleted = 0)
    AND (? IS NULL OR (f.path >= ? AND f.path < ?))
    AND (? IS NULL OR f.path > ?)
    AND (? IS NULL OR instr(substr(f.path, length(COALESCE(?, '')) + 1), '/') = 0)
  ORDER BY f.path ASC
  LIMIT ?
`;

export const SELECT_FILE_COMMON_PREFIXES = `
  SELECT DISTINCT
    substr(
      f.path,
      1,
      length(COALESCE(?, '')) +
        instr(substr(f.path, length(COALESCE(?, '')) + 1), '/')
    ) AS common_prefix
  FROM files AS f
  WHERE f.stash_name = ?
    AND (? = 1 OR f.deleted = 0)
    AND (? IS NULL OR (f.path >= ? AND f.path < ?))
    AND (? IS NULL OR (
      substr(
        f.path,
        1,
        length(COALESCE(?, '')) +
          instr(substr(f.path, length(COALESCE(?, '')) + 1), '/')
      ) > ?
    ))
    AND (? IS NOT NULL)
    AND instr(substr(f.path, length(COALESCE(?, '')) + 1), '/') > 0
  ORDER BY common_prefix ASC
  LIMIT ?
`;

export const SELECT_SNAPSHOT_COMMIT = `
  SELECT id AS commit_id, last_change_id
  FROM commits
  WHERE stash_name = ?
    AND id = ?
    AND sealed = 1
    AND last_change_id IS NOT NULL
  LIMIT 1
`;

export const SELECT_SNAPSHOT_FILES = `
  SELECT
    f.path AS path,
    s.version AS head_version,
    s.blob_hash AS hash,
    s.size_bytes AS size,
    CASE WHEN s.kind = 'delete' THEN 1 ELSE 0 END AS deleted,
    s.created_at AS updated_at,
    s.content_type AS content_type,
    s.representation AS representation,
    s.application_etag AS application_etag
  FROM files AS f
  JOIN versions AS s
    ON s.id = (
      SELECT v.id
      FROM versions AS v
      WHERE v.stash_name = f.stash_name
        AND v.path = f.path
        AND v.id <= ?
      ORDER BY v.version DESC
      LIMIT 1
    )
  WHERE f.stash_name = ?
    AND (? = 1 OR s.kind <> 'delete')
    AND (? IS NULL OR (f.path >= ? AND f.path < ?))
    AND (? IS NULL OR f.path > ?)
    AND (? IS NULL OR instr(substr(f.path, length(COALESCE(?, '')) + 1), '/') = 0)
  ORDER BY f.path ASC
  LIMIT ?
`;

export const SELECT_SNAPSHOT_COMMON_PREFIXES = `
  SELECT DISTINCT
    substr(
      f.path,
      1,
      length(COALESCE(?, '')) +
        instr(substr(f.path, length(COALESCE(?, '')) + 1), '/')
    ) AS common_prefix
  FROM files AS f
  JOIN versions AS s
    ON s.id = (
      SELECT v.id
      FROM versions AS v
      WHERE v.stash_name = f.stash_name
        AND v.path = f.path
        AND v.id <= ?
      ORDER BY v.version DESC
      LIMIT 1
    )
  WHERE f.stash_name = ?
    AND (? = 1 OR s.kind <> 'delete')
    AND (? IS NULL OR (f.path >= ? AND f.path < ?))
    AND (? IS NULL OR (
      substr(
        f.path,
        1,
        length(COALESCE(?, '')) +
          instr(substr(f.path, length(COALESCE(?, '')) + 1), '/')
      ) > ?
    ))
    AND (? IS NOT NULL)
    AND instr(substr(f.path, length(COALESCE(?, '')) + 1), '/') > 0
  ORDER BY common_prefix ASC
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
    v.id AS change_id,
    v.commit_id AS commit_id,
    v.version AS version,
    v.kind AS kind,
    v.blob_hash AS hash,
    v.size_bytes AS size,
    v.rollback_of AS rollback_of,
    v.author AS author,
    v.message AS message,
    v.meta_json AS meta_json,
    v.created_at AS created_at,
    v.content_type AS content_type,
    v.representation AS representation,
    v.application_etag AS application_etag
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
    v.commit_id AS commit_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.blob_hash AS hash,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at,
    v.content_type AS content_type,
    v.representation AS representation,
    v.application_etag AS application_etag
  FROM versions AS v
  WHERE v.stash_name = ?
    AND v.id > ?
  ORDER BY v.id ASC
  LIMIT ?
`;

export const SELECT_CHANGES_BEFORE = `
  SELECT
    v.id AS change_id,
    v.commit_id AS commit_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.blob_hash AS hash,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at,
    v.content_type AS content_type,
    v.representation AS representation,
    v.application_etag AS application_etag
  FROM versions AS v
  WHERE v.stash_name = ?
    AND v.id < ?
  ORDER BY v.id DESC
  LIMIT ?
`;

export const SELECT_CHANGES_NEWEST = `
  SELECT
    v.id AS change_id,
    v.commit_id AS commit_id,
    v.stash_name AS stash,
    v.path AS path,
    v.version AS version,
    v.kind AS kind,
    v.blob_hash AS hash,
    v.author AS author,
    v.message AS message,
    v.size_bytes AS size,
    v.created_at AS created_at,
    v.content_type AS content_type,
    v.representation AS representation,
    v.application_etag AS application_etag
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
  representation: "text" | "binary";
  application_etag: string | null;
  content_storage: "legacy" | "bytes";
  deleted: number;
  stored_hash: string | null;
  stored_size: number | null;
  stored_r2_key: string | null;
}

export interface FileSummaryRow {
  path: string;
  head_version: number;
  hash: string | null;
  size: number;
  deleted: number;
  updated_at: number;
  content_type: string;
  representation: "text" | "binary";
  application_etag: string | null;
}

export interface HistoryHeadRow {
  head_version: number;
  deleted: number;
  total: number;
}

export interface HistoryVersionRow {
  change_id: number;
  commit_id: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  hash: string | null;
  size: number;
  rollback_of: number | null;
  author: string;
  message: string;
  meta_json: string;
  created_at: number;
  content_type: string;
  representation: "text" | "binary";
  application_etag: string | null;
}

export interface ChangeRow {
  change_id: number;
  commit_id: string;
  stash: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  hash: string | null;
  author: string;
  message: string;
  size: number;
  created_at: number;
  content_type: string;
  representation: "text" | "binary";
  application_etag: string | null;
}
