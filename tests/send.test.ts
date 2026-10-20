import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { DraftStore, SendStore } from "../packages/db/src/index";
import { canonicalContent, sha256, LIMITS } from "../packages/core/src/index";
import { processSend, retryAfterMs } from "../apps/send/src/process";
import { resendProvider, type Provider } from "../apps/send/src/resend";
import { handleQueue, recover } from "../apps/send/src/index";

const db = env.DB;

const email = {
  from: "team@example.com",
  to: ["reviewer@example.com"] as [string],
  subject: "Approved",
  html: "<p>Exact content</p>",
  text: "Exact content",
};

let time = Date.now();

const now = () => time;

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  await db.batch([
    db.prepare(
      "INSERT INTO reviewers(id,email,name,password_hash,allowed_recipient_email) VALUES ('human','reviewer@example.com','Human','hash','reviewer@example.com')",
    ),
    db.prepare(
      "INSERT INTO agents (id,reviewer_id,name,key_hash,key_ciphertext,key_nonce,key_encryption_version) VALUES ('agent','human','Agent','key','cipher','nonce',1)",
    ),
  ]);
});

beforeEach(() => {
  time = Date.now();
});

afterEach(() => vi.restoreAllMocks());

async function approved() {
  const store = new DraftStore(db, now),
    d = await store.create("agent", crypto.randomUUID(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await store.decide(
    "human",
    d.draft_id,
    d.revision_id,
    await sha256(canonicalContent(email)),
    "approved",
  );

  const id = (await new SendStore(db, now).sendIdForRevision(d.revision_id))!;

  return { ...d, id };
}

async function row(id: string) {
  return (await db.prepare("SELECT * FROM sends WHERE id=?").bind(id).first<{
    state: string;
    attempts: number;
    needs_reconciliation: number;
    payload: string;
    payload_hash: string;
    idempotency_key: string;
    first_attempt_at: number;
    retry_deadline: number;
    next_attempt_at: number;
    resend_email_id: string | null;
    last_error: string | null;
  }>())!;
}

const run = (id: string, provider: Provider, random = () => 0.5) =>
  processSend(db, id, email.from, provider, { now, random });

const transient: Provider = async () => ({
  error: {
    name: "service_unavailable",
    message: "Unavailable",
    statusCode: 503,
  },
});

it("concurrent and repeated queue deliveries dispatch once and preserve the exact frozen request", async () => {
  const d = await approved(),
    before = await row(d.id),
    provider = vi.fn<Provider>(async (payload, key, signal) => {
      expect(JSON.stringify(payload)).toBe(before.payload);

      expect(key).toBe(`send/${d.revision_id}`);

      expect(signal.aborted).toBe(false);

      return { id: crypto.randomUUID() };
    });

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => run(d.id, provider)),
  );

  expect(outcomes.filter((v) => v.kind === "sent")).toHaveLength(1);

  expect(provider).toHaveBeenCalledTimes(1);

  expect((await row(d.id)).attempts).toBe(1);

  expect((await run(d.id, provider)).kind).toBe("ignored");

  expect(provider).toHaveBeenCalledTimes(1);
});

it("never dispatches an unapproved or unknown intent", async () => {
  const provider = vi.fn<Provider>();

  expect((await run(crypto.randomUUID(), provider)).kind).toBe("ignored");

  expect(provider).not.toHaveBeenCalled();
});

it("retries an accepted-but-lost receipt with identical bytes/key and one simulated physical send", async () => {
  const d = await approved(),
    physical = new Map<string, string>();

  let calls = 0;

  const bytes: string[] = [];

  const provider: Provider = async (payload, key) => {
    calls++;

    bytes.push(JSON.stringify(payload));

    if (!physical.has(key)) physical.set(key, crypto.randomUUID());

    if (calls === 1) throw new Error("connection lost after acceptance");

    return { id: physical.get(key)! };
  };

  expect((await run(d.id, provider)).kind).toBe("retry");

  const first = await row(d.id);

  time = first.next_attempt_at;

  expect((await run(d.id, provider)).kind).toBe("sent");

  const last = await row(d.id);

  expect(last.first_attempt_at).toBe(first.first_attempt_at);

  expect(last.retry_deadline).toBe(first.retry_deadline);

  expect(physical.size).toBe(1);

  expect(new Set(bytes).size).toBe(1);

  expect(last.needs_reconciliation).toBe(0);
});

