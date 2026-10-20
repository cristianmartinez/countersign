import {
  deliveryEvents,
  sends,
  sendAttempts,
  drafts,
  revisions,
} from "./schema";
import { eq, sql } from "drizzle-orm";
import { database, type Database } from "./client";

export interface VerifiedDeliveryEvent {
  id: string;
  emailId: string;
  type: string;
  occurredAt: number;
  raw: string;
}

export interface DeliveryDetail {
  id: string;
  type: string;
  occurred_at: number;
  detail: string | null;
}

// e = retained event, s = send, r = immutable revision. A tag never supplies identity.
export class DeliveryStore {
  private readonly db: Database;

  constructor(
    private readonly binding: D1Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db = database(binding);
  }

  async record(event: VerifiedDeliveryEvent): Promise<void> {
    // An unapplied marker survives a crash between receipt and projection. Replays
    // always retry application, even when INSERT finds an existing svix-id.
    const results = await this.db.batch([
      this.db
        .insert(deliveryEvents)
        .values({
          svix_id: event.id,
          resend_email_id: event.emailId,
          type: event.type,
          occurred_at: event.occurredAt,
          raw: event.raw,
        })
        .onConflictDoNothing(),
      this.db
        .select({ resend_email_id: deliveryEvents.resend_email_id })
        .from(deliveryEvents)
        .where(eq(deliveryEvents.svix_id, event.id)),
    ]);

    const original = results[1]?.[0];

    if (original) await this.correlate(original.resend_email_id);
  }

  async correlate(providerId: string): Promise<void> {
    const now = this.now();

    await this.db.batch([
      this.db
        .update(deliveryEvents)
        .set({
          send_id: sql`(SELECT id FROM sends WHERE resend_email_id=${providerId})`,
        })
        .where(
          sql`delivery_events.resend_email_id=${providerId} AND delivery_events.send_id IS NULL AND EXISTS(SELECT 1 FROM sends s JOIN revisions r ON r.id=s.revision_id WHERE s.resend_email_id=delivery_events.resend_email_id AND (json_type(delivery_events.raw,'$.data.tags.draft_id') IS NULL OR json_extract(delivery_events.raw,'$.data.tags.draft_id')=r.draft_id) AND (json_type(delivery_events.raw,'$.data.tags.revision_id') IS NULL OR json_extract(delivery_events.raw,'$.data.tags.revision_id')=s.revision_id))`,
        ),
      this.db
        .update(sends)
        .set({
          state: sql`CASE WHEN (SELECT delivery_status FROM delivery_evidence WHERE send_id=sends.id)='sent' AND needs_reconciliation=1 THEN 'failed' ELSE 'sent' END`,
          delivery_status: sql`(SELECT delivery_status FROM delivery_evidence WHERE send_id=sends.id)`,
          last_error: sql`CASE WHEN (SELECT delivery_status FROM delivery_evidence WHERE send_id=sends.id)='sent' AND needs_reconciliation=1 THEN last_error ELSE (SELECT reason FROM delivery_evidence WHERE send_id=sends.id) END`,
          needs_reconciliation: sql`CASE WHEN (SELECT delivery_status FROM delivery_evidence WHERE send_id=sends.id)='sent' THEN needs_reconciliation ELSE 0 END`,
          lease_token: null,
          lease_until: null,
          updated_at: now,
        })
        .where(
          sql`resend_email_id=${providerId} AND EXISTS(SELECT 1 FROM delivery_events e WHERE e.send_id=sends.id AND e.applied_at IS NULL) AND EXISTS(SELECT 1 FROM delivery_evidence WHERE send_id=sends.id)`,
        ),
      this.db
        .update(sendAttempts)
        .set({ outcome: "superseded_by_webhook", finished_at: now })
        .where(
          sql`outcome='reserved' AND send_id IN (SELECT id FROM sends WHERE resend_email_id=${providerId} AND lease_token IS NULL AND EXISTS(SELECT 1 FROM delivery_events e WHERE e.send_id=sends.id AND e.applied_at IS NULL) AND EXISTS(SELECT 1 FROM delivery_evidence WHERE send_id=sends.id))`,
        ),
      this.db
        .update(drafts)
        .set({
          status: sql`(SELECT CASE WHEN s.needs_reconciliation=1 THEN 'failed' WHEN s.delivery_status='suppressed' THEN 'failed' ELSE s.delivery_status END FROM sends s WHERE s.revision_id=drafts.current_revision_id)`,
          updated_at: now,
        })
        .where(
          sql`status IN ('approved','sending','sent','delivered','bounced','failed') AND current_revision_id IN (SELECT revision_id FROM sends WHERE resend_email_id=${providerId} AND EXISTS(SELECT 1 FROM delivery_events e WHERE e.send_id=sends.id AND e.applied_at IS NULL) AND EXISTS(SELECT 1 FROM delivery_evidence WHERE send_id=sends.id))`,
        ),
      this.db
        .update(deliveryEvents)
        .set({ applied_at: now })
        .where(
          sql`resend_email_id=${providerId} AND send_id IS NOT NULL AND applied_at IS NULL`,
        ),
    ]);
  }

  async recover(limit = 50): Promise<void> {
    // Skip unrelated provider IDs and conflicting tags so they cannot starve work.
    const candidates = await this.db
      .selectDistinct({ resend_email_id: deliveryEvents.resend_email_id })
      .from(deliveryEvents)
      .innerJoin(
        sends,
        eq(sends.resend_email_id, deliveryEvents.resend_email_id),
      )
      .innerJoin(revisions, eq(revisions.id, sends.revision_id))
      .where(
        sql`${deliveryEvents.applied_at} IS NULL
        AND (json_type(${deliveryEvents.raw},'$.data.tags.draft_id') IS NULL
          OR json_extract(${deliveryEvents.raw},'$.data.tags.draft_id')=${revisions.draft_id})
        AND (json_type(${deliveryEvents.raw},'$.data.tags.revision_id') IS NULL
          OR json_extract(${deliveryEvents.raw},'$.data.tags.revision_id')=${sends.revision_id})`,
      )
      .orderBy(deliveryEvents.resend_email_id)
      .limit(Math.min(50, Math.max(1, limit)));

    for (const row of candidates) await this.correlate(row.resend_email_id);
  }
}
