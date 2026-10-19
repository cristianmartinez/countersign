-- Derived invalidation metadata: unchanged polls read one indexed agent row.
ALTER TABLE agents ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER review_version_draft_insert AFTER INSERT ON drafts BEGIN
  UPDATE agents SET review_version = review_version + 1 WHERE id = NEW.owner_agent_id;
END;
CREATE TRIGGER review_version_draft_update AFTER UPDATE ON drafts BEGIN
  UPDATE agents SET review_version = review_version + 1 WHERE id = NEW.owner_agent_id;
END;
CREATE TRIGGER review_version_send_insert AFTER INSERT ON sends BEGIN
  UPDATE agents SET review_version = review_version + 1
  WHERE id = (SELECT d.owner_agent_id FROM drafts d JOIN revisions r ON r.draft_id = d.id WHERE r.id = NEW.revision_id);
END;
CREATE TRIGGER review_version_send_update AFTER UPDATE ON sends BEGIN
  UPDATE agents SET review_version = review_version + 1
  WHERE id = (SELECT d.owner_agent_id FROM drafts d JOIN revisions r ON r.draft_id = d.id WHERE r.id = NEW.revision_id);
END;
CREATE TRIGGER review_version_event_update AFTER UPDATE OF applied_at ON delivery_events
WHEN NEW.applied_at IS NOT NULL AND OLD.applied_at IS NULL AND NEW.send_id IS NOT NULL BEGIN
  UPDATE agents SET review_version = review_version + 1
  WHERE id = (SELECT d.owner_agent_id FROM drafts d JOIN revisions r ON r.draft_id = d.id JOIN sends s ON s.revision_id = r.id WHERE s.id = NEW.send_id);
END;
CREATE TRIGGER review_version_event_insert AFTER INSERT ON delivery_events
WHEN NEW.applied_at IS NOT NULL AND NEW.send_id IS NOT NULL BEGIN
  UPDATE agents SET review_version = review_version + 1
  WHERE id = (SELECT d.owner_agent_id FROM drafts d JOIN revisions r ON r.draft_id = d.id JOIN sends s ON s.revision_id = r.id WHERE s.id = NEW.send_id);
END;
