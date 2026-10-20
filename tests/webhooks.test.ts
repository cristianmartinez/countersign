import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createHmac } from "node:crypto";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import app from "../apps/web/src/index";
import { DraftStore, SendStore, DeliveryStore } from "../packages/db/src/index";
import { canonicalContent, sha256 } from "../packages/core/src/index";
import { processSend } from "../apps/send/src/process";
import { recover } from "../apps/send/src/index";

const db = env.DB,
  secretBytes = Buffer.alloc(32, 23),
  secret = "whsec_" + secretBytes.toString("base64");

const bindings = {
  ...env,
  RESEND_WEBHOOK_SECRET: secret,
  SENDER_EMAIL: "team@example.com",
};

const email = {
  from: "team@example.com",
  to: ["human@example.com"] as [string],
  subject: "Verified delivery",
  text: "Approved text",
};

const agentToken = "cs_agent_" + "ab".repeat(32),
  otherToken = "cs_agent_" + "cd".repeat(32);

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  await db.batch([
    db.prepare(
      "INSERT INTO reviewers(id,email,name,password_hash,allowed_recipient_email) VALUES ('human','human@example.com','Human','hash','human@example.com'),('other','other@example.com','Other','hash','other@example.com')",
    ),
    db
      .prepare(
        "INSERT INTO agents (id,reviewer_id,name,key_hash,key_ciphertext,key_nonce,key_encryption_version) VALUES ('agent','human','Agent',?,'cipher','nonce',1),('other-agent','other','Other',?,'cipher','nonce',1)",
      )
      .bind(await sha256(agentToken), await sha256(otherToken)),
    db
      .prepare(
        "INSERT INTO reviewer_sessions(token_hash,reviewer_id,created_at,expires_at,csrf_hash) VALUES (?,'human',?,?,'csrf')",
      )
      .bind(
        await sha256("reviewer-session"),
        Date.now(),
        Date.now() + 86400000,
      ),
  ]);
});

afterEach(() => vi.restoreAllMocks());

async function approved(accepted = true) {
  const store = new DraftStore(db),
    d = await store.create("agent", crypto.randomUUID(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await store.decide(
    "human",
    d.draft_id,
    d.revision_id,
    await sha256(canonicalContent(email)),
    "approved",
  );

  const id = (await new SendStore(db).sendIdForRevision(d.revision_id))!,
    providerId = crypto.randomUUID();

  if (accepted)
    await processSend(db, id, email.from, async () => ({ id: providerId }));

  return { ...d, id, providerId };
}

type Draft = Awaited<ReturnType<typeof approved>>;

function event(
  d: Draft,
  type = "email.delivered",
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    created_at: new Date().toISOString(),
    data: {
      email_id: d.providerId,
      from: email.from,
      to: email.to,
      subject: email.subject,
      tags: { draft_id: d.draft_id, revision_id: d.revision_id },
      ...extra,
    },
  };
}

function sign(
  raw: string,
  id = "msg_" + crypto.randomUUID(),
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  return {
    "Content-Type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature":
      "v1," +
      createHmac("sha256", secretBytes)
        .update(`${id}.${timestamp}.${raw}`)
        .digest("base64"),
  };
}

async function post(
  value: unknown,
  options: {
    id?: string;
    timestamp?: string;
    headers?: Record<string, string>;
    secret?: string;
  } = {},
) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);

  return app.request(
    "https://service.test/webhooks/resend",
    {
      method: "POST",
      body: raw,
      headers: {
        ...sign(raw, options.id, options.timestamp),
        ...options.headers,
      },
    },
    { ...bindings, RESEND_WEBHOOK_SECRET: options.secret ?? secret },
  );
}

async function state(d: Draft) {
  return (await db
    .prepare(
      "SELECT s.*,d.status AS draft_status FROM sends s JOIN revisions r ON r.id=s.revision_id JOIN drafts d ON d.id=r.draft_id WHERE s.id=?",
    )
    .bind(d.id)
    .first<{
      state: string;
      draft_status: string;
      delivery_status: string | null;
      last_error: string | null;
      needs_reconciliation: number;
      attempts: number;
      lease_token: string | null;
      updated_at: number;
    }>())!;
}

