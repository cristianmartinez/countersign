import {
  and,
  desc,
  eq,
  getTableColumns,
  lt,
  or,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { database, type Database } from "./client";
import {
  agents,
  reviewers,
  drafts,
  revisions,
  reviews,
  sends,
  deliveryEvents,
} from "./schema";
import { Conflict } from "./drafts";

export type AgentIdentity = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "key_hash"
> &
  Pick<typeof reviewers.$inferSelect, "allowed_recipient_email">;

export type RevisionRow = typeof revisions.$inferSelect;

export interface StatusRow {
  id: string;
  status: string;
  current_revision_id: string;
  created_at: number;
  updated_at: number;
  decision: string | null;
  reason: string | null;
  review_revision: string | null;
  send_state: string | null;
  send_attempts: number | null;
  send_updated_at: number | null;
  last_error: string | null;
  needs_reconciliation: number | null;
  resend_email_id: string | null;
  delivery_status: string | null;
}

/** Descending keyset pagination; retain the ID tie-breaker at identical timestamps. */
export function afterCursor(
  value: AnyColumn,
  id: AnyColumn,
  after?: { value: number; id: string },
) {
  return after
    ? or(lt(value, after.value), and(eq(value, after.value), lt(id, after.id)))
    : undefined;
}

export class AgentReads {
  private readonly db: Database;

  constructor(binding: D1Database) {
    this.db = database(binding);
  }

  async authenticate(hash: string) {
    return this.db
      .select({
        id: agents.id,
        name: agents.name,
        key_hash: agents.key_hash,
        allowed_recipient_email: reviewers.allowed_recipient_email,
      })
      .from(agents)
      .innerJoin(reviewers, eq(reviewers.id, agents.reviewer_id))
      .where(eq(agents.key_hash, hash))
      .get();
  }

  async status(agent: string, draft: string): Promise<StatusRow> {
    const row = await this.db
      .select({
        ...getTableColumns(drafts),
        decision: reviews.decision,
        reason: reviews.reason,
        review_revision: reviews.revision_id,
        send_state: sends.state,
        send_attempts: sends.attempts,
        send_updated_at: sends.updated_at,
        last_error: sends.last_error,
        needs_reconciliation: sends.needs_reconciliation,
        resend_email_id: sends.resend_email_id,
        delivery_status: sends.delivery_status,
      })
      .from(drafts)
      .leftJoin(reviews, eq(reviews.revision_id, drafts.current_revision_id))
      .leftJoin(sends, eq(sends.revision_id, drafts.current_revision_id))
      .where(and(eq(drafts.id, draft), eq(drafts.owner_agent_id, agent)))
      .get();

    if (!row) throw new Conflict("not_found");

    return row;
  }

  async revision(agent: string, draft: string, revision: string) {
    const row = await this.db
      .select(getTableColumns(revisions))
      .from(revisions)
      .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
      .where(
        and(
          eq(revisions.id, revision),
          eq(drafts.id, draft),
          eq(drafts.owner_agent_id, agent),
        ),
      )
      .get();

    if (!row) throw new Conflict("not_found");

    return row;
  }

  async listDeliveryEvents(
    agent: string,
    draft: string,
    limit: number,
    after?: { value: number; id: string },
  ) {
    await this.status(agent, draft);

    return this.db
      .select({
        id: deliveryEvents.svix_id,
        type: deliveryEvents.type,
        occurred_at: deliveryEvents.occurred_at,
        detail: sql<string | null>`substr(CASE ${deliveryEvents.type}
        WHEN 'email.bounced' THEN json_extract(${deliveryEvents.raw},'$.data.bounce')
        WHEN 'email.failed' THEN json_extract(${deliveryEvents.raw},'$.data.failed')
        WHEN 'email.suppressed' THEN json_extract(${deliveryEvents.raw},'$.data.suppressed')
        WHEN 'email.delivery_delayed' THEN COALESCE(json_extract(${deliveryEvents.raw},'$.data.delivery_delayed'),'Temporary delivery delay')
        WHEN 'email.complained' THEN 'Recipient reported the email as spam'
        ELSE NULL END,1,4000)`,
      })
      .from(deliveryEvents)
      .innerJoin(sends, eq(sends.id, deliveryEvents.send_id))
      .innerJoin(revisions, eq(revisions.id, sends.revision_id))
      .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
      .where(
        and(
          eq(drafts.id, draft),
          eq(drafts.owner_agent_id, agent),
          afterCursor(
            deliveryEvents.occurred_at,
            deliveryEvents.svix_id,
            after,
          ),
        ),
      )
      .orderBy(desc(deliveryEvents.occurred_at), desc(deliveryEvents.svix_id))
      .limit(limit + 1);
  }

  async listDrafts(
    agent: string,
    limit: number,
    status: string | undefined,
    after?: { value: number; id: string },
  ) {
    return this.db
      .select({
        id: drafts.id,
        status: drafts.status,
        current_revision_id: drafts.current_revision_id,
        created_at: drafts.created_at,
        updated_at: drafts.updated_at,
      })
      .from(drafts)
      .where(
        and(
          eq(drafts.owner_agent_id, agent),
          status === undefined ? undefined : eq(drafts.status, status),
          afterCursor(drafts.created_at, drafts.id, after),
        ),
      )
      .orderBy(desc(drafts.created_at), desc(drafts.id))
      .limit(limit + 1);
  }

  async listRevisions(
    agent: string,
    draft: string,
    limit: number,
    after?: { value: number; id: string },
  ) {
    await this.status(agent, draft);

    return this.db
      .select({
        id: revisions.id,
        number: revisions.number,
        author_agent_id: revisions.author_agent_id,
        author_reviewer_id: revisions.author_reviewer_id,
        created_at: revisions.created_at,
      })
      .from(revisions)
      .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
      .where(
        and(
          eq(drafts.id, draft),
          eq(drafts.owner_agent_id, agent),
          afterCursor(revisions.number, revisions.id, after),
        ),
      )
      .orderBy(desc(revisions.number), desc(revisions.id))
      .limit(limit + 1);
  }
}
