DROP TABLE gc_runs;
DROP TABLE gc_jobs;

CREATE TABLE gc_jobs (
  kind TEXT PRIMARY KEY CHECK (kind IN ('r2-orphans', 'ledger', 'content', 'change-sets')),
  next_cursor TEXT,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO gc_jobs (kind, updated_at)
VALUES ('r2-orphans', 0), ('ledger', 0), ('content', 0), ('change-sets', 0);

CREATE TABLE gc_runs (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL REFERENCES gc_jobs(kind),
  lease_generation INTEGER NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  input_cursor TEXT,
  next_cursor TEXT,
  scanned INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX gc_runs_job_started ON gc_runs (job_kind, started_at DESC, id DESC);
CREATE INDEX change_sets_status_id ON change_sets (status, id);
