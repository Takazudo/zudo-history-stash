ALTER TABLE versions ADD COLUMN copied_from_path TEXT;
ALTER TABLE versions ADD COLUMN copied_from_version INTEGER;
ALTER TABLE change_set_entries ADD COLUMN application_etag TEXT;
