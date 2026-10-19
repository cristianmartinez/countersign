ALTER TABLE reviewers ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reviewer_sessions ADD COLUMN csrf_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE reviewer_sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE login_throttles (
 scope_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
) STRICT;
CREATE INDEX throttle_window ON login_throttles(window_start);
UPDATE scaffold_metadata SET schema_version=4 WHERE id=1;
