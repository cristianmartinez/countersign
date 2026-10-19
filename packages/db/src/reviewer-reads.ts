import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  or,
  sql,
} from "drizzle-orm";
import { AgentReads } from "./agent-reads";
import { database, type Database } from "./client";
import { agents, drafts, revisions } from "./schema";
import { Conflict } from "./drafts";

export interface ReviewQueueOptions {
  q?: string;
  status?: string;
  sort?: "created" | "subject" | "recipient" | "revision" | "status";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: 8 | 20 | 50;
}

export type ReviewQueuePage = Awaited<ReturnType<ReviewerReads["queue"]>>;

export class ReviewerReads {
  private readonly db: Database;

  constructor(private readonly binding: D1Database) {
    this.db = database(binding);
  }

  async version(reviewer: string): Promise<string> {
    const row = await this.db
      .select({ id: agents.id, version: agents.review_version })
      .from(agents)
      .where(eq(agents.reviewer_id, reviewer))
      .get();

    if (!row) throw new Conflict("not_found");

    return `${row.id}:${row.version}`;
  }

  async agent(reviewer: string) {
    const row = await this.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.reviewer_id, reviewer))
      .get();

    if (!row) throw new Conflict("not_found");

    return row;
  }

  async queue(
    reviewer: string,
    all: boolean,
    options: ReviewQueueOptions = {},
  ) {
    const {
      q = "",
      status = "",
      sort = "created",
      direction = "desc",
      pageSize = 8,
    } = options;

    const predicate = and(
      eq(agents.reviewer_id, reviewer),
      all ? undefined : eq(drafts.status, "in_review"),
      status ? eq(drafts.status, status) : undefined,
      q
        ? or(
            sql`instr(lower(${revisions.subject}),lower(${q}))>0`,
            sql`instr(lower(${revisions.recipient}),lower(${q}))>0`,
          )
        : undefined,
    );

    const counts = await this.db
      .select({ total: count() })
      .from(drafts)
      .innerJoin(agents, eq(agents.id, drafts.owner_agent_id))
      .innerJoin(revisions, eq(revisions.id, drafts.current_revision_id))
      .where(predicate)
      .get();

    const total = counts?.total ?? 0;

    const pageCount = Math.max(1, Math.ceil(total / pageSize));

    const page = Math.max(1, Math.min(options.page ?? 1, pageCount));

    const column = {
      created: drafts.created_at,
      subject: revisions.subject,
      recipient: revisions.recipient,
      revision: revisions.number,
      status: drafts.status,
    }[sort];

    const order = direction === "asc" ? asc : desc;

    const items = await this.db
      .select({
        id: drafts.id,
        status: drafts.status,
        created_at: drafts.created_at,
        subject: revisions.subject,
        recipient: revisions.recipient,
        number: revisions.number,
      })
      .from(drafts)
      .innerJoin(agents, eq(agents.id, drafts.owner_agent_id))
      .innerJoin(revisions, eq(revisions.id, drafts.current_revision_id))
      .where(predicate)
      .orderBy(order(column), order(drafts.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items,
      total,
      page,
      pageCount,
      pageSize,
      q,
      status,
      sort,
      direction,
    };
  }

  async detail(reviewer: string, draft: string, revision?: string) {
    const agent = await this.agent(reviewer),
      reads = new AgentReads(this.binding),
      status = await reads.status(agent.id, draft);

    const current = await reads.revision(
      agent.id,
      draft,
      revision ?? status.current_revision_id,
    );

    const previous = await this.db
      .select(getTableColumns(revisions))
      .from(revisions)
      .innerJoin(drafts, eq(drafts.id, revisions.draft_id))
      .where(
        and(
          eq(drafts.id, draft),
          eq(drafts.owner_agent_id, agent.id),
          eq(revisions.number, current.number - 1),
        ),
      )
      .get();

    const history = await this.db
      .select({
        id: revisions.id,
        number: revisions.number,
        created_at: revisions.created_at,
        author_reviewer_id: revisions.author_reviewer_id,
      })
      .from(revisions)
      .where(eq(revisions.draft_id, status.id))
      .orderBy(desc(revisions.number));

    return { agent, status, current, previous: previous ?? null, history };
  }
}
