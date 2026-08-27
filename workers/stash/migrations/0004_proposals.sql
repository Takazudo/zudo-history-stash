CREATE TABLE proposals (
  id                TEXT PRIMARY KEY,             /* 'prp_' + 13-digit epoch milliseconds + 8 hex */
  stash_name        TEXT NOT NULL REFERENCES stashes(name),
  path              TEXT NOT NULL,
  base_version      INTEGER,
  blob_hash         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  author            TEXT NOT NULL DEFAULT '',
  message           TEXT NOT NULL DEFAULT '',
  meta_json         TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'rejected')),
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  idempotency_key   TEXT,
  request_hash      TEXT,
  decision_attempt  TEXT,
  decided_at        INTEGER,
  decided_by        TEXT,
  decision_reason   TEXT,
  applied_version   INTEGER,
  applied_change_id INTEGER
);
CREATE INDEX proposals_stash_status_created ON proposals (stash_name, status, created_at, id);
CREATE INDEX proposals_stash_path ON proposals (stash_name, path);
CREATE UNIQUE INDEX proposals_stash_idempotency
  ON proposals (stash_name, idempotency_key) WHERE idempotency_key IS NOT NULL;