async function count(id: string) {
  return (await db
    .prepare("SELECT count(*) AS n FROM delivery_events WHERE svix_id=?")
    .bind(id)
    .first<{ n: number }>())!.n;
}

it("verifies the original body bytes, retains raw event/provider timestamp and deduplicates concurrent deliveries", async () => {
  const d = await approved(),
    value = event(d),
    raw = JSON.stringify(value, null, 2),
    id = "msg_" + crypto.randomUUID();

  const results = await Promise.all(
    Array.from({ length: 6 }, () => post(raw, { id })),
  );

  expect(results.every((r) => r.status === 200)).toBe(true);

  expect(await count(id)).toBe(1);

  const stored = await db
    .prepare(
      "SELECT raw,occurred_at,send_id,applied_at FROM delivery_events WHERE svix_id=?",
    )
    .bind(id)
    .first<{
      raw: string;
      occurred_at: number;
      send_id: string;
      applied_at: number | null;
    }>();

  expect(stored?.raw).toBe(raw);

  expect(stored?.occurred_at).toBe(Date.parse(value.created_at));

  expect(stored?.send_id).toBe(d.id);

  expect(stored?.applied_at).not.toBeNull();

  expect((await state(d)).draft_status).toBe("delivered");

  const before = await state(d);

  await post(raw, { id });

  expect((await state(d)).updated_at).toBe(before.updated_at);
});

it("rejects tampered bodies, signatures, IDs, missing headers and stale/future signing timestamps without writes", async () => {
  const d = await approved(),
    raw = JSON.stringify(event(d)),
    id = "msg_" + crypto.randomUUID(),
    headers = sign(raw, id);

  expect(
    (
      await app.request(
        "https://service.test/webhooks/resend",
        { method: "POST", headers, body: raw + " " },
        bindings,
      )
    ).status,
  ).toBe(400);

  for (const changed of [
    { "svix-signature": "v1,bad" },
    { "svix-id": "different" },
    { "svix-timestamp": "" },
    { "svix-signature": "" },
  ])
    expect((await post(raw, { id, headers: changed })).status).toBe(400);

  for (const offset of [-301, 301])
    expect(
      (
        await post(raw, {
          id,
          timestamp: String(Math.floor(Date.now() / 1000) + offset),
        })
      ).status,
    ).toBe(400);

  expect(await count(id)).toBe(0);

  expect((await state(d)).draft_status).toBe("sent");
});

it("fails closed without a signing secret and agent/session credentials cannot authorize a webhook", async () => {
  const d = await approved(),
    raw = JSON.stringify(event(d));

  expect((await post(raw, { secret: "" })).status).toBe(503);

  for (const headers of [
    { Authorization: `Bearer ${agentToken}` },
    { Cookie: "__Host-cs_session=reviewer-session" },
  ])
    expect(
      (
        await app.request(
          "https://service.test/webhooks/resend",
          {
            method: "POST",
            body: raw,
            headers: { "Content-Type": "application/json", ...headers },
          },
          bindings,
        )
      ).status,
    ).toBe(400);
});

it("validates signed payloads, bounds streamed bytes and ignores unsubscribed event types", async () => {
  const d = await approved();

  expect((await post("{")).status).toBe(400);

  expect((await post({ ...event(d), created_at: "bad" })).status).toBe(422);

  expect(
    (await post(event(d, "email.delivered", { email_id: "" }))).status,
  ).toBe(422);

  expect(
    (await post(event(d, "email.delivered", { tags: { revision_id: 12 } })))
      .status,
  ).toBe(422);

  const unknown = "msg_" + crypto.randomUUID();

  expect(
    (await post({ type: "contact.created" }, { id: unknown })).status,
  ).toBe(200);

  expect(await count(unknown)).toBe(0);

  expect(
    (
      await post("x".repeat(256 * 1024 + 1), {
        headers: { "Content-Length": "1" },
      })
    ).status,
  ).toBe(413);

  expect(
    (await post(event(d), { headers: { "Content-Type": "text/plain" } }))
      .status,
  ).toBe(415);
});

