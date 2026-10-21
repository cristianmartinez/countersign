import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import app from "../apps/web/src/index";
import { AuthStore, DraftStore, ReviewerReads } from "../packages/db/src/index";
import { canonicalContent, sha256 } from "../packages/core/src/index";

const db = env.DB,
  secret = "bc".repeat(32),
  bindings = {
    ...env,
    SEND_QUEUE: { send: vi.fn(async (_message: unknown) => {}) },
    AGENT_KEY_ENCRYPTION_KEY: secret,
    SENDER_EMAIL: "team@example.com",
  };

const email = {
  from: "team@example.com",
  to: ["reviewer@example.com"] as [string],
  subject: "Review me",
  text: "Original text",
  html: "<p>Original HTML</p>",
};

let human: string,
  agent: string,
  cookie: string,
  csrf: string,
  otherCookie: string;

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  const auth = new AuthStore(db);

  const a = await auth.provision(
    {
      email: "reviewer@example.com",
      recipient: "reviewer@example.com",
      name: "Human",
      agentName: "Support agent",
      password: "correct horse battery staple",
    },
    secret,
  );

  const b = await auth.provision(
    {
      email: "other@example.com",
      recipient: "other@example.com",
      name: "Other",
      agentName: "Other agent",
      password: "correct horse battery staple",
    },
    secret,
  );

  human = a.reviewer_id;

  agent = a.agent_id;

  const first = await auth.login(
      "reviewer@example.com",
      "correct horse battery staple",
      "review-ip",
    ),
    second = await auth.login(
      "other@example.com",
      "correct horse battery staple",
      "other-review-ip",
    );

  csrf = first.csrf;

  cookie = `__Host-cs_session=${first.token}; __Host-cs_csrf=${csrf}`;

  otherCookie = `__Host-cs_session=${second.token}; __Host-cs_csrf=${second.csrf}`;
});

const store = new DraftStore(db);

async function draft(submit = true, content = email) {
  const d = await store.create(agent, crypto.randomUUID(), content);

  if (submit) await store.submit(agent, d.draft_id, d.revision_id);

  return { ...d, hash: await sha256(canonicalContent(content)) };
}

const get = (path: string, as = cookie) =>
  app.request(
    "https://service.test" + path,
    { headers: { Cookie: as } },
    bindings,
  );

const post = (
  id: string,
  action: "approve" | "reject",
  revision: string,
  hash: string,
  extra: Record<string, string> = {},
) =>
  app.request(
    `https://service.test/review/drafts/${id}/${action}`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        revision_id: revision,
        content_hash: hash,
        ...extra,
      }),
    },
    bindings,
  );

it("requires a reviewer session and rejects agent credentials before handling", async () => {
  expect((await get("/review", "")).status).toBe(303);

  const d = await draft();

  const agent = await app.request(
    `https://service.test/review/drafts/${d.draft_id}/approve`,
    {
      method: "POST",
      headers: { Authorization: "Bearer cs_agent_anything", Cookie: cookie },
    },
    bindings,
  );

  expect(agent.status).toBe(403);
});

it("lists owned emails across states and filters pending review", async () => {
  const waiting = await draft(),
    saved = await draft(false);

  const response = await get("/review");

  expect(response.status).toBe(200);

  const html = await response.text();

  expect(html).toContain(`/review/drafts/${waiting.draft_id}`);

  expect(html).toContain(`/review/drafts/${saved.draft_id}`);

  const pending = await (await get("/review?status=in_review")).text();

  expect(pending).toContain(`/review/drafts/${waiting.draft_id}`);
  expect(pending).not.toContain(`/review/drafts/${saved.draft_id}`);
  expect(html).toContain(">Emails<");
  expect(html).not.toContain("Human approval required");

  expect(response.headers.get("Cache-Control")).toBe("no-store");

  expect(await (await get("/review?view=all")).text()).toContain(
    `/review/drafts/${saved.draft_id}`,
  );

  expect(await (await get("/review", otherCookie)).text()).not.toContain(
    `/review/drafts/${waiting.draft_id}`,
  );

  expect((await get("/review?view=bogus")).status).toBe(400);
});

it("detail contains complete recipients, supplied bodies, exact revision/hash, and initial revision", async () => {
  const d = await draft(),
    response = await get(`/review/drafts/${d.draft_id}`),
    html = await response.text();

  expect(response.status).toBe(200);

  for (const value of [
    email.from,
    email.to[0],
    email.subject,
    email.text,
    "Initial revision",
    d.revision_id,
    d.hash,
    "HTML preview",
    'aria-label="HTML"',
    'aria-label="Text"',
  ])
    expect(html).toContain(value);

  expect(html).toContain("&lt;p&gt;Original HTML&lt;/p&gt;");

  expect(html).toContain('sandbox=""');

  expect(html).not.toContain("allow-same-origin");
});

