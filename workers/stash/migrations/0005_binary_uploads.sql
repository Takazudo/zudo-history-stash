ALTER TABLE versions ADD COLUMN representation TEXT NOT NULL DEFAULT 'text'
  CHECK (representation IN ('text','binary'));
ALTER TABLE versions ADD COLUMN application_etag TEXT;
ALTER TABLE versions ADD COLUMN content_storage TEXT NOT NULL DEFAULT 'legacy'
  CHECK (content_storage IN ('legacy','bytes'));

CREATE TABLE byte_blobs (
  stash_name         TEXT NOT NULL REFERENCES stashes(name),
  hash               TEXT NOT NULL,
  body_bytes         BLOB,
  r2_key             TEXT,
  storage_generation INTEGER NOT NULL DEFAULT 0,
  size_bytes         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (stash_name, hash),
  CHECK ((body_bytes IS NULL) <> (r2_key IS NULL)),
  CHECK (size_bytes >= 0)
);
CREATE UNIQUE INDEX byte_blobs_r2_key ON byte_blobs (r2_key) WHERE r2_key IS NOT NULL;

CREATE TABLE upload_sessions (
  id                         TEXT PRIMARY KEY,
  stash_name                 TEXT NOT NULL REFERENCES stashes(name),
  path                       TEXT NOT NULL,
  principal_kind             TEXT NOT NULL CHECK (principal_kind IN ('admin','stash')),
  principal_id               TEXT,
  expected_version           INTEGER CHECK (expected_version IS NULL OR expected_version > 0),
  declared_size              INTEGER NOT NULL CHECK (declared_size >= 0),
  declared_hash              TEXT,
  representation             TEXT NOT NULL CHECK (representation IN ('text','binary')),
  content_type               TEXT NOT NULL,
  upload_mode                TEXT NOT NULL CHECK (upload_mode IN ('single','multipart')),
  storage_tier               TEXT NOT NULL CHECK (storage_tier IN ('d1','r2')),
  part_size                  INTEGER CHECK (part_size IS NULL OR part_size > 0),
  state                      TEXT NOT NULL CHECK (state IN ('open','uploaded','finalizing','committed','aborted','expired','stale','failed')),
  expires_at                 INTEGER NOT NULL,
  attempt_generation         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_generation >= 0),
  create_fingerprint         TEXT NOT NULL,
  upload_fingerprint         TEXT,
  complete_fingerprint       TEXT,
  uploaded_size              INTEGER,
  uploaded_hash              TEXT,
  staged_r2_key              TEXT,
  r2_upload_id               TEXT,
  r2_completed_at            INTEGER,
  verification_completed_at  INTEGER,
  finalization_lease_owner   TEXT,
  finalization_lease_until   INTEGER,
  result_status              INTEGER,
  result_json                TEXT,
  error_code                 TEXT,
  reservation_released_at    INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  CHECK ((principal_kind = 'admin') = (principal_id IS NULL)),
  CHECK ((upload_mode = 'multipart') = (part_size IS NOT NULL)),
  CHECK (
    (state = 'finalizing' AND finalization_lease_owner IS NOT NULL AND finalization_lease_until IS NOT NULL)
    OR
    (state <> 'finalizing' AND finalization_lease_owner IS NULL AND finalization_lease_until IS NULL)
  ),
  CHECK ((result_status IS NULL) = (result_json IS NULL))
);
CREATE INDEX upload_sessions_stash_state ON upload_sessions (stash_name, state, expires_at);
CREATE UNIQUE INDEX upload_sessions_create_replay
  ON upload_sessions (stash_name, create_fingerprint);

CREATE TABLE upload_staged_bytes (
  session_id  TEXT NOT NULL REFERENCES upload_sessions(id),
  generation  INTEGER NOT NULL CHECK (generation >= 0),
  body_bytes  BLOB NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation)
);

CREATE TABLE upload_parts (
  session_id  TEXT NOT NULL REFERENCES upload_sessions(id),
  generation  INTEGER NOT NULL CHECK (generation >= 0),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_etag     TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, part_number)
);

CREATE TABLE upload_objects (
  object_key  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES upload_sessions(id),
  generation  INTEGER NOT NULL CHECK (generation >= 0),
  purpose     TEXT NOT NULL CHECK (purpose IN ('multipart','staging','committed')),
  created_at  INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (session_id, generation, purpose)
);
CREATE INDEX upload_objects_session ON upload_objects (session_id, generation);