it("stores early events without trusting tags, then correlates automatically after the receipt is persisted", async () => {
  const d = await approved(false),
    id = "msg_" + crypto.randomUUID();

  expect((await post(event(d), { id })).status).toBe(200);

  expect(
    await db
      .prepare("SELECT send_id,applied_at FROM delivery_events WHERE svix_id=?")
      .bind(id)
      .first(),
  ).toEqual({ send_id: null, applied_at: null });

  expect((await state(d)).draft_status).toBe("approved");

  await processSend(db, d.id, email.from, async () => ({ id: d.providerId }));

  expect((await state(d)).draft_status).toBe("delivered");

  expect((await state(d)).attempts).toBe(1);
});

it("correlates by provider ID with optional tags, rejects conflicts and retains unrelated events", async () => {
  const a = await approved(),
    b = await approved(),
    bad = "msg_" + crypto.randomUUID();

  await post(
    event(a, "email.bounced", {
      tags: { draft_id: b.draft_id, revision_id: b.revision_id },
    }),
    { id: bad },
  );

  expect((await state(a)).draft_status).toBe("sent");

  expect((await state(b)).draft_status).toBe("sent");

  expect(
    await db
      .prepare("SELECT send_id FROM delivery_events WHERE svix_id=?")
      .bind(bad)
      .first(),
  ).toEqual({ send_id: null });

  const unknown = "msg_" + crypto.randomUUID();

  await post(event(a, "email.delivered", { email_id: crypto.randomUUID() }), {
    id: unknown,
  });

  expect((await state(a)).draft_status).toBe("sent");

  expect(await count(unknown)).toBe(1);

  await post(event(a, "email.delivered", { tags: undefined }));

  expect((await state(a)).draft_status).toBe("delivered");

  await new DeliveryStore(db).recover();

  expect((await state(a)).draft_status).toBe("delivered");
});

function permutations<T>(values: T[]): T[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((v, i) =>
        permutations(values.filter((_, n) => n !== i)).map((t) => [v, ...t]),
      );
}

it("all 24 permutations retain bounce > failure/suppression > delivered > sent precedence", async () => {
  for (const order of permutations([
    "email.sent",
    "email.delivered",
    "email.failed",
    "email.bounced",
  ])) {
    const d = await approved();

    for (const type of order)
      expect(
        (
          await post(
            event(d, type, {
              bounce: { message: "Mailbox missing" },
              failed: { reason: "provider failure" },
            }),
          )
        ).status,
      ).toBe(200);

    const saved = await state(d);

    expect(saved.draft_status).toBe("bounced");

    expect(saved.delivery_status).toBe("bounced");

    expect(saved.last_error).toContain("Mailbox missing");

    expect(saved.needs_reconciliation).toBe(0);
  }
});

it.each(["email.failed", "email.suppressed"])(
  "%s outranks delivery in both orders and keeps its reason",
  async (type) => {
    for (const order of [
      [type, "email.delivered"],
      ["email.delivered", type],
    ]) {
      const d = await approved();

      for (const t of order)
        await post(
          event(d, t, {
            failed: { reason: "provider quota" },
            suppressed: { message: "Suppression list" },
          }),
        );

      const saved = await state(d);

      expect(saved.draft_status).toBe("failed");

      expect(saved.delivery_status).toBe(type.slice(6));

      expect(saved.last_error).toContain(
        type === "email.failed" ? "provider quota" : "Suppression list",
      );
    }
  },
);

