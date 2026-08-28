CREATE TABLE upload_part_writes (
  session_id  TEXT NOT NULL REFERENCES upload_sessions(id),
  generation  INTEGER NOT NULL CHECK (generation >= 0),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  owner       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, part_number)
);

CREATE INDEX upload_part_writes_started ON upload_part_writes (started_at);
