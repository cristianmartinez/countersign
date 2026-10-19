import { sql, desc } from "drizzle-orm";
import {
  sqliteTable,
  sqliteView,
  text,
  integer,
  primaryKey,
  unique,
  index,
  check,
} from "drizzle-orm/sqlite-core";

// Query/type metadata for the existing database. Checked-in SQL migrations own DDL,
// including STRICT tables, deferred circular FKs, immutable triggers and the view.
// Do not generate replacement migrations from this metadata: SQLite's deferred
// constraints and triggers are intentionally maintained in SQL.
export const scaffoldMetadata = sqliteTable(
  "scaffold_metadata",
  {
    id: integer().primaryKey(),
    schema_version: integer().notNull(),
  },
  (t) => [check("single_metadata_row", sql`${t.id}=1`)],
);

export const reviewers = sqliteTable("reviewers", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  password_hash: text().notNull(),
  allowed_recipient_email: text().notNull(),
  auth_version: integer().notNull().default(1),
});

export const agents = sqliteTable("agents", {
  id: text().primaryKey(),
  reviewer_id: text()
    .notNull()
    .unique()
    .references(() => reviewers.id),
  name: text().notNull(),
  key_hash: text().notNull().unique(),
  key_ciphertext: text().notNull(),
  key_nonce: text().notNull(),
  key_encryption_version: integer().notNull(),
  review_version: integer().notNull().default(0),
});

export const reviewerSessions = sqliteTable(
  "reviewer_sessions",
  {
    token_hash: text().primaryKey(),
    reviewer_id: text()
      .notNull()
      .references(() => reviewers.id),
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
    csrf_hash: text().notNull().default(""),
    auth_version: integer().notNull().default(1),
  },
  (t) => [index("sessions_expiry").on(t.expires_at)],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text().primaryKey(),
    owner_agent_id: text()
      .notNull()
      .references(() => agents.id),
    status: text().notNull(),
    current_revision_id: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    index("drafts_owner_created").on(
      t.owner_agent_id,
      desc(t.created_at),
      desc(t.id),
    ),
    check(
      "draft_status",
      sql`${t.status} IN ('drafted','in_review','rejected','approved','sending','sent','delivered','bounced','failed')`,
    ),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text().primaryKey(),
    draft_id: text().notNull(),
    number: integer().notNull(),
    author_agent_id: text()
      .notNull()
      .references(() => agents.id),
    base_revision_id: text(),
    sender: text().notNull(),
    recipient: text().notNull(),
    subject: text().notNull(),
    text_body: text(),
    html_body: text(),
    content_hash: text().notNull(),
    created_at: integer().notNull(),
    author_reviewer_id: text().references(() => reviewers.id),
  },
  (t) => [
    unique().on(t.draft_id, t.number),
    unique().on(t.draft_id, t.id),
    check("positive_revision", sql`${t.number}>0`),
    check("subject_length", sql`length(${t.subject}) BETWEEN 1 AND 200`),
    check(
      "body_required",
      sql`length(COALESCE(${t.text_body},''))>0 OR length(COALESCE(${t.html_body},''))>0`,
    ),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text().primaryKey(),
    revision_id: text()
      .notNull()
      .unique()
      .references(() => revisions.id),
    reviewer_id: text()
      .notNull()
      .references(() => reviewers.id),
    content_hash: text().notNull(),
    decision: text().notNull(),
    reason: text(),
    created_at: integer().notNull(),
  },
  (t) => [
    check("review_decision", sql`${t.decision} IN ('approved','rejected')`),
    check(
      "rejection_reason",
      sql`${t.decision}!='rejected' OR length(trim(${t.reason}))>0`,
    ),
  ],
);

export const sends = sqliteTable(
  "sends",
  {
    id: text().primaryKey(),
    revision_id: text()
      .notNull()
      .unique()
      .references(() => revisions.id),
    review_id: text()
      .notNull()
      .unique()
      .references(() => reviews.id),
    idempotency_key: text().notNull().unique(),
    payload: text().notNull(),
    payload_hash: text().notNull(),
    state: text().notNull(),
    attempts: integer().notNull().default(0),
    next_attempt_at: integer().notNull(),
    lease_until: integer(),
    lease_token: text(),
    first_attempt_at: integer(),
    retry_deadline: integer(),
    resend_email_id: text().unique(),
    last_error: text(),
    needs_reconciliation: integer().notNull().default(0),
    delivery_status: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    index("sends_due").on(t.state, t.next_attempt_at),
    index("sends_expired_leases").on(t.state, t.lease_until),
    check("send_payload_json", sql`json_valid(${t.payload})`),
    check(
      "send_state",
      sql`${t.state} IN ('queued','sending','retry_wait','sent','failed')`,
    ),
    check("send_attempt_budget", sql`${t.attempts} BETWEEN 0 AND 20`),
    check("send_reconciliation", sql`${t.needs_reconciliation} IN (0,1)`),
  ],
);

export const sendAttempts = sqliteTable(
  "send_attempts",
  {
    id: text().primaryKey(),
    send_id: text()
      .notNull()
      .references(() => sends.id),
    lease_token: text().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    outcome: text(),
    http_status: integer(),
    error_name: text(),
    retry_after: integer(),
  },
  (t) => [index("send_attempts_send_outcome").on(t.send_id, t.outcome)],
);

export const deliveryEvents = sqliteTable(
  "delivery_events",
  {
    svix_id: text().primaryKey(),
    send_id: text().references(() => sends.id),
    resend_email_id: text().notNull(),
    type: text().notNull(),
    occurred_at: integer().notNull(),
    raw: text().notNull(),
    applied_at: integer(),
  },
  (t) => [
    index("events_uncorrelated").on(t.resend_email_id, t.applied_at),
    index("events_send_evidence").on(
      t.send_id,
      t.type,
      desc(t.occurred_at),
      desc(t.svix_id),
    ),
    index("events_pending_provider")
      .on(t.resend_email_id)
      .where(sql`${t.applied_at} IS NULL`),
    check("event_json", sql`json_valid(${t.raw})`),
  ],
);

export const agentIdempotency = sqliteTable(
  "agent_idempotency",
  {
    agent_id: text()
      .notNull()
      .references(() => agents.id),
    operation: text().notNull(),
    target: text().notNull(),
    key: text().notNull(),
    request_hash: text().notNull(),
    operation_id: text().notNull(),
    response: text(),
    completed_at: integer(),
    expires_at: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agent_id, t.operation, t.target, t.key] }),
    index("idempotency_expiry").on(t.expires_at),
    check(
      "receipt_json",
      sql`${t.response} IS NULL OR json_valid(${t.response})`,
    ),
  ],
);

export const loginThrottles = sqliteTable(
  "login_throttles",
  {
    scope_hash: text().primaryKey(),
    attempts: integer().notNull(),
    window_start: integer().notNull(),
  },
  (t) => [index("throttle_window").on(t.window_start)],
);

export const deliveryEvidence = sqliteView("delivery_evidence", {
  send_id: text(),
  type: text(),
  delivery_status: text(),
  reason: text(),
}).existing();