it("compares against the previous revision, highlights fields/body changes, and historical views cannot approve", async () => {
  const d = await draft(),
    changed = {
      ...email,
      to: ["delivered@resend.dev"] as [string],
      subject: "Shorter subject",
      text: "Revised text",
      html: "<p>Revised HTML</p>",
    };

  const r = await store.revise(
    agent,
    d.draft_id,
    d.revision_id,
    crypto.randomUUID(),
    changed,
  );

  await store.submit(agent, d.draft_id, r.revision_id);

  const html = await (await get(`/review/drafts/${d.draft_id}`)).text();

  expect(html).toContain("Compared with revision 1");

  expect(html).toContain("<del>Review me</del>");

  expect(html).toContain("<ins>Shorter subject</ins>");

  expect(html).toContain("Original text");

  expect(html).toContain("Revised text");

  const old = await (
    await get(`/review/drafts/${d.draft_id}?revision=${d.revision_id}`)
  ).text();

  expect(old).toContain("Historical revision");

  expect(old).not.toContain(
    'action="/review/drafts/' + d.draft_id + '/approve"',
  );
});

it("isolates queue, draft detail and historical revisions between reviewers", async () => {
  const d = await draft();

  expect((await get(`/review/drafts/${d.draft_id}`, otherCookie)).status).toBe(
    404,
  );

  expect(
    (
      await get(
        `/review/drafts/${d.draft_id}?revision=${d.revision_id}`,
        otherCookie,
      )
    ).status,
  ).toBe(404);

  const response = await app.request(
    `https://service.test/review/drafts/${d.draft_id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: otherCookie,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: /__Host-cs_csrf=([^;]+)/.exec(otherCookie)![1]!,
        revision_id: d.revision_id,
        content_hash: d.hash,
      }),
    },
    bindings,
  );

  expect(response.status).toBe(404);
});

it("concurrent HTTP approvals create exactly one frozen intent and disable further actions", async () => {
  const d = await draft();

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      post(d.draft_id, "approve", d.revision_id, d.hash),
    ),
  );

  expect(results.every((r) => r.status === 303)).toBe(true);

  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM sends WHERE revision_id=?")
      .bind(d.revision_id)
      .first<{ n: number }>())!.n,
  ).toBe(1);

  const html = await (await get(`/review/drafts/${d.draft_id}`)).text();

  expect(html).toContain("approved");

  expect(html).not.toContain(">Approve revision");

  expect(html).not.toContain("Retry send");

  expect(html).toContain("Dispatch paused. No new send attempts will run.");
});

it("rejection requires reason and is visible to agent status", async () => {
  const d = await draft();

  expect((await post(d.draft_id, "reject", d.revision_id, d.hash)).status).toBe(
    422,
  );

  expect(
    (await post(d.draft_id, "reject", d.revision_id, d.hash, { reason: "   " }))
      .status,
  ).toBe(422);

  expect(
    (
      await post(d.draft_id, "reject", d.revision_id, d.hash, {
        reason: "Remove the promise",
      })
    ).status,
  ).toBe(303);

  const key = (await new AuthStore(db).reveal(human, secret)).key;

  const response = await app.request(
    `https://service.test/v1/drafts/${d.draft_id}/status`,
    { headers: { Authorization: `Bearer ${key}` } },
    bindings,
  );

  expect(await response.json()).toMatchObject({
    status: "rejected",
    review: { reason: "Remove the promise" },
    next: { action: "revise" },
  });
});