it("expires crashed reservations, fences stale holders and reuses the approved provider key", async () => {
  const d = await approved(),
    store = new SendStore(db, now),
    first = (await store.claim(d.id))!;

  expect(await store.claim(d.id)).toBeNull();

  time += 60001;

  const second = (await store.claim(d.id))!;

  expect(second.attempts).toBe(2);

  expect(second.idempotency_key).toBe(first.idempotency_key);

  expect(
    await store.finish(first, {
      kind: "accepted",
      providerId: "stale-provider-id",
      unknown: false,
    }),
  ).toBe(false);

  expect(
    await store.finish(second, {
      kind: "accepted",
      providerId: crypto.randomUUID(),
      unknown: false,
    }),
  ).toBe(true);

  const attempts = await db
    .prepare(
      "SELECT outcome FROM send_attempts WHERE send_id=? ORDER BY started_at",
    )
    .bind(d.id)
    .all<{ outcome: string }>();

  expect(attempts.results.map((a) => a.outcome)).toEqual([
    "unknown",
    "accepted",
  ]);

  expect((await row(d.id)).resend_email_id).not.toBe("stale-provider-id");
});

it("does not reserve future retries early", async () => {
  const d = await approved();

  await run(d.id, transient);

  const provider = vi.fn<Provider>();

  expect((await run(d.id, provider)).kind).toBe("ignored");

  expect(provider).not.toHaveBeenCalled();

  time = (await row(d.id)).next_attempt_at;
});

it.each([
  ["rate_limit_exceeded", 429, "retry", 0],
  ["concurrent_idempotent_requests", 409, "retry", 0],
  ["service_unavailable", 503, "retry", 0],
  ["application_error", null, "retry", 0],
  ["validation_error", 422, "failed", 0],
  ["daily_quota_exceeded", 429, "failed", 0],
  ["monthly_quota_exceeded", 429, "failed", 0],
  ["invalid_api_key", 401, "failed", 0],
  ["invalid_idempotent_request", 409, "failed", 1],
] as const)(
  "classifies %s without treating all 429/409 responses as retryable",
  async (name, statusCode, kind, reconciliation) => {
    const d = await approved(),
      result = await run(d.id, async () => ({
        error: { name, message: "Provider error", statusCode },
      }));

    expect(result.kind).toBe(kind);

    expect((await row(d.id)).needs_reconciliation).toBe(reconciliation);
  },
);

it("honors Retry-After seconds and HTTP dates over jitter and rejects malformed/negative headers", async () => {
  const d = await approved(),
    start = time;

  await run(d.id, async () => ({
    error: { name: "rate_limit_exceeded", message: "Wait", statusCode: 429 },
    retryAfter: "120",
  }));

  expect((await row(d.id)).next_attempt_at).toBe(start + 120000);

  expect(
    retryAfterMs(new Date(start + 180000).toUTCString(), start),
  ).toBeGreaterThan(179000);

  expect(retryAfterMs("nonsense", start)).toBeNull();

  expect(retryAfterMs("-1", start)).toBeNull();
});

it("stops at twenty persisted reservations and flags unknown delivery for reconciliation", async () => {
  const d = await approved();

  for (let i = 0; i < 20; i++) {
    const result = await run(d.id, transient, () => 1);

    expect(result.kind).toBe(i === 19 ? "failed" : "retry");

    time = (await row(d.id)).next_attempt_at;
  }

  const saved = await row(d.id);

  expect(saved.attempts).toBe(20);

  expect(saved.needs_reconciliation).toBe(1);

  const provider = vi.fn<Provider>();

  await run(d.id, provider);

  expect(provider).not.toHaveBeenCalled();
});

