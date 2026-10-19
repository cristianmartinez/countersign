import { z } from "zod";
import { LIMITS } from "@countersign/core";

export const statuses = [
  "drafted",
  "in_review",
  "rejected",
  "approved",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "failed",
] as const;

const uuid = z.string().uuid(),
  timestamp = z.number().int().nonnegative(),
  url = z.url();

const bodyField = z
  .string()
  .refine(
    (s) => new TextEncoder().encode(s).length <= LIMITS.bodyBytes,
    "Body must be at most 100 KiB UTF-8",
  )
  .meta({
    description:
      "Final supplied body, unchanged after approval. Maximum 100 KiB UTF-8; this byte limit is enforced by the service.",
    "x-max-utf8-bytes": LIMITS.bodyBytes,
  });

const contentFields = {
  to: z.tuple([
    z
      .string()
      .describe(
        "One plain address. Allowed inbox/test recipients come from GET /v1/me. Outer whitespace is trimmed and only the domain is lowercased.",
      ),
  ]),
  subject: z
    .string()
    .refine(
      (s) =>
        [...s].length >= 1 &&
        [...s].length <= LIMITS.subjectCodePoints &&
        !/[\r\n]/.test(s),
      "Subject must be 1–200 Unicode characters without line breaks",
    )
    .meta({
      minLength: 1,
      maxLength: LIMITS.subjectCodePoints,
      pattern: "^[^\\r\\n]+$",
    }),
  text: bodyField.optional(),
  html: bodyField.optional(),
};

const hasBody = (v: { text?: string | undefined; html?: string | undefined }) =>
  Boolean(v.text?.length || v.html?.length);

const bodyRule = {
  description:
    "Supply text, HTML or both; at least one must be nonempty. Strict fields: no from, JSX, templates, CC/BCC, attachments or Reply-To. Entire uncompressed JSON is bounded to 256 KiB while streaming.",
  anyOf: [
    {
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
    },
    {
      required: ["html"],
      properties: { html: { type: "string", minLength: 1 } },
    },
  ],
  "x-max-request-bytes": LIMITS.requestBytes,
};

export const createSchema = z
  .strictObject(contentFields)
  .refine(hasBody, {
    message: "Supply at least one nonempty text or html body",
    path: ["text"],
  })
  .meta(bodyRule);

export const reviseSchema = z
  .strictObject({ ...contentFields, base_revision_id: uuid })
  .refine(hasBody, {
    message: "Supply at least one nonempty text or html body",
    path: ["text"],
  })
  .meta({
    ...bodyRule,
    description:
      bodyRule.description +
      " Full replacement against the current base revision; omitted bodies are removed. Approval locks the draft permanently.",
  });

export const submitSchema = z.strictObject({ revision_id: uuid });

const mutation = z.strictObject({
  draft_id: uuid,
  revision_id: uuid,
  status: z.enum(statuses),
  review_url: url,
});

const revision = z.strictObject({
  revision_id: uuid,
  draft_id: uuid,
  number: z.number().int().positive(),
  author_agent_id: z.string(),
  author_reviewer_id: z.string().nullable(),
  base_revision_id: uuid.nullable(),
  from: z.string(),
  to: z.tuple([z.string()]),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: timestamp,
});

const status = z.strictObject({
  draft_id: uuid,
  status: z.enum(statuses),
  current_revision_id: uuid,
  review_url: url,
  review: z
    .strictObject({
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().nullable(),
      revision_id: uuid,
    })
    .nullable(),
  send: z
    .strictObject({
      state: z.enum(["queued", "sending", "retry_wait", "sent", "failed"]),
      error: z.string().nullable(),
      needs_reconciliation: z.boolean(),
      resend_email_id: z.string().nullable(),
      delivery_status: z
        .enum(["sent", "delivered", "bounced", "failed", "suppressed"])
        .nullable(),
      events_url: url,
    })
    .nullable(),
  next: z.strictObject({
    action: z.enum(["submit", "revise", "wait", "done", "contact_operator"]),
    message: z.string(),
  }),
  poll_after_seconds: z.literal(LIMITS.pollSeconds).nullable(),
});

const draftItem = z.strictObject({
  draft_id: uuid,
  status: z.enum(statuses),
  current_revision_id: uuid,
  created_at: timestamp,
  updated_at: timestamp,
  review_url: url,
});