it("stale pages and bad CSRF never create reviews or sends", async () => {
  const d = await draft();

  await store.revise(agent, d.draft_id, d.revision_id, crypto.randomUUID(), {
    ...email,
    text: "Changed",
  });

  const stale = await post(d.draft_id, "approve", d.revision_id, d.hash);

  expect(stale.status).toBe(409);

  expect(await stale.text()).toContain("changed after you opened");

  const valid = await draft();

  expect(
    (
      await post(valid.draft_id, "approve", valid.revision_id, valid.hash, {
        csrf: "wrong",
      })
    ).status,
  ).toBe(403);

  expect(
    (await post(valid.draft_id, "approve", valid.revision_id, "00".repeat(32)))
      .status,
  ).toBe(409);

  expect(
    await db
      .prepare("SELECT id FROM reviews WHERE revision_id=?")
      .bind(valid.revision_id)
      .first(),
  ).toBeNull();

  const cross = await app.request(
    `https://service.test/review/drafts/${valid.draft_id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        revision_id: valid.revision_id,
        content_hash: valid.hash,
      }),
    },
    bindings,
  );

  expect(cross.status).toBe(403);
});

it("HTML source and diff are escaped, preview strips active content without altering the stored revision", async () => {
  const html =
    '<p>Safe</p><script>parent.pwned=true</script><form action="https://evil.test"><input></form><a href="https://evil.test" target="_top">Link</a><meta http-equiv="refresh" content="0;url=https://evil.test"><img src="https://evil.test/pixel" onerror="alert(1)">';

  const d = await draft(true, { ...email, html });

  const response = await get(`/review/drafts/${d.draft_id}`),
    body = await response.text();

  expect(body).toContain("&lt;script&gt;");

  expect(body).not.toContain("<script>parent.pwned");

  const match = /srcdoc="([^"]*)"/i.exec(body)![1]!;

  expect(match).not.toContain("parent.pwned");

  expect(match).not.toContain("action=");

  expect(match).not.toContain("href=");

  expect(match).not.toContain("src=");

  expect(match).toContain("default-src");

  expect(
    (await db
      .prepare("SELECT html_body FROM revisions WHERE id=?")
      .bind(d.revision_id)
      .first<{ html_body: string }>())!.html_body,
  ).toBe(html);
});

it("expired sessions cannot execute a decision and conflicts between approve/reject do not silently succeed", async () => {
  const old = await new AuthStore(db, () => 0).login(
      "reviewer@example.com",
      "correct horse battery staple",
      "expired-review-ip",
    ),
    d = await draft();

  const expired = await app.request(
    `https://service.test/review/drafts/${d.draft_id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: `__Host-cs_session=${old.token}`,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: old.csrf,
        revision_id: d.revision_id,
        content_hash: d.hash,
      }),
    },
    bindings,
  );

  expect(expired.status).toBe(303);

  expect(expired.headers.get("Location")).toBe("/login");

  const results = await Promise.all([
    post(d.draft_id, "approve", d.revision_id, d.hash),
    post(d.draft_id, "reject", d.revision_id, d.hash, { reason: "No" }),
  ]);

  expect(results.map((r) => r.status).sort()).toEqual([303, 409]);
});

it("publishes only the durable send ID and preserves approval when publication fails", async () => {
  const d = await draft();

  bindings.SEND_QUEUE.send.mockClear();

  bindings.SEND_QUEUE.send.mockRejectedValueOnce(
    new Error("Queue unavailable"),
  );

  expect(
    (await post(d.draft_id, "approve", d.revision_id, d.hash)).status,
  ).toBe(303);

  const send = await db
    .prepare("SELECT id,state FROM sends WHERE revision_id=?")
    .bind(d.revision_id)
    .first<{ id: string; state: string }>();

  expect(send?.state).toBe("queued");

  expect(bindings.SEND_QUEUE.send).toHaveBeenCalledWith({ send_id: send!.id });

  const rejected = await draft();

  bindings.SEND_QUEUE.send.mockClear();

  await post(rejected.draft_id, "reject", rejected.revision_id, rejected.hash, {
    reason: "Revise",
  });

  expect(bindings.SEND_QUEUE.send).not.toHaveBeenCalled();
});

it("review table searches all owned drafts, sorts stably, paginates and isolates reviewers", async () => {
  const prefix = `queue-${crypto.randomUUID()}%_'`,
    store = new DraftStore(db);

  const created = [];

  for (let index = 0; index < 10; index++)
    created.push(
      await store.create(agent, crypto.randomUUID(), {
        ...email,
        subject: `${prefix}-${String(index).padStart(2, "0")}`,
      }),
    );

  const reads = new ReviewerReads(db);

  const first = await reads.queue(human, true, {
    q: prefix,
    status: "drafted",
    sort: "subject",
    direction: "asc",
    pageSize: 8,
  });

  const second = await reads.queue(human, true, {
    q: prefix,
    status: "drafted",
    sort: "subject",
    direction: "asc",
    pageSize: 8,
    page: 2,
  });

  expect(first.total).toBe(10);

  expect(first.pageCount).toBe(2);

  expect(first.items.map((row) => row.id)).toEqual(
    created.slice(0, 8).map((row) => row.draft_id),
  );

  expect(second.items.map((row) => row.id)).toEqual(
    created.slice(8).map((row) => row.draft_id),
  );

  expect((await reads.queue(human, false, { q: prefix })).total).toBe(0);

  expect((await reads.queue(human, true, { q: "' OR 1=1 --" })).total).toBe(0);

  const uri = `/review?view=all&q=${encodeURIComponent(prefix)}&sort=subject&direction=asc&page=2`;

  const response = await get(uri),
    html = await response.text();

  expect(response.status).toBe(200);

  expect(html).toContain(`/review/drafts/${created[8]!.draft_id}`);

  expect(html).not.toContain(`/review/drafts/${created[0]!.draft_id}`);

  expect(await (await get(uri, otherCookie)).text()).not.toContain(
    `/review/drafts/${created[8]!.draft_id}`,
  );
});