it("complaint and delay add details without changing top-level status or resolving uncertainty", async () => {
  const d = await approved();

  await db.batch([
    db
      .prepare(
        "UPDATE sends SET state='failed',needs_reconciliation=1,last_error='unknown outcome' WHERE id=?",
      )
      .bind(d.id),
    db.prepare("UPDATE drafts SET status='failed' WHERE id=?").bind(d.draft_id),
  ]);

  for (const type of [
    "email.delivery_delayed",
    "email.complained",
    "email.sent",
  ])
    await post(event(d, type));

  let saved = await state(d);

  expect(saved.draft_status).toBe("failed");

  expect(saved.needs_reconciliation).toBe(1);

  expect(saved.last_error).toBe("unknown outcome");

  await post(event(d));

  saved = await state(d);

  expect(saved.draft_status).toBe("delivered");

  expect(saved.needs_reconciliation).toBe(0);

  expect(saved.last_error).toBeNull();

  expect(saved.attempts).toBe(1);
});

it("fences in-flight worker completion so neither success nor retry overwrites provider outcomes", async () => {
  for (const kind of ["accepted", "retry"] as const) {
    const d = await approved(false),
      store = new SendStore(db),
      lease = (await store.claim(d.id))!;

    // Receipt recorded before webhook; the provider response/timeout is still in flight.
    await db
      .prepare("UPDATE sends SET resend_email_id=? WHERE id=?")
      .bind(d.providerId, d.id)
      .run();

    await post(
      event(d, "email.bounced", { bounce: { message: "Mailbox gone" } }),
    );

    expect(
      await store.finish(lease, {
        kind,
        unknown: kind === "retry",
        providerId: d.providerId,
        nextAt: Date.now() + 5000,
      }),
    ).toBe(false);

    expect((await state(d)).draft_status).toBe("bounced");

    expect((await state(d)).last_error).toContain("Mailbox gone");

    expect((await state(d)).lease_token).toBeNull();

    expect(await store.claim(d.id)).toBeNull();
  }
});

it("recovers persisted-but-unapplied events after a projection failure, including while dispatch is paused", async () => {
  const d = await approved(),
    id = "msg_" + crypto.randomUUID(),
    spy = vi
      .spyOn(DeliveryStore.prototype, "correlate")
      .mockRejectedValueOnce(new Error("D1 unavailable"));

  expect((await post(event(d), { id })).status).toBe(503);

  expect(await count(id)).toBe(1);

  expect((await state(d)).draft_status).toBe("sent");

  spy.mockRestore();

  await recover({
    DB: db,
    SEND_ENABLED: "false",
    SENDER_EMAIL: email.from,
    RESEND_API_KEY: "",
    SEND_QUEUE: { send: vi.fn() },
  });

  expect((await state(d)).draft_status).toBe("delivered");

  const another = await approved(),
    retryId = "msg_" + crypto.randomUUID(),
    fail = vi
      .spyOn(DeliveryStore.prototype, "correlate")
      .mockRejectedValueOnce(new Error("D1 unavailable"));

  await post(event(another), { id: retryId });

  fail.mockRestore();

  expect((await post(event(another), { id: retryId })).status).toBe(200);

  expect((await state(another)).draft_status).toBe("delivered");

  expect(await count(retryId)).toBe(1);
});

it("same svix-id cannot replace the retained event or redirect its correlation", async () => {
  const a = await approved(),
    b = await approved(),
    id = "msg_" + crypto.randomUUID();

  await post(event(a), { id });

  await post(event(b, "email.bounced"), { id });

  expect((await state(a)).draft_status).toBe("delivered");

  expect((await state(b)).draft_status).toBe("sent");

  expect(await count(id)).toBe(1);
});

it("old provider occurrence times are accepted with fresh delivery signatures and do not weaken precedence", async () => {
  const d = await approved(),
    value = {
      ...event(d, "email.bounced"),
      created_at: "2020-01-01T00:00:00.000Z",
    };

  await post(value);

  await post(event(d));

  expect((await state(d)).draft_status).toBe("bounced");
});

const getApi = (path: string, token = agentToken) =>
  app.request(
    "https://service.test/v1" + path,
    { headers: { Authorization: `Bearer ${token}` } },
    bindings,
  );