const revisionItem = z.strictObject({
  revision_id: uuid,
  number: z.number().int().positive(),
  author_agent_id: z.string(),
  author_reviewer_id: z.string().nullable(),
  created_at: timestamp,
});

const event = z.strictObject({
  id: z.string(),
  type: z.string(),
  occurred_at: timestamp,
  detail: z.string().max(4000).nullable(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), next_cursor: z.string().nullable() });

export const apiSchemas = {
  CreateDraft: createSchema,
  ReviseDraft: reviseSchema,
  SubmitDraft: submitSchema,
  Mutation: mutation,
  Revision: revision,
  Status: status,
  Draft: status.extend({ revision }),
  Identity: z.strictObject({
    agent_id: z.string(),
    name: z.string(),
    scope: z.literal("own_drafts"),
    from: z.string(),
    allowed_recipients: z.array(z.string()),
    test_aliases_supported: z.literal(false),
    limits: z.strictObject(
      Object.fromEntries(
        Object.entries(LIMITS).map(([key, value]) => [key, z.literal(value)]),
      ),
    ),
  }),
  DraftPage: page(draftItem),
  RevisionPage: page(revisionItem),
  EventPage: page(event),
  Error: z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "bad_request",
        "unauthorized",
        "not_found",
        "revision_conflict",
        "revision_changed",
        "idempotency_conflict",
        "invalid_state",
        "validation_error",
        "payload_too_large",
        "internal_error",
      ]),
      message: z.string(),
      hint: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
  }),
};

// Route paths are used by Hono and by the generator. Tests also compare the verbs.
export const agentRoutes = {
  getIdentity: {
    method: "get",
    path: "/me",
    summary: "Discover identity, fixed sender, allowed recipients and limits",
    response: "Identity",
    code: 200,
  },
  createDraft: {
    method: "post",
    path: "/drafts",
    summary: "Create a private draft",
    description:
      "Requires Idempotency-Key. Persist key/body before dispatch. Exact successful replays return the original result for 24 hours, even after later edits.",
    request: "CreateDraft",
    response: "Mutation",
    code: 201,
    idempotency: true,
  },
  reviseDraft: {
    method: "post",
    path: "/drafts/:draft/revisions",
    summary: "Create a full replacement revision",
    description:
      "Requires Idempotency-Key and current base_revision_id. Allowed only before approval; stale bases conflict. A rejection needs a new revision before resubmission.",
    request: "ReviseDraft",
    response: "Mutation",
    code: 201,
    idempotency: true,
  },
  submitDraft: {
    method: "post",
    path: "/drafts/:draft/submit",
    summary: "Submit the current revision for human review",
    description:
      "Repeated submission returns current state without resetting review, reopening rejection or restarting sending. Return review_url to the human.",
    request: "SubmitDraft",
    response: "Status",
    code: 200,
  },
  getDraftStatus: {
    method: "get",
    path: "/drafts/:draft/status",
    summary: "Check review, sending and delivery status",
    description:
      "Follow next.action and poll_after_seconds: five seconds in wait states, at most two minutes per waiting session. Then hand back the link/status. contact_operator means stop; never create a replacement automatically. sent means provider acceptance, not delivery.",
    response: "Status",
    code: 200,
  },
  getDraft: {
    method: "get",
    path: "/drafts/:draft",
    summary: "Read current content and status",
    response: "Draft",
    code: 200,
  },
  getRevision: {
    method: "get",
    path: "/drafts/:draft/revisions/:revision",
    summary: "Read an immutable revision",
    response: "Revision",
    code: 200,
  },
  listEvents: {
    method: "get",
    path: "/drafts/:draft/events",
    summary: "Inspect verified delivery evidence",
    description:
      "Newest occurrence time then Svix ID descending. Bounce outranks failure/suppression, delivered, then sent. Complaint/delay are details only. Sent alone cannot clear reconciliation.",
    response: "EventPage",
    code: 200,
    list: true,
  },
  listDrafts: {
    method: "get",
    path: "/drafts",
    summary: "List owned drafts",
    description:
      "Created time then ID descending. Optional status filter; ownership applies to every page.",
    response: "DraftPage",
    code: 200,
    list: true,
    filter: true,
  },
  listRevisions: {
    method: "get",
    path: "/drafts/:draft/revisions",
    summary: "List revision history",
    description: "Revision number then ID descending.",
    response: "RevisionPage",
    code: 200,
    list: true,
  },
} as const;
