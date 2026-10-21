/** @jsxImportSource hono/jsx */
import { UiButton, UiHeader, UiReviewTable, UiReviewDetail } from "./ui";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AuthStore,
  AgentReads,
  ReviewerReads,
  DraftStore,
  SendStore,
  Conflict,
  type Session,
} from "@countersign/db";
import { csrfValid, SESSION_COOKIE, CSRF_COOKIE } from "./auth";
import { previewDocument } from "./preview";
import { reviseSchema } from "./api-contract";

const review = new Hono<{ Bindings: Env; Variables: { session: Session } }>();

review.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");

  c.header("Referrer-Policy", "same-origin");

  c.header("X-Content-Type-Options", "nosniff");

  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );

  if (c.req.header("Authorization"))
    return c.json({ error: { code: "agent_key_not_allowed" } }, 403);

  const session = await new AuthStore(c.env.DB).session(
    getCookie(c, SESSION_COOKIE),
  );

  if (!session) return c.redirect("/login", 303);

  c.set("session", session);

  await next();
});

review.use("*", (c, next) =>
  bodyLimit({
    maxSize: c.req.path.endsWith("/revise") ? 1024 * 1024 : 4096,
    onError: (c) => c.text("Review form too large.", 413),
  })(c, next),
);

review.onError((error, c) => {
  if (error instanceof Conflict) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "validation_error"
          ? 422
          : 409;

    return c.html(
      <Layout docsUrl={c.env.DOCS_URL}>
        <h1>{status === 404 ? "Email not found" : "Decision not applied"}</h1>
        <p>
          {error.code === "revision_changed"
            ? "This email changed after you opened it. Reload and review the complete current revision."
            : error.code === "validation_error"
              ? "Recipient policy changed. No send was created."
              : status === 404
                ? "No accessible email or revision."
                : "A decision already exists or this email is not awaiting review."}
        </p>
        <a href="/review">Return to queue</a>
        {status !== 404 && (
          <p>
            <a href={c.req.path.replace(/\/(approve|reject)$/, "")}>
              Reload current email
            </a>
          </p>
        )}
      </Layout>,
      status,
    );
  }

  return c.html(
    <Layout docsUrl={c.env.DOCS_URL}>
      <h1>Unable to complete review</h1>
      <p>Please reload before trying again.</p>
    </Layout>,
    500,
  );
});

function Layout({
  children,
  queue = false,
  detail = false,
  docsUrl,
  version,
}: {
  version?: string;
  children: import("hono/jsx").Child;
  queue?: boolean;
  detail?: boolean;
  docsUrl: string;
}) {
  return (
    <html lang="en" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Countersign review</title>
        <link rel="stylesheet" href="/assets/ui.css" />
      </head>
      <body>
        <UiHeader review docsUrl={docsUrl} />
        <main
          data-review-version={version}
          class={queue ? "review-queue" : detail ? "review-detail" : undefined}
        >
          {children}
        </main>
      </body>
    </html>
  );
}

async function reviewVersion(
  db: D1Database,
  reviewer: string,
  enabled: string,
) {
  return `${await new ReviewerReads(db).version(reviewer)}:${enabled}`;
}

review.get("/updates", async (c) => {
  const version = await reviewVersion(
    c.env.DB,
    c.get("session").reviewer_id,
    c.env.SEND_ENABLED,
  );
  const etag = JSON.stringify(version);
  c.header("ETag", etag);

  if (
    c.req
      .header("If-None-Match")
      ?.split(",")
      .map((value) => value.trim())
      .includes(etag)
  )
    return c.body(null, 304);

  return c.json({ version });
});

