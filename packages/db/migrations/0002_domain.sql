CREATE TABLE reviewers (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, allowed_recipient_email TEXT NOT NULL
) STRICT;
CREATE TABLE agents (
 id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL UNIQUE REFERENCES reviewers(id),
 name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_ciphertext TEXT NOT NULL,
 key_nonce TEXT NOT NULL, key_encryption_version INTEGER NOT NULL
) STRICT;
CREATE TABLE reviewer_sessions (
 token_hash TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expiry ON reviewer_sessions(expires_at);
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL REFERENCES agents(id),
 status TEXT NOT NULL CHECK(status IN ('drafted','in_review','rejected','approved','sending','sent','delivered','bounced','failed')),
 current_revision_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 FOREIGN KEY(id,current_revision_id) REFERENCES revisions(draft_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX drafts_owner_created ON drafts(owner_agent_id,created_at DESC,id DESC);
CREATE TABLE revisions (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) DEFERRABLE INITIALLY DEFERRED,
 number INTEGER NOT NULL CHECK(number > 0), author_agent_id TEXT NOT NULL REFERENCES agents(id),
 base_revision_id TEXT REFERENCES revisions(id), sender TEXT NOT NULL, recipient TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
 text_body TEXT, html_body TEXT, content_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 CHECK(length(COALESCE(text_body,'')) > 0 OR length(COALESCE(html_body,'')) > 0),
 UNIQUE(draft_id,number), UNIQUE(draft_id,id)
) STRICT;
CREATE TRIGGER revisions_immutable_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
CREATE TRIGGER revisions_immutable_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
CREATE TABLE reviews (
 id TEXT PRIMARY KEY, revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),
 reviewer_id TEXT NOT NULL REFERENCES reviewers(id), content_hash TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), reason TEXT,
 created_at INTEGER NOT NULL, CHECK(decision != 'rejected' OR length(trim(reason)) > 0)
) STRICT;
CREATE TRIGGER reviews_immutable BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT,'immutable_review'); END;
CREATE TABLE sends (
 id TEXT PRIMARY KEY, revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),
 review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id), idempotency_key TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','retry_wait','sent','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
 next_attempt_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
 first_attempt_at INTEGER, retry_deadline INTEGER, resend_email_id TEXT UNIQUE,
 last_error TEXT, needs_reconciliation INTEGER NOT NULL DEFAULT 0 CHECK(needs_reconciliation IN (0,1)),
 delivery_status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sends_due ON sends(state,next_attempt_at);
CREATE INDEX sends_expired_leases ON sends(state,lease_until);
CREATE TRIGGER sends_approval BEFORE INSERT ON sends
 WHEN NOT EXISTS(SELECT 1 FROM reviews WHERE id=NEW.review_id AND revision_id=NEW.revision_id AND decision='approved')
 BEGIN SELECT RAISE(ABORT,'approval_required'); END;
CREATE TRIGGER sends_frozen BEFORE UPDATE OF revision_id,review_id,idempotency_key,payload,payload_hash ON sends
 BEGIN SELECT RAISE(ABORT,'immutable_send_payload'); END;
CREATE TABLE send_attempts (
 id TEXT PRIMARY KEY, send_id TEXT NOT NULL REFERENCES sends(id), lease_token TEXT NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, http_status INTEGER, error_name TEXT, retry_after INTEGER
) STRICT;
CREATE TABLE delivery_events (
 svix_id TEXT PRIMARY KEY, send_id TEXT REFERENCES sends(id), resend_email_id TEXT NOT NULL,
 type TEXT NOT NULL, occurred_at INTEGER NOT NULL, raw TEXT NOT NULL CHECK(json_valid(raw)), applied_at INTEGER
) STRICT;
CREATE INDEX events_uncorrelated ON delivery_events(resend_email_id,applied_at);
CREATE TABLE agent_idempotency (
 agent_id TEXT NOT NULL REFERENCES agents(id), operation TEXT NOT NULL, target TEXT NOT NULL,
 key TEXT NOT NULL, request_hash TEXT NOT NULL, operation_id TEXT NOT NULL,
 response TEXT CHECK(response IS NULL OR json_valid(response)), completed_at INTEGER, expires_at INTEGER NOT NULL,
 PRIMARY KEY(agent_id,operation,target,key)
) STRICT;
CREATE INDEX idempotency_expiry ON agent_idempotency(expires_at);
UPDATE scaffold_metadata SET schema_version=2 WHERE id=1;
