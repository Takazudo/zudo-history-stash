ALTER TABLE upload_sessions ADD COLUMN commit_author TEXT;
ALTER TABLE upload_sessions ADD COLUMN commit_message TEXT;
ALTER TABLE upload_sessions ADD COLUMN commit_meta_json TEXT;
