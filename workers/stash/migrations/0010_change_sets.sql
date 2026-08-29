CREATE TABLE change_sets (
  id                      TEXT PRIMARY KEY, /* 'chs_' + 13-digit epoch ms + 8 hex */
  stash_name              TEXT NOT NULL REFERENCES stashes(name),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','rejected')),
  author                  TEXT NOT NULL DEFAULT '',
  message                 TEXT NOT NULL DEFAULT '',
  meta_json               TEXT NOT NULL DEFAULT '{}',
  expires_at              INTEGER NOT NULL,
  created_by              TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  idempotency_key         TEXT,
  request_hash            TEXT,
  expected_last_change_id INTEGER,
  decision_attempt        TEXT,
  decided_at              INTEGER,
  decided_by              TEXT,
  decision_reason         TEXT,
  commit_id               TEXT REFERENCES commits(id)
);

CREATE INDEX change_sets_stash_status_created
  ON change_sets (stash_name, status, created_at, id);
CREATE UNIQUE INDEX change_sets_stash_idempotency
  ON change_sets (stash_name, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE change_set_entries (
  change_set_id       TEXT NOT NULL REFERENCES change_sets(id),
  stash_name          TEXT NOT NULL REFERENCES stashes(name),
  path                TEXT NOT NULL,
  op                  TEXT NOT NULL CHECK (op IN ('put','copy','delete','rollback')),
  base_version        INTEGER CHECK (base_version IS NULL OR base_version > 0),
  blob_hash           TEXT,
  content_storage     TEXT CHECK (content_storage IN ('legacy','bytes')),
  representation      TEXT CHECK (representation IN ('text','binary')),
  content_type        TEXT,
  size_bytes          INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  rollback_to         INTEGER,
  copied_from_path    TEXT,
  copied_from_version INTEGER,
  PRIMARY KEY (change_set_id, path),
  CHECK ((op = 'rollback') = (rollback_to IS NOT NULL)),
  CHECK (op <> 'delete' OR blob_hash IS NULL),
  CHECK (op <> 'put' OR blob_hash IS NOT NULL)
);

CREATE INDEX change_set_entries_stash_path ON change_set_entries (stash_name, path);