it("review table rejects invalid filters and unbounded pagination", async () => {
  for (const query of [
    "page=0",
    "page=1001",
    "pageSize=999",
    "status=unknown",
    "sort=sql",
    "direction=sideways",
    `q=${"x".repeat(201)}`,
  ]) {
    expect((await get(`/review?${query}`)).status).toBe(400);
  }
});

it("reviewer edits create an attributed revision, invalidate the old approval form and replay safely", async () => {
  const d = await draft();
  const fields = {
    csrf,
    base_revision_id: d.revision_id,
    mutation_key: crypto.randomUUID(),
    subject: "Human correction",
    html: "<p>Corrected by reviewer</p>",
    text: "Corrected by reviewer",
  };
  const edit = () =>
    app.request(
      `https://service.test/review/drafts/${d.draft_id}/revise`,
      {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://service.test" },
        body: new URLSearchParams(fields),
      },
      bindings,
    );

  expect((await edit()).status).toBe(303);
  expect((await edit()).status).toBe(303);

  const detail = await new ReviewerReads(db).detail(human, d.draft_id);
  expect(detail.status.status).toBe("in_review");
  expect(detail.current.number).toBe(2);
  expect(detail.current.author_reviewer_id).toBe(human);
  expect(detail.current.subject).toBe("Human correction");
  expect(detail.current.text_body).toBe(fields.text);
  expect(detail.previous!.html_body).toBe(email.html);
  expect(
    (await post(d.draft_id, "approve", d.revision_id, d.hash)).status,
  ).toBe(409);
  expect(
    (
      await post(
        d.draft_id,
        "approve",
        detail.current.id,
        detail.current.content_hash,
      )
    ).status,
  ).toBe(303);

  const send = await db
    .prepare("SELECT payload FROM sends WHERE revision_id=?")
    .bind(detail.current.id)
    .first<{ payload: string }>();
  expect(JSON.parse(send!.payload).html).toBe(fields.html);
  expect(JSON.parse(send!.payload).text).toBe(fields.text);

  fields.base_revision_id = detail.current.id;
  fields.mutation_key = crypto.randomUUID();
  expect((await edit()).status).toBe(409);
});

it("reviewer edits reject foreign ownership, CSRF and stale base revisions", async () => {
  const d = await draft();
  const fields = {
    csrf,
    base_revision_id: d.revision_id,
    mutation_key: crypto.randomUUID(),
    subject: "Changed",
    text: "Changed",
  };
  const edit = (as = cookie, values = fields, authorization?: string) =>
    app.request(
      `https://service.test/review/drafts/${d.draft_id}/revise`,
      {
        method: "POST",
        headers: {
          Cookie: as,
          Origin: "https://service.test",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: new URLSearchParams(values),
      },
      bindings,
    );

  expect((await edit(cookie, { ...fields, csrf: "bad" })).status).toBe(403);
  const foreignCsrf = /__Host-cs_csrf=([^;]+)/.exec(otherCookie)![1]!;
  expect(
    (await edit(otherCookie, { ...fields, csrf: foreignCsrf })).status,
  ).toBe(404);
  expect((await edit(cookie, fields, "Bearer cs_agent_test")).status).toBe(403);
  await store.revise(
    agent,
    d.draft_id,
    d.revision_id,
    crypto.randomUUID(),
    email,
  );
  expect((await edit()).status).toBe(409);
});

it("preview hides document titles and preheaders without rewriting source", async () => {
  const { previewDocument } = await import("../apps/web/src/preview");
  const html = await previewDocument(
    '<html><head><title>Inbox title</title></head><body><div style="display:none">Hidden preheader</div><p>Visible body</p></body></html>',
  );
  expect(html).not.toContain("Inbox title");
  expect(html).toContain('style="display:none"');
  expect(html).toContain("Visible body");
});

it("reviewer revision racing approval has one winner and never changes approved content", async () => {
  const d = await draft();
  const results = await Promise.allSettled([
    store.reviseAsReviewer(
      human,
      d.draft_id,
      d.revision_id,
      crypto.randomUUID(),
      { ...email, subject: "Reviewer race" },
    ),
    store.decide(human, d.draft_id, d.revision_id, d.hash, "approved", null),
  ]);

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const detail = await new ReviewerReads(db).detail(human, d.draft_id);
  if (detail.status.status === "approved") {
    expect(detail.current.id).toBe(d.revision_id);
    expect(detail.current.subject).toBe(email.subject);
  } else {
    expect(detail.status.status).toBe("in_review");
    expect(detail.current.subject).toBe("Reviewer race");
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM sends WHERE revision_id=?")
        .bind(d.revision_id)
        .first<{ n: number }>())!.n,
    ).toBe(0);
  }
});

