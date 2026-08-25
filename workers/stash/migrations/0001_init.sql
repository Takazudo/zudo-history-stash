CREATE TABLE stashes (
  name        TEXT PRIMARY KEY,               /* ^[a-z0-9][a-z0-9-]{0,62}$ */
  description TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,             /* 'tok_' + 16 hex */
  stash_name    TEXT NOT NULL REFERENCES stashes(name),
  token_hash    TEXT NOT NULL UNIQUE,         /* sha256 hex of the 'zhs_...' secret */
  label         TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT 'write' CHECK (scope IN ('read','write')),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER
);
CREATE INDEX tokens_stash ON tokens (stash_name, created_at);
CREATE TABLE blobs (                          /* content-addressed, per stash */
  stash_name  TEXT NOT NULL REFERENCES stashes(name),
  hash        TEXT NOT NULL,                  /* 'sha256-' + 64 hex over the UTF-8 bytes */
  body        TEXT,                           /* v1: always set */
  r2_key      TEXT,                           /* reserved seam, NULL in v1 */
  size_bytes  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (stash_name, hash),
  CHECK ((body IS NULL) <> (r2_key IS NULL))
);
CREATE TABLE files (                          /* mutable head pointer; rows never deleted */
  stash_name    TEXT NOT NULL REFERENCES stashes(name),
  path          TEXT NOT NULL,
  head_version  INTEGER NOT NULL,
  head_hash     TEXT,                         /* NULL iff deleted = 1 */
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (stash_name, path),
  CHECK ((deleted = 1) = (head_hash IS NULL))
);
CREATE INDEX files_stash_updated ON files (stash_name, updated_at);
CREATE TABLE versions (                       /* append-only; never UPDATE/DELETE */
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   /* DB-global change cursor */
  stash_name    TEXT NOT NULL REFERENCES stashes(name),
  path          TEXT NOT NULL,
  version       INTEGER NOT NULL,             /* per file, 1..n contiguous */
  kind          TEXT NOT NULL CHECK (kind IN ('put','delete','rollback')),
  blob_hash     TEXT,                         /* NULL only for kind='delete' (tombstone) */
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  content_type  TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
  rollback_of   INTEGER,                      /* set iff kind='rollback' */
  author        TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  UNIQUE (stash_name, path, version),
  CHECK ((kind = 'delete') = (blob_hash IS NULL)),
  CHECK ((kind = 'rollback') = (rollback_of IS NOT NULL))
);
CREATE INDEX versions_stash_id ON versions (stash_name, id);
CREATE TABLE idempotency (
  stash_name    TEXT NOT NULL,
  key           TEXT NOT NULL,                /* Idempotency-Key header, 1..200 chars */
  request_hash  TEXT NOT NULL,                /* sha256 of the canonical request JSON (see Write protocol) */
  path          TEXT NOT NULL,
  version       INTEGER NOT NULL,             /* -> the versions row this request created; replay rebuilds the response from it */
  status_code   INTEGER NOT NULL,             /* original status (201/200), replayed verbatim */
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (stash_name, key)
);
CREATE INDEX idempotency_created ON idempotency (created_at);