it("does not mark a pure rate-limit exhaustion as possibly sent", async () => {
  const d = await approved();

  const result = await run(d.id, async () => ({
    error: { name: "rate_limit_exceeded", message: "Wait", statusCode: 429 },
    retryAfter: String(LIMITS.retryWindowSeconds),
  }));

  expect(result.kind).toBe("failed");

  expect((await row(d.id)).needs_reconciliation).toBe(0);
});

it("expires the fixed 23-hour window and preserves prior uncertainty after a definitive failure", async () => {
  const d = await approved();

  await run(d.id, transient);

  const initial = await row(d.id);

  time = initial.next_attempt_at;

  await run(d.id, async () => ({
    error: { name: "validation_error", message: "Rejected", statusCode: 422 },
  }));

  expect((await row(d.id)).needs_reconciliation).toBe(1);

  const another = await approved();

  await run(another.id, transient);

  const deadline = (await row(another.id)).retry_deadline;

  time = deadline - LIMITS.requestTimeoutMs;

  const provider = vi.fn<Provider>();

  await run(another.id, provider);

  expect(provider).not.toHaveBeenCalled();

  expect((await row(another.id)).state).toBe("failed");

  expect((await row(another.id)).retry_deadline).toBe(deadline);
});

it("revalidates sender and recipient policy before any network call", async () => {
  const d = await approved(),
    provider = vi.fn<Provider>();

  await processSend(db, d.id, "changed@example.com", provider, { now });

  expect(provider).not.toHaveBeenCalled();

  expect((await row(d.id)).state).toBe("failed");

  const another = await approved();

  await db
    .prepare(
      "UPDATE reviewers SET allowed_recipient_email='changed@example.com' WHERE id='human'",
    )
    .run();

  try {
    await run(another.id, provider);

    expect(provider).not.toHaveBeenCalled();

    expect((await row(another.id)).state).toBe("failed");
  } finally {
    await db
      .prepare(
        "UPDATE reviewers SET allowed_recipient_email='reviewer@example.com' WHERE id='human'",
      )
      .run();
  }
});

it("does not overwrite delivery evidence with a late transient result", async () => {
  const d = await approved(),
    store = new SendStore(db, now),
    send = (await store.claim(d.id))!;

  await db.batch([
    db
      .prepare(
        "UPDATE sends SET delivery_status='delivered',resend_email_id=? WHERE id=?",
      )
      .bind(crypto.randomUUID(), d.id),
    db
      .prepare("UPDATE drafts SET status='delivered' WHERE id=?")
      .bind(d.draft_id),
  ]);

  await store.finish(send, {
    kind: "retry",
    unknown: true,
    nextAt: time + 5000,
    error: "timeout",
  });

  expect((await row(d.id)).state).toBe("sent");

  expect((await row(d.id)).needs_reconciliation).toBe(0);

  expect(
    (await db
      .prepare("SELECT status FROM drafts WHERE id=?")
      .bind(d.draft_id)
      .first<{ status: string }>())!.status,
  ).toBe("delivered");
});

it("SDK adapter sends the stored JSON bytes and idempotency header with abort signal", async () => {
  const d = await approved(),
    saved = await row(d.id),
    fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-receipt" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const signal = AbortSignal.timeout(10000);

  expect(
    await resendProvider("re_test_placeholder")(
      JSON.parse(saved.payload),
      saved.idempotency_key,
      signal,
    ),
  ).toEqual({ id: "provider-receipt" });

  expect(fetch).toHaveBeenCalledTimes(1);

  const [url, init] = fetch.mock.calls[0]!;

  expect(url).toBe("https://api.resend.com/emails");

  expect(init?.body).toBe(saved.payload);

  const headers = new Headers(init?.headers);

  expect(headers.get("Idempotency-Key")).toBe(saved.idempotency_key);

  expect(headers.get("Authorization")).toBe("Bearer re_test_placeholder");

  expect(init?.signal).toBe(signal);
});

