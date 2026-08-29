CREATE TABLE commits (
  id                TEXT PRIMARY KEY, /* 'cmt_' + 13-digit epoch ms + 8 hex; legacy: 'cmt_legacy_' || versions.id */
  stash_name        TEXT NOT NULL REFERENCES stashes(name),
  source            TEXT NOT NULL CHECK (source IN ('put','delete','rollback','import','upload','change-set','revert','commit')),
  source_id         TEXT,
  author            TEXT NOT NULL DEFAULT '',
  message           TEXT NOT NULL DEFAULT '',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  entry_count       INTEGER NOT NULL CHECK (entry_count > 0),
  change_count      INTEGER NOT NULL DEFAULT 0,
  sealed            INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
  first_change_id   INTEGER,
  last_change_id    INTEGER,
  reverts_commit_id TEXT,
  idempotency_key   TEXT,
  request_hash      TEXT,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK (sealed = 0 OR (
    change_count = entry_count
    AND first_change_id IS NOT NULL
    AND last_change_id IS NOT NULL
  ))
);

CREATE INDEX commits_stash_created ON commits (stash_name, created_at, id);
CREATE UNIQUE INDEX commits_stash_idempotency
  ON commits (stash_name, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX commits_stash_last_change ON commits (stash_name, last_change_id);

INSERT INTO commits (
  id, stash_name, source, source_id, author, message, meta_json,
  entry_count, change_count, sealed, first_change_id, last_change_id,
  reverts_commit_id, idempotency_key, request_hash, created_by, created_at
)
SELECT
  'cmt_legacy_' || id, stash_name, kind, NULL, author, message, meta_json,
  1, 1, 1, id, id, NULL, NULL, NULL, 'legacy', created_at
FROM versions;

CREATE TABLE versions_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  stash_name        TEXT NOT NULL REFERENCES stashes(name),
  path              TEXT NOT NULL,
  version           INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('put','delete','rollback')),
  blob_hash         TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  content_type      TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
  rollback_of       INTEGER,
  author            TEXT NOT NULL DEFAULT '',
  message           TEXT NOT NULL DEFAULT '',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  representation    TEXT NOT NULL DEFAULT 'text' CHECK (representation IN ('text','binary')),
  application_etag  TEXT,
  content_storage   TEXT NOT NULL DEFAULT 'legacy' CHECK (content_storage IN ('legacy','bytes')),
  commit_id         TEXT NOT NULL REFERENCES commits(id),
  UNIQUE (stash_name, path, version),
  CHECK ((kind = 'delete') = (blob_hash IS NULL)),
  CHECK ((kind = 'rollback') = (rollback_of IS NOT NULL))
);

INSERT INTO versions_new (
  id, stash_name, path, version, kind, blob_hash, size_bytes, content_type,
  rollback_of, author, message, meta_json, created_at, representation,
  application_etag, content_storage, commit_id
)
SELECT
  id, stash_name, path, version, kind, blob_hash, size_bytes, content_type,
  rollback_of, author, message, meta_json, created_at, representation,
  application_etag, content_storage, 'cmt_legacy_' || id
FROM versions;

DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;
CREATE INDEX versions_stash_id ON versions (stash_name, id);
CREATE INDEX versions_stash_commit ON versions (stash_name, commit_id);