it("exposes owned event details with stable pagination and context-bound cursors", async () => {
  const d = await approved(),
    types = ["email.delivery_delayed", "email.complained", "email.failed"];

  for (let i = 0; i < 23; i++)
    await post({
      ...event(d, types[i % 3]!, {
        failed: {
          reason: i === 0 ? "<img src=x onerror=alert(1)>" : "reason-" + i,
        },
      }),
      created_at: "2025-01-01T00:00:00.000Z",
    });

  const status = await (
    await getApi(`/drafts/${d.draft_id}/status`)
  ).json<{ status: string; send: { events_url: string } }>();

  expect(status.status).toBe("failed");

  expect(status.send.events_url).toBe(
    `https://service.test/v1/drafts/${d.draft_id}/events`,
  );

  const seen: string[] = [];

  let cursor: string | null = null,
    firstCursor = "";

  do {
    const response = await getApi(
      `/drafts/${d.draft_id}/events?limit=2${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
    );

    expect(response.status).toBe(200);

    const page = await response.json<{
      items: { id: string; type: string; detail: string | null }[];
      next_cursor: string | null;
    }>();

    seen.push(...page.items.map((e) => e.id));

    cursor = page.next_cursor;

    if (!firstCursor && cursor) firstCursor = cursor;
  } while (cursor);

  expect(seen).toHaveLength(23);

  expect(new Set(seen).size).toBe(23);

  expect(seen).toEqual([...seen].sort().reverse());

  expect(
    (await getApi(`/drafts/${d.draft_id}/events`, otherToken)).status,
  ).toBe(404);

  const other = await approved();

  expect(
    (
      await getApi(
        `/drafts/${other.draft_id}/events?cursor=${encodeURIComponent(firstCursor)}`,
      )
    ).status,
  ).toBe(400);

  expect((await getApi(`/drafts/${d.draft_id}/events?limit=101`)).status).toBe(
    400,
  );

  const first = await app.request(
      `https://service.test/review/drafts/${d.draft_id}`,
      { headers: { Cookie: "__Host-cs_session=reviewer-session" } },
      bindings,
    ),
    html = await first.text();

  expect(first.status).toBe(200);

  expect(html).toContain("Delivery events");

  expect(html).toContain("email.complained");

  expect(html).toContain("email.delivery_delayed");

  expect(html).toContain("Older delivery events");

  expect(html).not.toContain("<img src=x");

  const older = html.match(/href="([^"]+)"[^>]*>Older delivery events/);

  expect(older).not.toBeNull();

  const next = await app.request(
    "https://service.test" + older![1]!.replaceAll("&amp;", "&"),
    { headers: { Cookie: "__Host-cs_session=reviewer-session" } },
    bindings,
  );

  expect(next.status).toBe(200);

  expect(await next.text()).toContain("email.");
});

it("rolls back correlation and projections together when a later statement fails, then retries the stored event", async () => {
  const d = await approved(),
    id = "msg_" + crypto.randomUUID();

  await db.exec(
    `CREATE TRIGGER webhook_projection_test BEFORE UPDATE ON drafts WHEN NEW.id='${d.draft_id}' AND NEW.status='delivered' BEGIN SELECT RAISE(ABORT,'test_projection_failure'); END;`,
  );

  try {
    expect((await post(event(d), { id })).status).toBe(503);

    expect(await count(id)).toBe(1);

    expect((await state(d)).delivery_status).toBeNull();

    expect((await state(d)).draft_status).toBe("sent");

    expect(
      await db
        .prepare(
          "SELECT send_id,applied_at FROM delivery_events WHERE svix_id=?",
        )
        .bind(id)
        .first(),
    ).toEqual({ send_id: null, applied_at: null });
  } finally {
    await db.exec("DROP TRIGGER webhook_projection_test;");
  }

  expect((await post(event(d), { id })).status).toBe(200);

  expect((await state(d)).draft_status).toBe("delivered");
});

