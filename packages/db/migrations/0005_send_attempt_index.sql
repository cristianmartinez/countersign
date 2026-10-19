-- Retry exhaustion and reconciliation inspect an intent's reservation history.
CREATE INDEX send_attempts_send_outcome ON send_attempts(send_id,outcome);
UPDATE scaffold_metadata SET schema_version=5 WHERE id=1;