function batch(body: unknown) {
  const ack = vi.fn(),
    retry = vi.fn();

  return {
    ack,
    retry,
    batch: {
      queue: "test",
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body,
          attempts: 1,
          ack,
          retry,
        },
      ],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

function bindings(enabled = "true") {
  return {
    DB: db,
    SEND_ENABLED: enabled,
    SENDER_EMAIL: email.from,
    RESEND_API_KEY: "re_test_placeholder",
    SEND_QUEUE: {
      send: vi.fn<Queue["send"]>(async () => ({
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      })),
    },
  };
}

it("queue acknowledges durable results and malformed/disabled work without dispatch", async () => {
  const d = await approved(),
    b = batch({ send_id: d.id }),
    settings = bindings(),
    provider = vi.fn<Provider>(async () => ({ id: crypto.randomUUID() }));

  await handleQueue(b.batch, settings, provider);

  expect(b.ack).toHaveBeenCalled();

  expect(b.retry).not.toHaveBeenCalled();

  expect(provider).toHaveBeenCalledTimes(1);

  const disabled = batch({ send_id: (await approved()).id });

  await handleQueue(disabled.batch, bindings("false"), provider);

  expect(disabled.ack).toHaveBeenCalled();

  expect(provider).toHaveBeenCalledTimes(1);

  const invalid = batch({ send_id: "invalid", payload: "untrusted" });

  await handleQueue(invalid.batch, settings, provider);

  expect(invalid.ack).toHaveBeenCalled();

  expect(provider).toHaveBeenCalledTimes(1);
});

it("queue publishes retry hints after durable retry state and Cron recovers missing hints", async () => {
  const d = await approved(),
    b = batch({ send_id: d.id }),
    settings = bindings();

  settings.SEND_QUEUE.send.mockRejectedValueOnce(new Error("queue down"));

  await handleQueue(b.batch, settings, transient);

  expect(b.ack).toHaveBeenCalled();

  expect((await row(d.id)).state).toBe("retry_wait");

  expect(settings.SEND_QUEUE.send).toHaveBeenCalled();

  // Cron uses wall time; make this intent due and also recover a crashed lease.
  await db
    .prepare("UPDATE sends SET next_attempt_at=? WHERE id=?")
    .bind(Date.now() - 1, d.id)
    .run();

  const crashed = await approved();

  await new SendStore(db, now).claim(crashed.id);

  await db
    .prepare("UPDATE sends SET lease_until=? WHERE id=?")
    .bind(Date.now() - 1, crashed.id)
    .run();

  const candidates = await new SendStore(db).recoverable();

  expect(candidates.find((candidate) => candidate.id === d.id)).toEqual({
    id: d.id,
  });

  expect(candidates.find((candidate) => candidate.id === crashed.id)).toEqual({
    id: crashed.id,
  });

  settings.SEND_QUEUE.send.mockClear();

  await recover(settings);

  expect(settings.SEND_QUEUE.send).toHaveBeenCalledWith({ send_id: d.id });

  expect(settings.SEND_QUEUE.send).toHaveBeenCalledWith({
    send_id: crashed.id,
  });

  expect(settings.SEND_QUEUE.send.mock.calls.length).toBeLessThanOrEqual(50);

  const paused = bindings("false");

  await recover(paused);

  expect(paused.SEND_QUEUE.send).not.toHaveBeenCalled();
});

it("aborts a timed-out provider request and records an unknown outcome for safe retry", async () => {
  const d = await approved(),
    provider: Provider = async (_payload, _key, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

  expect(
    (await processSend(db, d.id, email.from, provider, { now, timeoutMs: 1 }))
      .kind,
  ).toBe("retry");

  expect(
    (await db
      .prepare("SELECT outcome FROM send_attempts WHERE send_id=?")
      .bind(d.id)
      .first<{ outcome: string }>())!.outcome,
  ).toBe("unknown");
});

it("rejects a corrupted frozen request even when an internal writer inserted valid JSON", async () => {
  const draftStore = new DraftStore(db, now),
    d = await draftStore.create("agent", crypto.randomUUID(), email);

  await draftStore.submit("agent", d.draft_id, d.revision_id);

  const review = crypto.randomUUID(),
    id = crypto.randomUUID();

  await db.batch([
    db
      .prepare(
        "INSERT INTO reviews(id,revision_id,reviewer_id,content_hash,decision,created_at) VALUES (?,?,'human',?,'approved',?)",
      )
      .bind(review, d.revision_id, await sha256(canonicalContent(email)), time),
    db
      .prepare("UPDATE drafts SET status='approved' WHERE id=?")
      .bind(d.draft_id),
    db
      .prepare(
        "INSERT INTO sends(id,revision_id,review_id,idempotency_key,payload,payload_hash,state,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)",
      )
      .bind(
        id,
        d.revision_id,
        review,
        `send/${d.revision_id}`,
        JSON.stringify({ ...email, text: "Unreviewed" }),
        "invalid-hash",
        time,
        time,
        time,
      ),
  ]);

  const provider = vi.fn<Provider>();

  expect((await run(id, provider)).kind).toBe("failed");

  expect(provider).not.toHaveBeenCalled();

  expect((await row(id)).needs_reconciliation).toBe(0);
});

it("retries queue transport on infrastructure/configuration failure without spending a domain attempt", async () => {
  const d = await approved(),
    b = batch({ send_id: d.id }),
    settings = { ...bindings(), RESEND_API_KEY: "" };

  await handleQueue(b.batch, settings);

  expect(b.ack).not.toHaveBeenCalled();

  expect(b.retry).toHaveBeenCalledWith({ delaySeconds: 60 });

  expect((await row(d.id)).attempts).toBe(0);
});

it("bounds Cron recovery to fifty due intents and repairs publication without reserving attempts", async () => {
  // Isolate the recovery candidates from earlier test fixtures in this file.
  await db
    .prepare(
      "UPDATE sends SET next_attempt_at=?,lease_until=? WHERE state IN ('queued','retry_wait','sending')",
    )
    .bind(Date.now() + 86400000, Date.now() + 86400000)
    .run();

  const ids = [];

  for (let i = 0; i < 51; i++) ids.push((await approved()).id);

  const settings = bindings();

  await recover(settings);

  expect(settings.SEND_QUEUE.send).toHaveBeenCalledTimes(50);

  expect(
    new Set(
      settings.SEND_QUEUE.send.mock.calls.map((call) =>
        JSON.stringify(call[0]),
      ),
    ).size,
  ).toBe(50);

  expect((await row(ids[0]!)).attempts).toBe(0);
});

it("closes an expired twentieth crashed reservation without a twenty-first provider call", async () => {
  const d = await approved();

  await db.prepare("UPDATE sends SET attempts=19 WHERE id=?").bind(d.id).run();

  const store = new SendStore(db, now);

  expect((await store.claim(d.id))?.attempts).toBe(20);

  time += 60001;

  const provider = vi.fn<Provider>();

  await run(d.id, provider);

  expect(provider).not.toHaveBeenCalled();

  const saved = await row(d.id);

  expect(saved.state).toBe("failed");

  expect(saved.attempts).toBe(20);

  expect(saved.needs_reconciliation).toBe(1);

  expect(
    (await db
      .prepare("SELECT outcome FROM send_attempts WHERE send_id=?")
      .bind(d.id)
      .first<{ outcome: string }>())!.outcome,
  ).toBe("unknown");
});