it("polls only an owned version, returns 304 unchanged, and snapshots reflect changes", async () => {
  const first = await get("/review/updates");
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const signal = (await first.json()) as { version: string };
  expect(Object.keys(signal)).toEqual(["version"]);

  const etag = first.headers.get("ETag")!;
  const unchanged = await app.request(
    "https://service.test/review/updates",
    {
      headers: { Cookie: cookie, "If-None-Match": etag },
    },
    bindings,
  );
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");

  // Foreign work cannot invalidate this account's signal.
  const other = await new ReviewerReads(db).agent(
    (await new AuthStore(db).session(
      /__Host-cs_session=([^;]+)/.exec(otherCookie)![1]!,
    ))!.reviewer_id,
  );
  await store.create(other.id, crypto.randomUUID(), {
    ...email,
    to: ["other@example.com"],
  });
  expect(await (await get("/review/updates")).json()).toEqual(signal);

  const d = await draft();
  const next = (await (await get("/review/updates")).json()) as {
    version: string;
  };
  expect(next.version).not.toBe(signal.version);

  const snapshot = await app.request(
    "https://service.test/review",
    {
      headers: { Cookie: cookie, Accept: "application/json" },
    },
    bindings,
  );
  const list = (await snapshot.json()) as {
    version: string;
    props: { items: Array<{ id: string }> };
  };
  expect(list.version).toBe(next.version);
  expect(list.props.items.some((row) => row.id === d.draft_id)).toBe(true);

  expect((await get("/review/updates", "")).status).toBe(303);
  expect(
    (
      await app.request(
        "https://service.test/review/updates",
        { headers: { Authorization: "Bearer cs_agent_test" } },
        bindings,
      )
    ).status,
  ).toBe(403);

  const detail = await app.request(
    `https://service.test/review/drafts/${d.draft_id}`,
    {
      headers: { Cookie: cookie, Accept: "application/json" },
    },
    bindings,
  );
  const data = (await detail.json()) as { props: { current: { id: string } } };
  expect(data.props.current.id).toBe(d.revision_id);
  expect(
    (
      await app.request(
        `https://service.test/review/drafts/${d.draft_id}`,
        { headers: { Cookie: otherCookie, Accept: "application/json" } },
        bindings,
      )
    ).status,
  ).toBe(404);
});

it("send attempts and delivery-only events invalidate status without any provider polling", async () => {
  const d = await draft();
  await store.decide(
    human,
    d.draft_id,
    d.revision_id,
    d.hash,
    "approved",
    null,
  );
  const reads = new ReviewerReads(db);
  const approved = await reads.version(human);
  const send = await db
    .prepare("SELECT id FROM sends WHERE revision_id=?")
    .bind(d.revision_id)
    .first<{ id: string }>();
  await db
    .prepare("UPDATE sends SET attempts=attempts+1 WHERE id=?")
    .bind(send!.id)
    .run();
  const attempted = await reads.version(human);
  expect(attempted).not.toBe(approved);

  await db
    .prepare(
      "INSERT INTO delivery_events (svix_id,send_id,resend_email_id,type,occurred_at,raw,applied_at) VALUES (?,?,?,'email.complained',?,'{}',NULL)",
    )
    .bind(crypto.randomUUID(), send!.id, crypto.randomUUID(), Date.now())
    .run();
  // Unapplied evidence is not yet visible in the reviewer history.
  expect(await reads.version(human)).toBe(attempted);
  await db
    .prepare(
      "UPDATE delivery_events SET applied_at=? WHERE send_id=? AND applied_at IS NULL",
    )
    .bind(Date.now(), send!.id)
    .run();
  expect(await reads.version(human)).not.toBe(attempted);
});
