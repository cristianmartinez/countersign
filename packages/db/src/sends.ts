import {
  sends,
  sendAttempts,
  drafts,
  reviews,
  revisions,
  agents,
  reviewers,
} from "./schema";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { database, type Database } from "./client";
import { DeliveryStore } from "./delivery";
import { unionAll } from "drizzle-orm/sqlite-core";
import { lte } from "drizzle-orm";
import { LIMITS } from "@countersign/core";

export interface ClaimedSend {
  id: string;
  revision_id: string;
  review_id: string;
  idempotency_key: string;
  payload: string;
  payload_hash: string;
  attempts: number;
  lease_token: string;
  lease_until: number;
  retry_deadline: number;
  draft_id: string;
  approved_hash: string;
  sender: string;
  recipient: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  allowed_recipient_email: string;
}

export interface AttemptResult {
  kind: "accepted" | "retry" | "failed";
  providerId?: string;
  error?: string;
  errorName?: string;
  httpStatus?: number | null;
  retryAfter?: number | null;
  unknown: boolean;
  nextAt?: number;
  dispatched?: boolean;
}

// Correlated predicates execute inside the atomic batch, never as preflight JS checks.
const approval = sql`EXISTS(SELECT 1 FROM reviews v JOIN revisions r ON r.id=v.revision_id JOIN drafts d ON d.id=r.draft_id WHERE v.id=sends.review_id AND v.revision_id=sends.revision_id AND v.decision='approved' AND v.content_hash=r.content_hash AND d.current_revision_id=r.id AND d.status IN ('approved','sending'))`;

const unknown = sql`EXISTS(SELECT 1 FROM send_attempts a WHERE a.send_id=sends.id AND (a.outcome IS NULL OR a.outcome IN ('reserved','unknown')))`;

const evidence = sql`(resend_email_id IS NOT NULL OR COALESCE(delivery_status IN ('delivered','bounced','failed','suppressed'),0))`;

export class SendStore {
  private readonly db: Database;

  constructor(
    private readonly binding: D1Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db = database(binding);
  }

  /** Close due exhausted/invalid intents, but never take a live lease from its holder. */
  async settleUnavailable(id: string) {
    const now = this.now();

    await this.db.batch([
      this.db
        .update(sends)
        .set({
          state: "failed",
          last_error: sql`CASE WHEN NOT ${approval} THEN 'approval_integrity_failure' ELSE 'send_retry_budget_exhausted' END`,
          needs_reconciliation: sql`CASE WHEN ${unknown} THEN 1 ELSE 0 END`,
          lease_until: null,
          updated_at: now,
        })
        .where(
          sql`id=${id} AND NOT ${evidence} AND ((state IN ('queued','retry_wait') AND next_attempt_at<=${now}) OR (state='sending' AND lease_until<=${now})) AND (attempts>=${LIMITS.maxSendAttempts} OR (retry_deadline IS NOT NULL AND retry_deadline<=${now + LIMITS.requestTimeoutMs}) OR NOT ${approval})`,
        ),
      this.db
        .update(sendAttempts)
        .set({ outcome: "unknown", finished_at: now })
        .where(
          sql`send_id=${id} AND outcome='reserved' AND EXISTS(SELECT 1 FROM sends WHERE id=${id} AND state='failed')`,
        ),
      this.db
        .update(drafts)
        .set({ status: "failed", updated_at: now })
        .where(
          sql`current_revision_id=(SELECT revision_id FROM sends WHERE id=${id} AND state='failed' AND updated_at=${now}) AND status IN ('approved','sending')`,
        ),
    ]);
  }

  async claim(id: string): Promise<ClaimedSend | null> {
    await this.settleUnavailable(id);

    const now = this.now(),
      token = crypto.randomUUID();

    const results = await this.db.batch([
      this.db
        .update(sends)
        .set({
          state: "sending",
          attempts: sql`attempts+1`,
          lease_token: token,
          lease_until: now + LIMITS.leaseSeconds * 1000,
          first_attempt_at: sql`COALESCE(first_attempt_at,${now})`,
          retry_deadline: sql`COALESCE(retry_deadline,${now + LIMITS.retryWindowSeconds * 1000})`,
          updated_at: now,
        })
        .where(
          sql`id=${id} AND NOT ${evidence} AND ((state IN ('queued','retry_wait') AND next_attempt_at<=${now}) OR (state='sending' AND lease_until<=${now})) AND attempts<${LIMITS.maxSendAttempts} AND (retry_deadline IS NULL OR retry_deadline>${now + LIMITS.requestTimeoutMs}) AND ${approval}`,
        ),
      this.db
        .update(sendAttempts)
        .set({ outcome: "unknown", finished_at: now })
        .where(
          sql`send_id=${id} AND outcome='reserved' AND lease_token<>${token} AND EXISTS(SELECT 1 FROM sends WHERE id=${id} AND lease_token=${token} AND state='sending')`,
        ),
      this.db.insert(sendAttempts).select(
        this.db
          .select({
            id: sql`${token}`.as("id"),
            send_id: sends.id,
            lease_token: sql`${token}`.as("lease_token"),
            started_at: sql`${now}`.as("started_at"),
            finished_at: sql`NULL`.as("finished_at"),
            outcome: sql`'reserved'`.as("outcome"),
            http_status: sql`NULL`.as("http_status"),
            error_name: sql`NULL`.as("error_name"),
            retry_after: sql`NULL`.as("retry_after"),
          })
          .from(sends)
          .where(sql`id=${id} AND lease_token=${token} AND state='sending'`),
      ),
      this.db
        .update(drafts)
        .set({ status: "sending", updated_at: now })
        .where(
          sql`status IN ('approved','sending') AND current_revision_id=(SELECT revision_id FROM sends WHERE id=${id} AND lease_token=${token} AND state='sending')`,
        ),
      this.db
        .select({
          ...getTableColumns(sends),
          lease_token: sql<string>`${sends.lease_token}`,
          lease_until: sql<number>`${sends.lease_until}`,
          retry_deadline: sql<number>`${sends.retry_deadline}`,
          draft_id: revisions.draft_id,
          approved_hash: reviews.content_hash,
          sender: revisions.sender,
          recipient: revisions.recipient,
          subject: revisions.subject,
          text_body: revisions.text_body,
          html_body: revisions.html_body,
          allowed_recipient_email: reviewers.allowed_recipient_email,
        })
        .from(sends)
        .innerJoin(reviews, eq(reviews.id, sends.review_id))
        .innerJoin(revisions, eq(revisions.id, sends.revision_id))
        .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
        .innerJoin(agents, eq(agents.id, drafts.owner_agent_id))
        .innerJoin(reviewers, eq(reviewers.id, agents.reviewer_id))
        .where(
          and(
            eq(sends.id, id),
            eq(sends.lease_token, token),
            eq(sends.state, "sending"),
          ),
        ),
    ]);

    return results[4]?.[0] ?? null;
  }

