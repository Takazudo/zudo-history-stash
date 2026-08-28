ALTER TABLE upload_sessions ADD COLUMN skip_if_unchanged INTEGER NOT NULL DEFAULT 0
  CHECK (skip_if_unchanged IN (0, 1));
ALTER TABLE upload_sessions ADD COLUMN event_published_at INTEGER;
