import { Hono, type Context } from "hono";
import { z } from "zod";
import { LIMITS, sha256, TEST_RECIPIENTS } from "@countersign/core";
import {
  AgentReads,
  DraftStore,
  Conflict,
  type AgentIdentity,
  type RevisionRow,
  type StatusRow,
} from "@countersign/db";

export { TEST_RECIPIENTS } from "@countersign/core";

import {
  statuses,
  createSchema,
  reviseSchema,
  submitSchema,
  agentRoutes,
} from "./api-contract";

type ApiEnv = { Bindings: Env; Variables: { agent: AgentIdentity } };

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 413 | 422,
    public code: string,
    message: string,
    public hint: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const error = (
  status: 400 | 401 | 404 | 409 | 413 | 422,
  code: string,
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
) => new ApiError(status, code, message, hint, details);

async function jsonBody(c: Context<ApiEnv>): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? ""))
    throw error(
      400,
      "bad_request",
      "JSON required",
      "Set Content-Type: application/json.",
    );

  if (c.req.header("Content-Encoding"))
    throw error(
      400,
      "bad_request",
      "Encoded bodies are unsupported",
      "Send uncompressed UTF-8 JSON.",
    );

  const reader = c.req.raw.body?.getReader();

  const chunks: Uint8Array[] = [];

  let size = 0;

  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > LIMITS.requestBytes) {
          await reader.cancel();

          throw error(
            413,
            "payload_too_large",
            "JSON exceeds 256 KiB",
            "Reduce the complete JSON request size.",
          );
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

  const all = new Uint8Array(size);

  let offset = 0;

  for (const chunk of chunks) {
    all.set(chunk, offset);

    offset += chunk.length;
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all),
    );
  } catch {
    throw error(
      400,
      "bad_request",
      "Invalid JSON or UTF-8",
      "Send valid UTF-8 JSON.",
    );
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success)
    throw error(
      422,
      "validation_error",
      "Invalid draft fields",
      "Correct the fields listed in details.fields.",
      {
        fields: parsed.error.issues.map((i) => ({
          field: i.path.join(".") || "body",
          message: i.message,
        })),
      },
    );

  return parsed.data;
}

function recipient(input: string, allowed: string): string {
  const value = input.trim(),
    at = value.lastIndexOf("@");

  if (
    !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
      value,
    ) ||
    at < 1
  )
    throw error(
      422,
      "validation_error",
      "Invalid recipient",
      "Use a plain email address without a display name.",
      { fields: [{ field: "to.0", message: "Plain address required" }] },
    );

  const normalized =
    value.slice(0, at) + "@" + value.slice(at + 1).toLowerCase();

  if (normalized !== allowed && !TEST_RECIPIENTS.includes(normalized))
    throw error(
      422,
      "validation_error",
      "Recipient is not allowed",
      "Use your configured inbox or a supported test address.",
      {
        fields: [{ field: "to.0", message: "Recipient not permitted" }],
        allowed_recipients: [...new Set([allowed, ...TEST_RECIPIENTS])],
      },
    );

  return normalized;
}

function idempotency(c: Context<ApiEnv>) {
  const key = c.req.header("Idempotency-Key");

  if (!key || !/^[A-Za-z0-9._:/-]{1,128}$/.test(key))
    throw error(
      400,
      "bad_request",
      "Idempotency-Key required",
      "Use 1–128 letters, digits, dots, underscores, colons, slashes or hyphens; reuse the same key/body on retry.",
    );

  return key;
}

const reviewUrl = (c: Context<ApiEnv>, id: string) =>
  `${new URL(c.req.url).origin}/review/drafts/${id}`;

