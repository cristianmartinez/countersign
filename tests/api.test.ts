import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import app from "../apps/web/src/index";
import { AuthStore, DraftStore } from "../packages/db/src/index";
import { canonicalContent, sha256 } from "../packages/core/src/index";

const db = env.DB,
  secret = "ef".repeat(32),
  bindings = {
    ...env,
    AGENT_KEY_ENCRYPTION_KEY: secret,
    SENDER_EMAIL: "team@example.com",
  };

let token: string, other: string, agent: string, reviewer: string;

const email = {
  to: ["agent@example.com"],
  subject: "Hello",
  text: "Original text",
  html: "<p>Original text</p>",
};

const key = () => crypto.randomUUID();

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  options: {
    key?: string;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return app.request(
    "https://service.test/v1" + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${options.token ?? token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

interface Created {
  draft_id: string;
  revision_id: string;
  status: string;
  review_url: string;
}

async function create() {
  const response = await request("/drafts", "POST", email, { key: key() });

  expect(response.status).toBe(201);

  return response.json<Created>();
}

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  const store = new AuthStore(db);

  const a = await store.provision(
    {
      email: "agent@example.com",
      recipient: "agent@example.com",
      name: "Reviewer",
      password: "correct horse battery staple",
      agentName: "Support",
    },
    secret,
  );

  const b = await store.provision(
    {
      email: "other@example.com",
      recipient: "other@example.com",
      name: "Other",
      password: "correct horse battery staple",
      agentName: "Other",
    },
    secret,
  );

  token = (await store.reveal(a.reviewer_id, secret)).key;

  other = (await store.reveal(b.reviewer_id, secret)).key;

  agent = a.agent_id;

  reviewer = a.reviewer_id;
});

it("requires valid agent Bearer authentication; reviewer cookies grant no API access", async () => {
  for (const Authorization of [
    "",
    "Bearer wrong",
    "Bearer cs_agent_" + "00".repeat(32),
  ]) {
    const response = await app.request(
      "https://service.test/v1/me",
      { headers: { Authorization, Cookie: "__Host-cs_session=fake" } },
      bindings,
    );

    expect(response.status).toBe(401);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }

  const me = await request("/me");

  expect(me.status).toBe(200);

  const body = await me.json();

  expect(body).toMatchObject({
    agent_id: agent,
    name: "Support",
    scope: "own_drafts",
    from: "team@example.com",
  });

  expect(JSON.stringify(body)).not.toContain(token);

  expect(JSON.stringify(body)).not.toContain("other@example.com");
});

it("creates, retrieves and revises exact HTML/text and submits safely", async () => {
  const d = await create();

  expect(d.review_url).toBe(`https://service.test/review/drafts/${d.draft_id}`);

  const detail = await (await request(`/drafts/${d.draft_id}`)).json();

  expect(detail).toMatchObject({
    status: "drafted",
    revision: {
      to: email.to,
      from: "team@example.com",
      text: email.text,
      html: email.html,
    },
    next: { action: "submit" },
    poll_after_seconds: null,
  });

  const changed = {
    ...email,
    text: "Shorter",
    base_revision_id: d.revision_id,
  };

  const response = await request(
    `/drafts/${d.draft_id}/revisions`,
    "POST",
    changed,
    { key: key() },
  );

  expect(response.status).toBe(201);

  const revised = await response.json<Created>();

  const old = await (
    await request(`/drafts/${d.draft_id}/revisions/${d.revision_id}`)
  ).json();

  expect(old).toMatchObject({ text: email.text, number: 1 });

  const submit = await request(`/drafts/${d.draft_id}/submit`, "POST", {
    revision_id: revised.revision_id,
  });

  expect(submit.status).toBe(200);

  expect(await submit.json()).toMatchObject({
    status: "in_review",
    next: { action: "wait" },
    poll_after_seconds: 5,
  });

  const repeated = await request(`/drafts/${d.draft_id}/submit`, "POST", {
    revision_id: revised.revision_id,
  });

  expect(await repeated.json()).toMatchObject({ status: "in_review" });
});

it("supports concurrent replay and returns actionable stale-base conflicts", async () => {
  const k = key(),
    responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request("/drafts", "POST", email, { key: k }),
      ),
    );

  const results = await Promise.all(responses.map((r) => r.json<Created>()));

  expect(new Set(results.map((r) => r.draft_id)).size).toBe(1);

  const d = results[0]!,
    rk = key(),
    body = { ...email, base_revision_id: d.revision_id, text: "Next" };

  const revised = await (
    await request(`/drafts/${d.draft_id}/revisions`, "POST", body, { key: rk })
  ).json<Created>();

  await request(
    `/drafts/${d.draft_id}/revisions`,
    "POST",
    { ...body, base_revision_id: revised.revision_id, text: "Later" },
    { key: key() },
  );

  expect(
    await (
      await request(`/drafts/${d.draft_id}/revisions`, "POST", body, {
        key: rk,
      })
    ).json(),
  ).toEqual(revised);

  const stale = await request(`/drafts/${d.draft_id}/revisions`, "POST", body, {
    key: key(),
  });

  expect(stale.status).toBe(409);

  expect(await stale.json()).toMatchObject({
    error: {
      code: "revision_conflict",
      details: { latest: { draft_id: d.draft_id } },
    },
  });

  const mismatch = await request(
    "/drafts",
    "POST",
    { ...email, subject: "Different" },
    { key: k },
  );

  expect(mismatch.status).toBe(409);

  expect(await mismatch.json()).toMatchObject({
    error: { code: "idempotency_conflict" },
  });
});

