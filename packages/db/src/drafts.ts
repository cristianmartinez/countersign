import type { BatchItem } from "drizzle-orm/batch";
import {
  agentIdempotency,
  drafts,
  revisions,
  reviews,
  sends,
  agents,
  reviewers,
} from "./schema";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { database, type Database } from "./client";
import { canonicalContent, sha256, type EmailContent } from "@countersign/core";

export class Conflict extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "revision_conflict"
      | "invalid_state"
      | "revision_changed"
      | "idempotency_conflict"
      | "validation_error",
  ) {
    super(code);
  }
}

export interface MutationResult {
  draft_id: string;
  revision_id: string;
  status: string;
}

type Receipt = Pick<
  typeof agentIdempotency.$inferSelect,
  "request_hash" | "response"
>;

type Draft = Pick<
  typeof drafts.$inferSelect,
  "id" | "owner_agent_id" | "current_revision_id" | "status"
>;

/** Bind actor IDs only after authentication. This is a persistence boundary, not an auth implementation. */
export class DraftStore {
  private readonly db: Database;

  constructor(
    private readonly binding: D1Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db = database(binding);
  }

  private async draft(agent: string, id: string): Promise<Draft> {
    const row = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.owner_agent_id, agent)))
      .get();

    if (!row) throw new Conflict("not_found");

    return row;
  }

  async create(
    agent: string,
    key: string,
    content: EmailContent,
  ): Promise<MutationResult> {
    return this.mutate(agent, key, content);
  }

  async revise(
    agent: string,
    draft: string,
    base: string,
    key: string,
    content: EmailContent,
  ): Promise<MutationResult> {
    return this.mutate(agent, key, content, { draft, base });
  }

  async reviseAsReviewer(
    reviewer: string,
    draft: string,
    base: string,
    key: string,
    content: EmailContent,
  ): Promise<MutationResult> {
    const agent = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.reviewer_id, reviewer))
      .get();

    if (!agent) throw new Conflict("not_found");

    return this.mutate(agent.id, key, content, { draft, base }, reviewer);
  }

  private async mutate(
    agent: string,
    key: string,
    content: EmailContent,
    revision?: { draft: string; base: string },
    reviewer?: string,
  ): Promise<MutationResult> {
    if (!key.trim()) throw new Error("Idempotency-Key is required");

    const now = this.now(),
      expiry = now + 86_400_000;

    const op = reviewer ? "reviewer_revise" : revision ? "revise" : "create",
      target = revision?.draft ?? "";

    const draft = revision?.draft ?? crypto.randomUUID(),
      id = crypto.randomUUID(),
      token = crypto.randomUUID();

    const canonical = canonicalContent(content),
      hash = await sha256(canonical);

    const fingerprint = await sha256(
      JSON.stringify([revision?.base ?? null, canonical]),
    );

    const result: MutationResult = {
      draft_id: draft,
      revision_id: id,
      status: reviewer ? "in_review" : "drafted",
    };

    // This operation token gates every mutation inside the same atomic batch.
    const owns = sql`EXISTS(SELECT 1 FROM agent_idempotency WHERE agent_id=${agent} AND operation=${op} AND target=${target} AND key=${key} AND operation_id=${token})`;

    const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
      this.db
        .delete(agentIdempotency)
        .where(
          sql`agent_id=${agent} AND operation=${op} AND target=${target} AND key=${key} AND expires_at<=${now}`,
        ),
      this.db
        .insert(agentIdempotency)
        .values({
          agent_id: agent,
          operation: op,
          target: target,
          key: key,
          request_hash: fingerprint,
          operation_id: token,
          expires_at: expiry,
        })
        .onConflictDoNothing(),
    ];

    if (!revision) {
      statements.push(
        this.db.insert(drafts).select(
          this.db
            .select({
              id: sql`${draft}`.as("id"),
              owner_agent_id: sql`${agent}`.as("owner_agent_id"),
              status: sql`'drafted'`.as("status"),
              current_revision_id: sql`${id}`.as("current_revision_id"),
              created_at: sql`${now}`.as("created_at"),
              updated_at: sql`${now}`.as("updated_at"),
            })
            .from(sql`(SELECT 1)`)
            .where(sql`${owns}`),
        ),
      );

      statements.push(
        this.db.insert(revisions).select(
          this.db
            .select({
              id: sql`${id}`.as("id"),
              draft_id: sql`${draft}`.as("draft_id"),
              number: sql`1`.as("number"),
              author_agent_id: sql`${agent}`.as("author_agent_id"),
              base_revision_id: sql`NULL`.as("base_revision_id"),
              sender: sql`${content.from}`.as("sender"),
              recipient: sql`${content.to[0]}`.as("recipient"),
              subject: sql`${content.subject}`.as("subject"),
              text_body: sql`${content.text ?? null}`.as("text_body"),
              html_body: sql`${content.html ?? null}`.as("html_body"),
              content_hash: sql`${hash}`.as("content_hash"),
              created_at: sql`${now}`.as("created_at"),
              author_reviewer_id: sql`NULL`.as("author_reviewer_id"),
            })
            .from(sql`(SELECT 1)`)
            .where(sql`${owns}`),
        ),
      );
    } else {
      // The revision insert is the winning operation token. No JS read/check/write gap.
      statements.push(
        this.db.insert(revisions).select(
          this.db
            .select({
              id: sql`${id}`.as("id"),
              draft_id: drafts.id,
              number: sql`${revisions.number}+1`.as("number"),
              author_agent_id: sql`${agent}`.as("author_agent_id"),
              base_revision_id: revisions.id,
              sender: sql`${content.from}`.as("sender"),
              recipient: sql`${content.to[0]}`.as("recipient"),
              subject: sql`${content.subject}`.as("subject"),
              text_body: sql`${content.text ?? null}`.as("text_body"),
              html_body: sql`${content.html ?? null}`.as("html_body"),
              content_hash: sql`${hash}`.as("content_hash"),
              created_at: sql`${now}`.as("created_at"),
              author_reviewer_id: sql`${reviewer ?? null}`.as(
                "author_reviewer_id",
              ),
            })
            .from(drafts)
            .innerJoin(revisions, eq(revisions.id, drafts.current_revision_id))
            .where(
              sql`drafts.id=${draft} AND drafts.owner_agent_id=${agent} AND drafts.current_revision_id=${revision.base} AND drafts.status IN ('drafted','in_review','rejected') AND ${owns} AND (${reviewer ?? null} IS NULL OR EXISTS(SELECT 1 FROM agents a WHERE a.id=drafts.owner_agent_id AND a.reviewer_id=${reviewer ?? null}))`,
            ),
        ),
      );

      statements.push(
        this.db
          .update(drafts)
          .set({
            current_revision_id: id,
            status: result.status,
            updated_at: now,
          })
          .where(
            sql`id=${draft} AND EXISTS(SELECT 1 FROM revisions WHERE id=${id} AND draft_id=drafts.id)`,
          ),
      );
    }

    statements.push(
      this.db
        .update(agentIdempotency)
        .set({
          response: JSON.stringify(result),
          completed_at: now,
          expires_at: expiry,
        })
        .where(
          sql`agent_id=${agent} AND operation=${op} AND target=${target} AND key=${key} AND operation_id=${token} AND EXISTS(SELECT 1 FROM revisions WHERE id=${id})`,
        ),
    );

    statements.push(
      this.db
        .delete(agentIdempotency)
        .where(
          sql`agent_id=${agent} AND operation=${op} AND target=${target} AND key=${key} AND operation_id=${token} AND response IS NULL`,
        ),
    );

    const receiptQuery = this.db
      .select({
        request_hash: agentIdempotency.request_hash,
        response: agentIdempotency.response,
      })
      .from(agentIdempotency)
      .where(
        and(
          eq(agentIdempotency.agent_id, agent),
          eq(agentIdempotency.operation, op),
          eq(agentIdempotency.target, target),
          eq(agentIdempotency.key, key),
        ),
      );

    const results = await this.db.batch([...statements, receiptQuery]);

    const receipt = (results.at(-1) as Receipt[])[0];

    if (receipt) {
      if (receipt.request_hash !== fingerprint)
        throw new Conflict("idempotency_conflict");

      if (receipt.response)
        return JSON.parse(receipt.response) as MutationResult;
    }

    const current = await this.draft(agent, draft);

    throw new Conflict(
      current.current_revision_id !== revision?.base
        ? "revision_conflict"
        : "invalid_state",
    );
  }

  async submit(
    agent: string,
    draft: string,
    revision: string,
  ): Promise<MutationResult> {
    const rows = await this.db.batch([
      this.db
        .update(drafts)
        .set({ status: "in_review", updated_at: this.now() })
        .where(
          sql`id=${draft} AND owner_agent_id=${agent} AND current_revision_id=${revision} AND status='drafted'`,
        ),
      this.db
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, draft), eq(drafts.owner_agent_id, agent))),
    ]);

    const current = rows[1]?.[0];

    if (!current) throw new Conflict("not_found");

    if (current.current_revision_id !== revision)
      throw new Conflict("revision_conflict");

    return { draft_id: draft, revision_id: revision, status: current.status };
  }

  async decide(
    reviewer: string,
    draft: string,
    revision: string,
    hash: string,
    decision: "approved" | "rejected",
    reason: string | null = null,
  ) {
    if (decision === "rejected" && !reason?.trim())
      throw new Error("Rejection reason required");

    const id = crypto.randomUUID(),
      send = crypto.randomUUID(),
      now = this.now();

    // Load immutable content for hashing only. SQL rechecks current revision, state, hash and ownership.
    const row = await this.db
      .select(getTableColumns(revisions))
      .from(revisions)
      .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
      .innerJoin(agents, eq(agents.id, drafts.owner_agent_id))
      .where(
        and(
          eq(revisions.id, revision),
          eq(drafts.id, draft),
          eq(agents.reviewer_id, reviewer),
        ),
      )
      .get();

    if (!row) throw new Conflict("not_found");

    const content: EmailContent = {
      from: row.sender,
      to: [row.recipient],
      subject: row.subject,
      ...(row.text_body === null ? {} : { text: row.text_body }),
      ...(row.html_body === null ? {} : { html: row.html_body }),
    };

    const payload = JSON.stringify({
      ...JSON.parse(canonicalContent(content)),
      tags: [
        { name: "draft_id", value: draft },
        { name: "revision_id", value: revision },
      ],
      headers: { "X-Entity-Ref-ID": revision },
    });

    const payloadHash = await sha256(payload);

    const result = await this.db.batch([
      this.db
        .insert(reviews)
        .select(
          this.db
            .select({
              id: sql`${id}`.as("id"),
              revision_id: revisions.id,
              reviewer_id: sql`${reviewer}`.as("reviewer_id"),
              content_hash: sql`${hash}`.as("content_hash"),
              decision: sql`${decision}`.as("decision"),
              reason: sql`${reason}`.as("reason"),
              created_at: sql`${now}`.as("created_at"),
            })
            .from(drafts)
            .innerJoin(revisions, eq(revisions.id, drafts.current_revision_id))
            .innerJoin(agents, eq(agents.id, drafts.owner_agent_id))
            .innerJoin(reviewers, eq(reviewers.id, agents.reviewer_id))
            .where(
              sql`drafts.id=${draft} AND revisions.id=${revision} AND revisions.content_hash=${hash} AND drafts.status='in_review' AND agents.reviewer_id=${reviewer} AND (${decision}='rejected' OR revisions.recipient=reviewers.allowed_recipient_email OR revisions.recipient IN ('delivered@resend.dev','bounced@resend.dev','complained@resend.dev','suppressed@resend.dev'))`,
            ),
        )
        .onConflictDoNothing({ target: reviews.revision_id }),
      this.db.insert(sends).select(
        this.db
          .select({
            id: sql`${send}`.as("id"),
            revision_id: reviews.revision_id,
            review_id: reviews.id,
            idempotency_key: sql`${`send/${revision}`}`.as("idempotency_key"),
            payload: sql`${payload}`.as("payload"),
            payload_hash: sql`${payloadHash}`.as("payload_hash"),
            state: sql`'queued'`.as("state"),
            attempts: sql`0`.as("attempts"),
            next_attempt_at: sql`${now}`.as("next_attempt_at"),
            lease_until: sql`NULL`.as("lease_until"),
            lease_token: sql`NULL`.as("lease_token"),
            first_attempt_at: sql`NULL`.as("first_attempt_at"),
            retry_deadline: sql`NULL`.as("retry_deadline"),
            resend_email_id: sql`NULL`.as("resend_email_id"),
            last_error: sql`NULL`.as("last_error"),
            needs_reconciliation: sql`0`.as("needs_reconciliation"),
            delivery_status: sql`NULL`.as("delivery_status"),
            created_at: sql`${now}`.as("created_at"),
            updated_at: sql`${now}`.as("updated_at"),
          })
          .from(reviews)
          .where(sql`id=${id} AND decision='approved'`),
      ),
      this.db
        .update(drafts)
        .set({ status: decision, updated_at: now })
        .where(
          sql`id=${draft} AND current_revision_id=${revision} AND EXISTS(SELECT 1 FROM reviews WHERE id=${id})`,
        ),
      this.db
        .select({ id: reviews.id, decision: reviews.decision })
        .from(reviews)
        .innerJoin(revisions, eq(revisions.id, reviews.revision_id))
        .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
        .where(
          and(
            eq(reviews.revision_id, revision),
            eq(reviews.content_hash, hash),
            eq(reviews.reviewer_id, reviewer),
            eq(drafts.current_revision_id, reviews.revision_id),
          ),
        ),
    ]);

    const review = result[3]?.[0];

    if (review?.decision === decision) return review;

    if (review) throw new Conflict("invalid_state");

    const current = await this.db
      .select({
        status: drafts.status,
        current_revision_id: drafts.current_revision_id,
        content_hash: revisions.content_hash,
      })
      .from(drafts)
      .innerJoin(revisions, eq(revisions.id, drafts.current_revision_id))
      .where(eq(drafts.id, draft))
      .get();

    if (
      current?.status === "in_review" &&
      current.current_revision_id === revision &&
      current.content_hash === hash
    )
      throw new Conflict("validation_error");

    throw new Conflict("revision_changed");
  }
}
