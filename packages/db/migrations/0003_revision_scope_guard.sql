-- Updates can be checked immediately; creation uses the deferred circular FK.
CREATE TRIGGER drafts_revision_scope BEFORE UPDATE OF current_revision_id ON drafts
 WHEN NOT EXISTS(SELECT 1 FROM revisions WHERE draft_id=NEW.id AND id=NEW.current_revision_id)
 BEGIN SELECT RAISE(ABORT,'revision_draft_mismatch'); END;
UPDATE scaffold_metadata SET schema_version=3 WHERE id=1;