review.get("/", async (c) => {
  c.header("Vary", "Accept");
  // Read before the snapshot: a concurrent mutation must remain detectable next poll.
  const version = await reviewVersion(
    c.env.DB,
    c.get("session").reviewer_id,
    c.env.SEND_ENABLED,
  );
  const parsed = z
    .object({
      view: z.enum(["pending", "all"]).default("all"),
      q: z.string().trim().max(200).default(""),
      status: z
        .enum([
          "",
          "drafted",
          "in_review",
          "rejected",
          "approved",
          "sending",
          "sent",
          "delivered",
          "bounced",
          "failed",
        ])
        .default(""),
      sort: z
        .enum(["created", "subject", "recipient", "revision", "status"])
        .default("created"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      page: z.coerce.number().int().min(1).max(1000).default(1),
      pageSize: z.enum(["8", "20", "50"]).default("8"),
    })
    .safeParse(c.req.query());

  if (!parsed.success) return c.text("Invalid queue filters or page", 400);

  const { view, pageSize, ...options } = parsed.data;

  const result = await new ReviewerReads(c.env.DB).queue(
    c.get("session").reviewer_id,
    true,
    {
      ...options,
      status: options.status || (view === "pending" ? "in_review" : ""),
      pageSize: Number(pageSize) as 8 | 20 | 50,
    },
  );

  if (c.req.header("Accept") === "application/json")
    return c.json({ version, props: result });

  return c.html(
    <Layout queue docsUrl={c.env.DOCS_URL} version={version}>
      <UiReviewTable {...result} />
      <script type="module" src="/assets/ui-client.js"></script>
    </Layout>,
  );
});

review.get("/drafts/:draft", async (c) => {
  c.header("Vary", "Accept");
  const version = await reviewVersion(
    c.env.DB,
    c.get("session").reviewer_id,
    c.env.SEND_ENABLED,
  );
  const selected = c.req.query("revision");

  if (selected && !z.string().uuid().safeParse(selected).success)
    return c.text("Invalid revision", 400);

  const { agent, status, current, previous, history } = await new ReviewerReads(
    c.env.DB,
  ).detail(c.get("session").reviewer_id, c.req.param("draft"), selected);

  let eventAfter: { value: number; id: string } | undefined;

  const eventCursor = c.req.query("events_cursor");

  if (eventCursor)
    try {
      if (eventCursor.length > 2048) throw new Error();

      eventAfter = z
        .strictObject({
          value: z.number().int().nonnegative(),
          id: z.string().min(1).max(200),
        })
        .parse(JSON.parse(atob(eventCursor)));
    } catch {
      return c.text("Invalid delivery event cursor", 400);
    }

  const eventRows = await new AgentReads(c.env.DB).listDeliveryEvents(
      agent.id,
      status.id,
      20,
      eventAfter,
    ),
    events = eventRows.slice(0, 20),
    lastEvent = events.at(-1);

  const olderEvents =
    eventRows.length > 20 && lastEvent
      ? `/review/drafts/${status.id}?${new URLSearchParams({ ...(selected ? { revision: selected } : {}), events_cursor: btoa(JSON.stringify({ value: lastEvent.occurred_at, id: lastEvent.id })) })}`
      : null;

  const props = {
    agent,
    status,
    current,
    previous,
    history,
    preview:
      current.html_body !== null
        ? await previewDocument(current.html_body)
        : null,
    csrf: getCookie(c, CSRF_COOKIE) ?? "",
    events,
    olderEvents,
    sendingEnabled: c.env.SEND_ENABLED === "true",
  };

  if (c.req.header("Accept") === "application/json")
    return c.json({ version, props });

  return c.html(
    <Layout detail docsUrl={c.env.DOCS_URL} version={version}>
      <UiReviewDetail {...props} />
      <script type="module" src="/assets/ui-client.js"></script>
    </Layout>,
  );
});

review.post("/drafts/:draft/revise", async (c) => {
  const body = await c.req.parseBody();

  if (!(await csrfValid(c.req.raw, body.csrf, c.get("session"))))
    return c.text("Invalid CSRF token or origin. Reload the email.", 403);

  const metadata = z
    .object({
      base_revision_id: z.string().uuid(),
      mutation_key: z.string().uuid(),
      subject: z.string(),
    })
    .safeParse(body);

  if (!metadata.success) return c.text("Invalid revision or edit fields.", 422);

  const { current } = await new ReviewerReads(c.env.DB).detail(
    c.get("session").reviewer_id,
    c.req.param("draft"),
  );

  const content = reviseSchema.safeParse({
    base_revision_id: metadata.data.base_revision_id,
    to: [current.recipient],
    subject: metadata.data.subject,
    ...(typeof body.html === "string" ? { html: body.html } : {}),
    ...(typeof body.text === "string" ? { text: body.text } : {}),
  });

  if (!content.success)
    return c.text(
      "Enter a subject (1–200 characters) and a nonempty email body (100 KiB per format).",
      422,
    );

  await new DraftStore(c.env.DB).reviseAsReviewer(
    c.get("session").reviewer_id,
    c.req.param("draft"),
    content.data.base_revision_id,
    metadata.data.mutation_key,
    {
      from: current.sender,
      to: content.data.to,
      subject: content.data.subject,
      ...(content.data.html !== undefined ? { html: content.data.html } : {}),
      ...(content.data.text !== undefined ? { text: content.data.text } : {}),
    },
  );

  return c.redirect(`/review/drafts/${c.req.param("draft")}`, 303);
});

const decisionSchema = z.strictObject({
  csrf: z.string(),
  revision_id: z.string().uuid(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(2000).optional(),
});

for (const decision of ["approve", "reject"] as const)
  review.post(`/drafts/:draft/${decision}`, async (c) => {
    const body = await c.req.parseBody();

    if (!(await csrfValid(c.req.raw, body.csrf, c.get("session"))))
      return c.text("Invalid CSRF token or origin. Reload the email.", 403);

    const parsed = decisionSchema.safeParse(body);

    if (!parsed.success || (decision === "reject" && !parsed.data.reason))
      return c.text(
        "A valid revision/hash and a nonempty rejection reason (at most 2000 characters) are required.",
        422,
      );

    await new DraftStore(c.env.DB).decide(
      c.get("session").reviewer_id,
      c.req.param("draft"),
      parsed.data.revision_id,
      parsed.data.content_hash,
      decision === "approve" ? "approved" : "rejected",
      decision === "reject" ? parsed.data.reason! : null,
    );

    if (decision === "approve") {
      try {
        const sendId = await new SendStore(c.env.DB).sendIdForRevision(
          parsed.data.revision_id,
        );

        await c.env.SEND_QUEUE.send({ send_id: sendId });
      } catch {
        // Approval and outbox already committed; Cron repairs a missing queue hint.
        console.warn(
          JSON.stringify({
            event: "approval_hint_publish_failed",
            revision_id: parsed.data.revision_id,
          }),
        );
      }
    }

    return c.redirect(`/review/drafts/${c.req.param("draft")}`, 303);
  });

export { review };
