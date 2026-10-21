CREATE TABLE reviewer_access_links (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX reviewer_access_links_reviewer ON reviewer_access_links(reviewer_id);
ALTER TABLE reviewer_sessions ADD COLUMN access_token_hash TEXT REFERENCES reviewer_access_links(token_hash);
UPDATE scaffold_metadata SET schema_version=9 WHERE id=1;