function next(row: StatusRow) {
  if (row.needs_reconciliation)
    return {
      action: "contact_operator",
      message:
        "Delivery is unknown. Contact the operator; do not create a replacement draft.",
    };

  if (row.status === "drafted")
    return {
      action: "submit",
      message: "Submit current_revision_id, or revise first.",
    };

  if (row.status === "rejected")
    return {
      action: "revise",
      message:
        "Read review.reason, create a revision using current_revision_id as base_revision_id, then submit.",
    };

  if (["in_review", "approved", "sending", "sent"].includes(row.status))
    return {
      action: "wait",
      message:
        "Poll after 5 seconds for up to two minutes, then return the review link and resume only when asked.",
    };

  return {
    action: "done",
    message:
      row.status === "delivered"
        ? "The recipient mail server accepted the email."
        : "Report the recorded outcome; do not create a replacement automatically.",
  };
}

function statusResponse(c: Context<ApiEnv>, row: StatusRow) {
  const guidance = next(row);

  return {
    draft_id: row.id,
    status: row.status,
    current_revision_id: row.current_revision_id,
    review_url: reviewUrl(c, row.id),
    review: row.decision
      ? {
          decision: row.decision,
          reason: row.reason,
          revision_id: row.review_revision,
        }
      : null,
    send: row.send_state
      ? {
          state: row.send_state,
          error: row.last_error,
          needs_reconciliation: Boolean(row.needs_reconciliation),
          resend_email_id: row.resend_email_id,
          delivery_status: row.delivery_status,
          events_url: new URL(`/v1/drafts/${row.id}/events`, c.req.url).href,
        }
      : null,
    next: guidance,
    poll_after_seconds: guidance.action === "wait" ? 5 : null,
  };
}

function revisionResponse(row: RevisionRow) {
  return {
    revision_id: row.id,
    draft_id: row.draft_id,
    number: row.number,
    author_agent_id: row.author_agent_id,
    author_reviewer_id: row.author_reviewer_id,
    base_revision_id: row.base_revision_id,
    from: row.sender,
    to: [row.recipient],
    subject: row.subject,
    ...(row.text_body === null ? {} : { text: row.text_body }),
    ...(row.html_body === null ? {} : { html: row.html_body }),
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
}

const api = new Hono<ApiEnv>();

api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");

  const header = c.req.header("Authorization") ?? "";

  const match = /^Bearer (cs_agent_[a-f0-9]{64})$/.exec(header);

  if (!match)
    throw error(
      401,
      "unauthorized",
      "Agent credential required",
      "Use Authorization: Bearer cs_agent_...; reviewer cookies do not authenticate API requests.",
    );

  const agent = await new AgentReads(c.env.DB).authenticate(
    await sha256(match[1]!),
  );

  if (!agent)
    throw error(
      401,
      "unauthorized",
      "Agent credential required",
      "Check your key on the authenticated Connect page.",
    );

  c.set("agent", agent);

  await next();
});

api.onError(async (e, c) => {
  if (e instanceof ApiError)
    return c.json(
      {
        error: {
          code: e.code,
          message: e.message,
          hint: e.hint,
          details: e.details,
        },
      },
      e.status,
    );

  if (e instanceof Conflict) {
    let details: Record<string, unknown> = {};

    if (e.code === "revision_conflict") {
      const id = c.req.param("draft");

      if (id)
        try {
          const row = await new AgentReads(c.env.DB).status(
            c.get("agent").id,
            id,
          );

          const revision = await new AgentReads(c.env.DB).revision(
            c.get("agent").id,
            row.id,
            row.current_revision_id,
          );

          details = {
            latest: {
              ...statusResponse(c, row),
              revision: revisionResponse(revision),
            },
          };
        } catch {
          /* preserve original conflict */
        }
    }

    const status =
      e.code === "not_found" ? 404 : e.code === "validation_error" ? 422 : 409;

    return c.json(
      {
        error: {
          code: e.code,
          message: e.code.replaceAll("_", " "),
          hint:
            e.code === "revision_conflict"
              ? "Read details.latest and merge against its current_revision_id."
              : e.code === "idempotency_conflict"
                ? "Reuse a key only for an identical request."
                : "Check the current draft status and supported operation.",
          details,
        },
      },
      status,
    );
  }

  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Request could not be completed",
        hint: "Retry mutations with the same Idempotency-Key and body.",
        details: {},
      },
    },
    500,
  );
});