it("hides other agents drafts and revisions on all read/mutation paths", async () => {
  const d = await create();

  for (const path of [
    `/drafts/${d.draft_id}`,
    `/drafts/${d.draft_id}/status`,
    `/drafts/${d.draft_id}/revisions`,
    `/drafts/${d.draft_id}/revisions/${d.revision_id}`,
  ])
    expect(
      (await request(path, "GET", undefined, { token: other })).status,
    ).toBe(404);

  expect(
    (
      await request(
        `/drafts/${d.draft_id}/submit`,
        "POST",
        { revision_id: d.revision_id },
        { token: other },
      )
    ).status,
  ).toBe(404);

  expect(
    (
      await request(
        `/drafts/${d.draft_id}/revisions`,
        "POST",
        {
          ...email,
          to: ["other@example.com"],
          base_revision_id: d.revision_id,
        },
        { key: key(), token: other },
      )
    ).status,
  ).toBe(404);

  const list = await (
    await request("/drafts", "GET", undefined, { token: other })
  ).json<{ items: unknown[] }>();

  expect(list.items).toHaveLength(0);

  const notThisDraft = await create();

  expect(
    (
      await request(
        `/drafts/${d.draft_id}/revisions/${notThisDraft.revision_id}`,
      )
    ).status,
  ).toBe(404);
});

it("rejects unsupported fields, invalid recipients and missing/invalid idempotency keys", async () => {
  for (const field of [
    "cc",
    "bcc",
    "attachments",
    "reply_to",
    "from",
    "react",
    "template",
  ]) {
    const response = await request(
      "/drafts",
      "POST",
      { ...email, [field]: [] },
      { key: key() },
    );

    expect(response.status).toBe(422);

    expect(await response.json()).toHaveProperty("error.details.fields");
  }

  for (const to of [
    [],
    email.to.concat("delivered@resend.dev"),
    ["Name <agent@example.com>"],
    ["Agent@example.com"],
    ["agent+tag@example.com"],
    ["arbitrary@resend.dev"],
  ])
    expect(
      (await request("/drafts", "POST", { ...email, to }, { key: key() }))
        .status,
    ).toBe(422);

  for (const idempotency of [undefined, "bad key", "x".repeat(129)])
    expect(
      (
        await request(
          "/drafts",
          "POST",
          email,
          idempotency === undefined ? {} : { key: idempotency },
        )
      ).status,
    ).toBe(400);

  expect(
    (
      await request(
        "/drafts",
        "POST",
        { to: email.to, subject: "No body" },
        { key: key() },
      )
    ).status,
  ).toBe(422);

  const normalized = await request(
    "/drafts",
    "POST",
    { ...email, to: [" agent@EXAMPLE.COM "] },
    { key: key() },
  );

  expect(normalized.status).toBe(201);

  const d = await normalized.json<Created>();

  expect(await (await request(`/drafts/${d.draft_id}`)).json()).toMatchObject({
    revision: { to: ["agent@example.com"] },
  });

  for (const to of [
    "delivered@resend.dev",
    "bounced@resend.dev",
    "complained@resend.dev",
    "suppressed@resend.dev",
  ])
    expect(
      (await request("/drafts", "POST", { ...email, to: [to] }, { key: key() }))
        .status,
    ).toBe(201);
});

