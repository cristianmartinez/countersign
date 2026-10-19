import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { DraftStore } from "../packages/db/src/drafts";
import {
  sha256,
  canonicalContent,
  type EmailContent,
} from "../packages/core/src/content";

const db = env.DB;

const store = new DraftStore(db);

const email: EmailContent = {
  from: "team@example.com",
  to: ["reviewer@example.com"],
  subject: "Hello",
  text: "Original text",
};

const changed = { ...email, text: "Revised text" };

const key = () => crypto.randomUUID();

async function count(table: string, draft?: string) {
  // Table names are fixed test-only call sites, not user input.
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM ${table}${draft ? " WHERE draft_id=?" : ""}`,
    )
    .bind(...(draft ? [draft] : []))
    .first<{ n: number }>();

  return row!.n;
}

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  await db.batch([
    db.prepare(
      "INSERT INTO reviewers(id,email,name,password_hash,allowed_recipient_email) VALUES ('human','reviewer@example.com','Reviewer','hash','reviewer@example.com')",
    ),
    db.prepare(
      "INSERT INTO reviewers(id,email,name,password_hash,allowed_recipient_email) VALUES ('other','other@example.com','Other','hash','other@example.com')",
    ),
    db.prepare(
      "INSERT INTO agents (id,reviewer_id,name,key_hash,key_ciphertext,key_nonce,key_encryption_version) VALUES ('agent','human','Agent','key-hash','cipher','nonce',1)",
    ),
    db.prepare(
      "INSERT INTO agents (id,reviewer_id,name,key_hash,key_ciphertext,key_nonce,key_encryption_version) VALUES ('other-agent','other','Other','other-key','cipher','nonce',1)",
    ),
  ]);
});

it("concurrent matching creates replay one original result", async () => {
  const k = key();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.create("agent", k, email)),
  );

  expect(new Set(results.map((r) => r.draft_id)).size).toBe(1);

  expect(await count("revisions", results[0]!.draft_id)).toBe(1);

  await expect(store.create("agent", k, changed)).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
});

it("different agents can reuse a key without sharing results", async () => {
  const k = key();

  const a = await store.create("agent", k, email),
    b = await store.create("other-agent", k, email);

  expect(a.draft_id).not.toBe(b.draft_id);
});

it("two revisions on the same base have one winner and no orphan receipt", async () => {
  const d = await store.create("agent", key(), email);

  const results = await Promise.allSettled([
    store.revise("agent", d.draft_id, d.revision_id, key(), changed),
    store.revise("agent", d.draft_id, d.revision_id, key(), email),
  ]);

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "revision_conflict" },
  });

  expect(await count("revisions", d.draft_id)).toBe(2);

  const receipts = await db
    .prepare(
      "SELECT response FROM agent_idempotency WHERE operation='revise' AND target=?",
    )
    .bind(d.draft_id)
    .all<{ response: string | null }>();

  expect(receipts.results).toHaveLength(1);

  expect(receipts.results[0]!.response).not.toBeNull();
});

it("matching revision retries return the original response after later revisions", async () => {
  const d = await store.create("agent", key(), email),
    k = key();

  const next = await store.revise(
    "agent",
    d.draft_id,
    d.revision_id,
    k,
    changed,
  );

  await store.revise("agent", d.draft_id, next.revision_id, key(), email);

  expect(
    await store.revise("agent", d.draft_id, d.revision_id, k, changed),
  ).toEqual(next);
});

it("concurrent matching revision requests produce one revision", async () => {
  const d = await store.create("agent", key(), email),
    k = key();

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.revise("agent", d.draft_id, d.revision_id, k, changed),
    ),
  );

  expect(new Set(results.map((r) => r.revision_id)).size).toBe(1);

  expect(await count("revisions", d.draft_id)).toBe(2);
});

it("concurrent approvals create exactly one review and one frozen outbox row", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  const hash = await sha256(canonicalContent(email));

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.decide("human", d.draft_id, d.revision_id, hash, "approved"),
    ),
  );

  expect(new Set(results.map((r) => r.id)).size).toBe(1);

  const sends = await db
    .prepare("SELECT * FROM sends WHERE revision_id=?")
    .bind(d.revision_id)
    .all<{ payload: string; payload_hash: string; idempotency_key: string }>();

  expect(sends.results).toHaveLength(1);

  const send = sends.results[0]!;

  expect(JSON.parse(send.payload)).toMatchObject(email);

  expect(send.payload_hash).toBe(await sha256(send.payload));

  expect(send.idempotency_key).toBe(`send/${d.revision_id}`);

  await expect(
    store.revise("agent", d.draft_id, d.revision_id, key(), changed),
  ).rejects.toMatchObject({ code: "invalid_state" });
});

it("approval racing revision cannot approve content different from the current revision", async () => {
  for (let n = 0; n < 8; n++) {
    const d = await store.create("agent", key(), email);

    await store.submit("agent", d.draft_id, d.revision_id);

    const hash = await sha256(canonicalContent(email));

    const results = await Promise.allSettled([
      store.revise("agent", d.draft_id, d.revision_id, key(), changed),
      store.decide("human", d.draft_id, d.revision_id, hash, "approved"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const current = await db
      .prepare("SELECT * FROM drafts WHERE id=?")
      .bind(d.draft_id)
      .first<{ status: string; current_revision_id: string }>();

    const sends = await db
      .prepare("SELECT revision_id FROM sends WHERE revision_id=?")
      .bind(d.revision_id)
      .all();

    if (current!.status === "approved") {
      expect(current!.current_revision_id).toBe(d.revision_id);

      expect(sends.results).toHaveLength(1);
    } else {
      expect(current!.status).toBe("drafted");

      expect(sends.results).toHaveLength(0);
    }
  }
});

it("stale hash, wrong reviewer and cross-agent mutation cannot create review/send rows", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await expect(
    store.decide("human", d.draft_id, d.revision_id, "wrong", "approved"),
  ).rejects.toMatchObject({ code: "revision_changed" });

  await expect(
    store.decide(
      "other",
      d.draft_id,
      d.revision_id,
      await sha256(canonicalContent(email)),
      "approved",
    ),
  ).rejects.toMatchObject({ code: "not_found" });

  await expect(
    store.revise("other-agent", d.draft_id, d.revision_id, key(), changed),
  ).rejects.toMatchObject({ code: "not_found" });

  expect(
    await db
      .prepare("SELECT id FROM reviews WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();

  expect(
    await db
      .prepare("SELECT id FROM sends WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();
});

it("approval versus rejection has one decision and rejection cannot be reopened by submit", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  const hash = await sha256(canonicalContent(email));

  const results = await Promise.allSettled([
    store.decide(
      "human",
      d.draft_id,
      d.revision_id,
      hash,
      "rejected",
      "Shorter",
    ),
    store.decide("human", d.draft_id, d.revision_id, hash, "approved"),
  ]);

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

  const r = await db
    .prepare("SELECT decision FROM reviews WHERE revision_id=?")
    .bind(d.revision_id)
    .first<{ decision: string }>();

  expect((await store.submit("agent", d.draft_id, d.revision_id)).status).toBe(
    r!.decision,
  );
});

it("a failed batch rolls back a draft and its idempotency claim", async () => {
  const k = key();

  await expect(
    store.create("agent", k, { ...email, subject: "" }),
  ).rejects.toThrow();

  expect(
    await db
      .prepare("SELECT * FROM agent_idempotency WHERE key=?")
      .bind(k)
      .first(),
  ).toBeNull();

  expect(await store.create("agent", k, email)).toMatchObject({
    status: "drafted",
  });
});

it("database forbids revision mutation and unapproved send insertion", async () => {
  const d = await store.create("agent", key(), email);

  await expect(
    db
      .prepare("UPDATE revisions SET subject=? WHERE id=?")
      .bind("tampered", d.revision_id)
      .run(),
  ).rejects.toThrow("immutable_revision");

  await expect(
    db
      .prepare(
        "INSERT INTO sends(id,revision_id,review_id,idempotency_key,payload,payload_hash,state,next_attempt_at,created_at,updated_at) VALUES('bad',?,'missing','bad','{}','hash','queued',0,0,0)",
      )
      .bind(d.revision_id)
      .run(),
  ).rejects.toThrow();
});

it("stale review after an edit creates no decision or send, and edit cancels submission", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  const next = await store.revise(
    "agent",
    d.draft_id,
    d.revision_id,
    key(),
    changed,
  );

  await expect(
    store.decide(
      "human",
      d.draft_id,
      d.revision_id,
      await sha256(canonicalContent(email)),
      "approved",
    ),
  ).rejects.toMatchObject({ code: "revision_changed" });

  expect(
    await db
      .prepare("SELECT id FROM reviews WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();

  expect(
    (await db
      .prepare("SELECT status FROM drafts WHERE id=?")
      .bind(d.draft_id)
      .first<{ status: string }>())!.status,
  ).toBe("drafted");

  expect(next.revision_id).not.toBe(d.revision_id);
});

it("a rejected revision stays rejected on submit; a new revision can be approved", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await store.decide(
    "human",
    d.draft_id,
    d.revision_id,
    await sha256(canonicalContent(email)),
    "rejected",
    "Shorter",
  );

  expect((await store.submit("agent", d.draft_id, d.revision_id)).status).toBe(
    "rejected",
  );

  const next = await store.revise(
    "agent",
    d.draft_id,
    d.revision_id,
    key(),
    changed,
  );

  await store.submit("agent", d.draft_id, next.revision_id);

  await store.decide(
    "human",
    d.draft_id,
    next.revision_id,
    await sha256(canonicalContent(changed)),
    "approved",
  );

  expect(
    await db
      .prepare("SELECT id FROM sends WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();

  expect(
    await db
      .prepare("SELECT id FROM sends WHERE revision_id=?")
      .bind(next.revision_id)
      .first(),
  ).not.toBeNull();
});

it("recipient policy is rechecked at approval without orphan writes", async () => {
  const d = await store.create("agent", key(), {
    ...email,
    to: ["forbidden@example.com"],
  });

  await store.submit("agent", d.draft_id, d.revision_id);

  await expect(
    store.decide(
      "human",
      d.draft_id,
      d.revision_id,
      await sha256(
        canonicalContent({ ...email, to: ["forbidden@example.com"] }),
      ),
      "approved",
    ),
  ).rejects.toMatchObject({ code: "validation_error" });

  expect(
    await db
      .prepare("SELECT id FROM reviews WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();

  expect(
    await db
      .prepare("SELECT id FROM sends WHERE revision_id=?")
      .bind(d.revision_id)
      .first(),
  ).toBeNull();
});

it("idempotency expiration is fixed and scoped by operation and target", async () => {
  let now = 1000;

  const clocked = new DraftStore(db, () => now);

  const k = key();

  const d = await clocked.create("agent", k, email);

  now += 100;

  expect(await clocked.create("agent", k, email)).toEqual(d);

  const receipt = await db
    .prepare(
      "SELECT expires_at FROM agent_idempotency WHERE agent_id='agent' AND operation='create' AND key=?",
    )
    .bind(k)
    .first<{ expires_at: number }>();

  expect(receipt!.expires_at).toBe(86_401_000);

  const revised = await clocked.revise(
    "agent",
    d.draft_id,
    d.revision_id,
    k,
    changed,
  );

  const other = await clocked.create("agent", key(), email);

  await clocked.revise("agent", other.draft_id, other.revision_id, k, changed);

  expect(revised.revision_id).not.toBe(d.revision_id);

  now = 86_401_001;

  expect((await clocked.create("agent", k, email)).draft_id).not.toBe(
    d.draft_id,
  );
});

it("a failing send insert rolls back the entire approval batch", async () => {
  const d = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await db.exec(
    "CREATE TRIGGER test_send_failure BEFORE INSERT ON sends BEGIN SELECT RAISE(ABORT,'injected_failure'); END;",
  );

  try {
    await expect(
      store.decide(
        "human",
        d.draft_id,
        d.revision_id,
        await sha256(canonicalContent(email)),
        "approved",
      ),
    ).rejects.toThrow("injected_failure");

    expect(
      await db
        .prepare("SELECT id FROM reviews WHERE revision_id=?")
        .bind(d.revision_id)
        .first(),
    ).toBeNull();

    expect(
      (await db
        .prepare("SELECT status FROM drafts WHERE id=?")
        .bind(d.draft_id)
        .first<{ status: string }>())!.status,
    ).toBe("in_review");
  } finally {
    await db.exec("DROP TRIGGER test_send_failure;");
  }

  await store.decide(
    "human",
    d.draft_id,
    d.revision_id,
    await sha256(canonicalContent(email)),
    "approved",
  );
});

it("the frozen send cannot be changed and current revision cannot reference another draft", async () => {
  const d = await store.create("agent", key(), email),
    other = await store.create("agent", key(), email);

  await store.submit("agent", d.draft_id, d.revision_id);

  await store.decide(
    "human",
    d.draft_id,
    d.revision_id,
    await sha256(canonicalContent(email)),
    "approved",
  );

  await expect(
    db
      .prepare("UPDATE sends SET payload='{}' WHERE revision_id=?")
      .bind(d.revision_id)
      .run(),
  ).rejects.toThrow("immutable_send_payload");

  await expect(
    db.batch([
      db
        .prepare("UPDATE drafts SET current_revision_id=? WHERE id=?")
        .bind(other.revision_id, d.draft_id),
    ]),
  ).rejects.toThrow();
});