api.get(agentRoutes.getIdentity.path, (c) => {
  const a = c.get("agent");

  return c.json({
    agent_id: a.id,
    name: a.name,
    scope: "own_drafts",
    from: c.env.SENDER_EMAIL,
    allowed_recipients: [
      ...new Set([a.allowed_recipient_email, ...TEST_RECIPIENTS]),
    ],
    test_aliases_supported: false,
    limits: LIMITS,
  });
});

api.post(agentRoutes.createDraft.path, async (c) => {
  const key = idempotency(c),
    body = parse(createSchema, await jsonBody(c));

  const result = await new DraftStore(c.env.DB).create(c.get("agent").id, key, {
    subject: body.subject,
    ...(body.text === undefined ? {} : { text: body.text }),
    ...(body.html === undefined ? {} : { html: body.html }),
    from: c.env.SENDER_EMAIL,
    to: [recipient(body.to[0], c.get("agent").allowed_recipient_email)],
  });

  return c.json({ ...result, review_url: reviewUrl(c, result.draft_id) }, 201);
});

api.post(agentRoutes.reviseDraft.path, async (c) => {
  const key = idempotency(c),
    body = parse(reviseSchema, await jsonBody(c));

  const { base_revision_id, ...content } = body;

  const result = await new DraftStore(c.env.DB).revise(
    c.get("agent").id,
    c.req.param("draft"),
    base_revision_id,
    key,
    {
      subject: content.subject,
      ...(content.text === undefined ? {} : { text: content.text }),
      ...(content.html === undefined ? {} : { html: content.html }),
      from: c.env.SENDER_EMAIL,
      to: [recipient(content.to[0], c.get("agent").allowed_recipient_email)],
    },
  );

  return c.json({ ...result, review_url: reviewUrl(c, result.draft_id) }, 201);
});

api.post(agentRoutes.submitDraft.path, async (c) => {
  const body = parse(submitSchema, await jsonBody(c));

  await new DraftStore(c.env.DB).submit(
    c.get("agent").id,
    c.req.param("draft"),
    body.revision_id,
  );

  return c.json(
    statusResponse(
      c,
      await new AgentReads(c.env.DB).status(
        c.get("agent").id,
        c.req.param("draft"),
      ),
    ),
  );
});

api.get(agentRoutes.getDraftStatus.path, async (c) =>
  c.json(
    statusResponse(
      c,
      await new AgentReads(c.env.DB).status(
        c.get("agent").id,
        c.req.param("draft"),
      ),
    ),
  ),
);

api.get(agentRoutes.getDraft.path, async (c) => {
  const reads = new AgentReads(c.env.DB),
    row = await reads.status(c.get("agent").id, c.req.param("draft"));

  const revision = await reads.revision(
    c.get("agent").id,
    row.id,
    row.current_revision_id,
  );

  return c.json({
    ...statusResponse(c, row),
    revision: revisionResponse(revision),
  });
});

api.get(agentRoutes.getRevision.path, async (c) =>
  c.json(
    revisionResponse(
      await new AgentReads(c.env.DB).revision(
        c.get("agent").id,
        c.req.param("draft"),
        c.req.param("revision"),
      ),
    ),
  ),
);