it("enforces Unicode field limits, malformed JSON, and request byte limits independent of Content-Length", async () => {
  expect(
    (
      await request(
        "/drafts",
        "POST",
        {
          ...email,
          subject: "😀".repeat(200),
          text: "x".repeat(102400),
          html: undefined,
        },
        { key: key() },
      )
    ).status,
  ).toBe(201);

  for (const body of [
    { ...email, subject: "😀".repeat(201) },
    { ...email, text: "é".repeat(51201) },
    { ...email, subject: "injected\r\nheader" },
  ])
    expect(
      (await request("/drafts", "POST", body, { key: key() })).status,
    ).toBe(422);

  const malformed = await app.request(
    "https://service.test/v1/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key(),
      },
      body: "{",
    },
    bindings,
  );

  expect(malformed.status).toBe(400);

  for (const headers of [{}, { "Content-Length": "1" }]) {
    const large = await app.request(
      "https://service.test/v1/drafts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key(),
          ...headers,
        },
        body: JSON.stringify({ ...email, text: "x".repeat(262144) }),
      },
      bindings,
    );

    expect(large.status).toBe(413);
  }
});

it("paginates with stable ordering and rejects altered, cross-agent and cross-filter cursors", async () => {
  await create();

  await create();

  const page = await (
    await request("/drafts?limit=1")
  ).json<{ items: { draft_id: string }[]; next_cursor: string }>();

  expect(page.items).toHaveLength(1);

  expect(page.next_cursor).toBeTypeOf("string");

  const next = await (
    await request(
      "/drafts?limit=1&cursor=" + encodeURIComponent(page.next_cursor),
    )
  ).json<{ items: { draft_id: string }[] }>();

  expect(next.items[0]!.draft_id).not.toBe(page.items[0]!.draft_id);

  for (const path of [
    "/drafts?limit=0",
    "/drafts?limit=101",
    "/drafts?limit=1.5",
    "/drafts?status=unknown",
    "/drafts?cursor=garbage",
    `/drafts?status=drafted&cursor=${encodeURIComponent(page.next_cursor)}`,
  ])
    expect((await request(path)).status).toBe(400);

  expect(
    (
      await request(
        "/drafts?cursor=" + encodeURIComponent(page.next_cursor),
        "GET",
        undefined,
        { token: other },
      )
    ).status,
  ).toBe(400);

  const d = await create();

  let base = d.revision_id;

  for (let n = 0; n < 3; n++) {
    const r = await (
      await request(
        `/drafts/${d.draft_id}/revisions`,
        "POST",
        { ...email, base_revision_id: base },
        { key: key() },
      )
    ).json<Created>();

    base = r.revision_id;
  }

  const first = await (
    await request(`/drafts/${d.draft_id}/revisions?limit=2`)
  ).json<{ items: { number: number }[]; next_cursor: string }>();

  expect(first.items.map((i) => i.number)).toEqual([4, 3]);

  const last = await (
    await request(
      `/drafts/${d.draft_id}/revisions?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
    )
  ).json<{ items: { number: number }[]; next_cursor: null }>();

  expect(last.items.map((i) => i.number)).toEqual([2, 1]);

  expect(last.next_cursor).toBeNull();
});

it("returns current rejection and send status without leaking frozen payloads or polling blocked work", async () => {
  const d = await create();

  await request(`/drafts/${d.draft_id}/submit`, "POST", {
    revision_id: d.revision_id,
  });

  const store = new DraftStore(db);

  await store.decide(
    reviewer,
    d.draft_id,
    d.revision_id,
    await sha256(
      canonicalContent({
        ...email,
        to: ["agent@example.com"],
        from: "team@example.com",
      }),
    ),
    "rejected",
    "Make it shorter",
  );

  const rejected = await (await request(`/drafts/${d.draft_id}/status`)).json();

  expect(rejected).toMatchObject({
    status: "rejected",
    review: { reason: "Make it shorter" },
    next: { action: "revise" },
    poll_after_seconds: null,
  });

  const revised = await (
    await request(
      `/drafts/${d.draft_id}/revisions`,
      "POST",
      { ...email, base_revision_id: d.revision_id },
      { key: key() },
    )
  ).json<Created>();

  await request(`/drafts/${d.draft_id}/submit`, "POST", {
    revision_id: revised.revision_id,
  });

  await store.decide(
    reviewer,
    d.draft_id,
    revised.revision_id,
    await sha256(
      canonicalContent({
        ...email,
        to: ["agent@example.com"],
        from: "team@example.com",
      }),
    ),
    "approved",
  );

  expect(
    (
      await request(
        `/drafts/${d.draft_id}/revisions`,
        "POST",
        { ...email, base_revision_id: revised.revision_id },
        { key: key() },
      )
    ).status,
  ).toBe(409);

  await db.batch([
    db
      .prepare(
        "UPDATE sends SET state='failed',needs_reconciliation=1,last_error='Unknown outcome' WHERE revision_id=?",
      )
      .bind(revised.revision_id),
    db.prepare("UPDATE drafts SET status='failed' WHERE id=?").bind(d.draft_id),
  ]);

  const failed = await (await request(`/drafts/${d.draft_id}/status`)).json();

  expect(failed).toMatchObject({
    status: "failed",
    next: { action: "contact_operator" },
    poll_after_seconds: null,
    send: { needs_reconciliation: true },
  });

  expect(JSON.stringify(failed)).not.toContain("payload");
});

it("has no agent approval or send route, and public instructions contain no credential", async () => {
  const d = await create();

  for (const suffix of ["approve", "reject", "send"])
    expect(
      (await request(`/drafts/${d.draft_id}/${suffix}`, "POST", {})).status,
    ).toBe(404);

  const skill = await app.request(
    "https://service.test/SKILL.md",
    {},
    bindings,
  );

  expect(skill.status).toBe(200);

  const text = await skill.text();

  expect(text).toContain("Idempotency-Key");

  expect(text).toContain("two minutes");

  expect(text).not.toContain(token);

  expect(text).not.toContain(other);

  const page = await (
    await request("/drafts?limit=1")
  ).json<{ next_cursor: string }>();

  expect(
    (
      await request(
        "/drafts?cursor=" + encodeURIComponent(page.next_cursor + ".extra"),
      )
    ).status,
  ).toBe(400);
});

it("lists a configured test inbox only once in recipient discovery", async () => {
  const store = new AuthStore(db);
  const account = await store.provision(
    {
      email: "catalog@example.com",
      recipient: "delivered@resend.dev",
      name: "Catalog reviewer",
      password: "correct horse battery staple",
      agentName: "Catalog agent",
    },
    secret,
  );
  const credential = (await store.reveal(account.reviewer_id, secret)).key;

  const response = await request("/me", "GET", undefined, {
    token: credential,
  });
  const body = await response.json<{ allowed_recipients: string[] }>();

  expect(response.status).toBe(200);
  expect(body.allowed_recipients[0]).toBe("delivered@resend.dev");
  expect(body.allowed_recipients).toEqual([
    ...new Set(body.allowed_recipients),
  ]);
});
