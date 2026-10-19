-- Reviewer edits create immutable revisions in the existing agent-owned email.
ALTER TABLE revisions ADD COLUMN author_reviewer_id TEXT REFERENCES reviewers(id);

CREATE TRIGGER revisions_reviewer_scope BEFORE INSERT ON revisions
WHEN NEW.author_reviewer_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM drafts d JOIN agents a ON a.id = d.owner_agent_id
  WHERE d.id = NEW.draft_id AND a.reviewer_id = NEW.author_reviewer_id
)
BEGIN
  SELECT RAISE(ABORT, 'revision_reviewer_scope');
END;