  async isLive(send: ClaimedSend) {
    return Boolean(
      await this.db
        .select({ id: sends.id })
        .from(sends)
        .where(
          sql`id=${send.id} AND lease_token=${send.lease_token} AND state='sending'
        AND lease_until>${this.now()} AND retry_deadline>${this.now() + LIMITS.requestTimeoutMs}
        AND NOT EXISTS(SELECT 1 FROM delivery_events e WHERE e.send_id=sends.id
          AND e.type IN ('email.delivered','email.bounced','email.failed','email.suppressed'))`,
        )
        .get(),
    );
  }

  async finish(send: ClaimedSend, result: AttemptResult): Promise<boolean> {
    const now = this.now(),
      success = result.kind === "accepted";

    const exhausted =
      result.kind === "retry" &&
      (send.attempts >= LIMITS.maxSendAttempts ||
        (result.nextAt ?? now) + LIMITS.requestTimeoutMs >=
          send.retry_deadline);

    const state = success
      ? "sent"
      : result.kind === "retry" && !exhausted
        ? "retry_wait"
        : "failed";

    const outcome = success
      ? "accepted"
      : result.dispatched === false
        ? "not_dispatched"
        : result.unknown
          ? "unknown"
          : "rejected";

    const results = await this.db.batch([
      this.db
        .update(sendAttempts)
        .set({
          finished_at: now,
          outcome: outcome,
          http_status: result.httpStatus ?? null,
          error_name: result.errorName ?? null,
          retry_after: result.retryAfter ?? null,
        })
        .where(
          sql`id=${send.lease_token} AND EXISTS(SELECT 1 FROM sends WHERE id=${send.id} AND lease_token=${send.lease_token} AND state='sending' AND lease_until>${now})`,
        ),
      this.db
        .update(sends)
        .set({
          state: sql`CASE WHEN ${evidence} THEN 'sent' ELSE ${state} END`,
          resend_email_id: sql`COALESCE(resend_email_id,${result.providerId ?? null})`,
          last_error: sql`CASE WHEN ${evidence} OR ${success ? 1 : 0}=1 THEN NULL ELSE ${
            exhausted
              ? "send_retry_budget_exhausted: " +
                (result.error ?? "Transient error")
              : (result.error ?? null)
          } END`,
          needs_reconciliation: sql`CASE WHEN ${evidence} OR ${success ? 1 : 0}=1 THEN 0 WHEN ${state}='failed' AND ${unknown} THEN 1 ELSE 0 END`,
          next_attempt_at: result.nextAt ?? now,
          lease_until: null,
          updated_at: now,
        })
        .where(
          sql`id=${send.id} AND lease_token=${send.lease_token} AND state='sending' AND lease_until>${now}`,
        ),
      this.db
        .update(drafts)
        .set({
          status: sql`CASE (SELECT state FROM sends WHERE id=${send.id}) WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' ELSE 'sending' END`,
          updated_at: now,
        })
        .where(
          sql`id=${send.draft_id} AND current_revision_id=${send.revision_id} AND status IN ('approved','sending') AND EXISTS(SELECT 1 FROM sends WHERE id=${send.id} AND lease_token=${send.lease_token} AND updated_at=${now})`,
        ),
    ]);

    const saved = Boolean(results[1]?.meta.changes);

    if (saved && success && result.providerId) {
      await new DeliveryStore(this.binding, this.now).correlate(
        result.providerId,
      );
    }

    return saved;
  }

  async recoverable(limit = 50) {
    const now = this.now();

    const eligible = unionAll(
      this.db
        .select({
          id: sends.id,
          due_at: sql<number>`${sends.next_attempt_at}`.as("due_at"),
        })
        .from(sends)
        .where(
          and(
            sql`${sends.state} IN ('queued','retry_wait')`,
            lte(sends.next_attempt_at, now),
          ),
        ),
      this.db
        .select({
          id: sends.id,
          due_at: sql<number>`${sends.lease_until}`.as("due_at"),
        })
        .from(sends)
        .where(and(eq(sends.state, "sending"), lte(sends.lease_until, now))),
    ).as("eligible");

    return this.db
      .select({ id: eligible.id })
      .from(eligible)
      .orderBy(sql`${eligible.due_at}`, eligible.id)
      .limit(Math.min(50, Math.max(1, limit)));
  }

  async sendIdForRevision(revision: string) {
    return (
      (
        await this.db
          .select({ id: sends.id })
          .from(sends)
          .where(eq(sends.revision_id, revision))
          .get()
      )?.id ?? null
    );
  }
}