it("picks deterministic reasons for equal-ranked evidence and failure over suppression in either order", async () => {
  for (const types of [
    ["email.failed", "email.suppressed"],
    ["email.suppressed", "email.failed"],
  ]) {
    const d = await approved();

    for (const type of types)
      await post(
        event(d, type, {
          failed: { reason: "Failure reason" },
          suppressed: { message: "Suppression reason" },
        }),
      );

    expect((await state(d)).delivery_status).toBe("failed");

    expect((await state(d)).last_error).toContain("Failure reason");

    await post({
      ...event(d, "email.bounced", { bounce: { message: "New reason" } }),
      created_at: "2025-01-02T00:00:00.000Z",
    });

    await post({
      ...event(d, "email.bounced", { bounce: { message: "Old reason" } }),
      created_at: "2025-01-01T00:00:00.000Z",
    });

    expect((await state(d)).last_error).toContain("New reason");
  }
});

it("recovery respects its batch bound without touching uncorrelatable foreign events", async () => {
  const drafts = [await approved(), await approved(), await approved()],
    ids = drafts.map(() => "msg_" + crypto.randomUUID());

  await db.batch(
    drafts.map((d, i) =>
      db
        .prepare(
          "INSERT INTO delivery_events(svix_id,resend_email_id,type,occurred_at,raw) VALUES (?,?,?,?,?)",
        )
        .bind(
          ids[i]!,
          d.providerId,
          "email.delivered",
          Date.now(),
          JSON.stringify(event(d)),
        ),
    ),
  );

  await new DeliveryStore(db).recover(2);

  const counts = await Promise.all(
    ids.map(
      async (id) =>
        (await db
          .prepare("SELECT applied_at FROM delivery_events WHERE svix_id=?")
          .bind(id)
          .first<{ applied_at: number | null }>())!.applied_at,
    ),
  );

  expect(counts.filter((v) => v !== null)).toHaveLength(2);

  await new DeliveryStore(db).recover(2);

  expect(
    (await Promise.all(drafts.map(state))).every(
      (s) => s.draft_status === "delivered",
    ),
  ).toBe(true);
});

it("handles the provider-receipt/webhook race without losing an early event", async () => {
  for (let i = 0; i < 8; i++) {
    const d = await approved(false);

    await Promise.all([
      post(event(d)),
      processSend(db, d.id, email.from, async () => ({ id: d.providerId })),
    ]);

    expect((await state(d)).draft_status).toBe("delivered");

    expect((await state(d)).attempts).toBe(1);
  }
});

it.each([
  "email.delivered",
  "email.bounced",
  "email.failed",
  "email.suppressed",
])(
  "%s resolves a known-ID uncertain send without another attempt or unlocking the revision",
  async (type) => {
    const d = await approved();

    await db.batch([
      db
        .prepare(
          "UPDATE sends SET state='failed',needs_reconciliation=1,last_error='unknown' WHERE id=?",
        )
        .bind(d.id),
      db
        .prepare("UPDATE drafts SET status='failed' WHERE id=?")
        .bind(d.draft_id),
    ]);

    await post(event(d, type));

    const saved = await state(d);

    expect(saved.needs_reconciliation).toBe(0);

    expect(saved.draft_status).toBe(
      type === "email.suppressed" ? "failed" : type.slice(6),
    );

    expect(saved.attempts).toBe(1);

    await expect(
      new DraftStore(db).revise(
        "agent",
        d.draft_id,
        d.revision_id,
        crypto.randomUUID(),
        { ...email, text: "Changed after outcome" },
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const response = await getApi(`/drafts/${d.draft_id}/status`),
      status = await response.json<{
        next: { action: string };
        poll_after_seconds: number | null;
      }>();

    expect(status.next.action).toBe("done");

    expect(status.poll_after_seconds).toBeNull();
  },
);

it("cannot create a send or an approval for a draft by matching tags", async () => {
  const store = new DraftStore(db),
    d = await store.create("agent", crypto.randomUUID(), email),
    fake = { ...d, id: crypto.randomUUID(), providerId: crypto.randomUUID() };

  await post(event(fake));

  expect(
    (await db
      .prepare("SELECT status FROM drafts WHERE id=?")
      .bind(d.draft_id)
      .first<{ status: string }>())!.status,
  ).toBe("drafted");

  expect(await new SendStore(db).sendIdForRevision(d.revision_id)).toBeNull();

  expect(
    await db
      .prepare("SELECT id FROM reviews WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();
});