// Signed cursors bind the position to this identity, collection and filters.
async function cursorKey(agent: AgentIdentity) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(agent.key_hash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function encodeCursor(
  agent: AgentIdentity,
  context: string,
  position: { value: number; id: string },
) {
  const payload = JSON.stringify({ context, ...position }),
    sig = await crypto.subtle.sign(
      "HMAC",
      await cursorKey(agent),
      new TextEncoder().encode(payload),
    );

  return (
    btoa(payload) +
    "." +
    Array.from(new Uint8Array(sig), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}

async function page(c: Context<ApiEnv>, context: string) {
  const raw = c.req.query("limit") ?? "20";

  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 100)
    throw error(
      400,
      "bad_request",
      "Invalid limit",
      "Use an integer from 1 to 100.",
    );

  const cursor = c.req.query("cursor");

  if (!cursor) return { limit: Number(raw), after: undefined };

  try {
    if (cursor.length > 2048) throw new Error();

    const pieces = cursor.split(".");

    if (pieces.length !== 2) throw new Error();

    const [part, sig] = pieces;

    if (!part || !sig || !/^[a-f0-9]{64}$/.test(sig)) throw new Error();

    const payload = atob(part);

    const valid = await crypto.subtle.verify(
      "HMAC",
      await cursorKey(c.get("agent")),
      Uint8Array.from(sig.match(/../g)!, (b) => parseInt(b, 16)),
      new TextEncoder().encode(payload),
    );

    const decoded = z
      .strictObject({
        context: z.literal(context),
        value: z.number().int().nonnegative(),
        id: context.startsWith("delivery:")
          ? z.string().min(1).max(200)
          : z.string().uuid(),
      })
      .parse(JSON.parse(payload));

    if (!valid) throw new Error();

    return {
      limit: Number(raw),
      after: { value: decoded.value, id: decoded.id },
    };
  } catch {
    throw error(
      400,
      "bad_request",
      "Invalid cursor",
      "Use next_cursor unchanged with the same collection and filters.",
    );
  }
}

api.get(agentRoutes.listEvents.path, async (c) => {
  const draft = c.req.param("draft"),
    context = "delivery:" + draft,
    p = await page(c, context);

  const rows = await new AgentReads(c.env.DB).listDeliveryEvents(
      c.get("agent").id,
      draft,
      p.limit,
      p.after,
    ),
    items = rows.slice(0, p.limit),
    last = items.at(-1);

  return c.json({
    items,
    next_cursor:
      rows.length > p.limit && last
        ? await encodeCursor(c.get("agent"), context, {
            value: last.occurred_at,
            id: last.id,
          })
        : null,
  });
});

api.get(agentRoutes.listDrafts.path, async (c) => {
  const filter = c.req.query("status");

  if (filter && !statuses.includes(filter as (typeof statuses)[number]))
    throw error(
      400,
      "bad_request",
      "Invalid status",
      "Use a documented draft status.",
    );

  const context = "drafts:" + (filter ?? ""),
    p = await page(c, context),
    rows = await new AgentReads(c.env.DB).listDrafts(
      c.get("agent").id,
      p.limit,
      filter,
      p.after,
    ),
    items = rows.slice(0, p.limit),
    last = items.at(-1);

  return c.json({
    items: items.map((r) => ({
      draft_id: r.id,
      status: r.status,
      current_revision_id: r.current_revision_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      review_url: reviewUrl(c, r.id),
    })),
    next_cursor:
      rows.length > p.limit && last
        ? await encodeCursor(c.get("agent"), context, {
            value: last.created_at,
            id: last.id,
          })
        : null,
  });
});

api.get(agentRoutes.listRevisions.path, async (c) => {
  const draft = c.req.param("draft"),
    context = "revisions:" + draft,
    p = await page(c, context),
    rows = await new AgentReads(c.env.DB).listRevisions(
      c.get("agent").id,
      draft,
      p.limit,
      p.after,
    ),
    items = rows.slice(0, p.limit),
    last = items.at(-1);

  return c.json({
    items: items.map((r) => ({
      revision_id: r.id,
      number: r.number,
      author_agent_id: r.author_agent_id,
      author_reviewer_id: r.author_reviewer_id,
      created_at: r.created_at,
    })),
    next_cursor:
      rows.length > p.limit && last
        ? await encodeCursor(c.get("agent"), context, {
            value: last.number,
            id: last.id,
          })
        : null,
  });
});

api.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "No such API route",
        hint: "Use a documented /v1 endpoint. There are no agent approve or send endpoints.",
        details: {},
      },
    },
    404,
  ),
);

export { api };
