import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { AuthStore } from "../packages/db/src/auth";
import {
  randomToken,
  hashPassword,
  verifyPassword,
  encryptAgentKey,
  decryptAgentKey,
  sha256,
} from "../packages/core/src/index";
import app from "../apps/web/src/index";

const secret = "ab".repeat(32),
  password = "correct horse battery staple";

const db = env.DB;

const account = (email: string) => ({
  email,
  name: "Reviewer",
  recipient: email,
  agentName: "Agent",
  password,
});

let user: { reviewer_id: string; agent_id: string },
  other: { reviewer_id: string; agent_id: string };

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  const store = new AuthStore(db);

  user = await store.provision(account("alice@example.com"), secret);

  other = await store.provision(account("bob@example.com"), secret);
}, 30000);

it("passwords are salted, versioned, verified and bounded", async () => {
  const a = await hashPassword(password),
    b = await hashPassword(password);

  expect(a).not.toBe(b);

  expect(a).not.toContain(password);

  expect(await verifyPassword(password, a)).toBe(true);

  expect(await verifyPassword("wrong", a)).toBe(false);

  expect(await verifyPassword(password, "corrupt")).toBe(false);

  await expect(hashPassword("short")).rejects.toThrow();
});

it("AES-GCM roundtrips with unique nonces and rejects wrong key, tampering and swapped agent identity", async () => {
  const a = await encryptAgentKey("cs_agent_secret", secret, user.agent_id),
    b = await encryptAgentKey("cs_agent_secret", secret, user.agent_id);

  expect(a.nonce).not.toBe(b.nonce);

  expect(a.ciphertext).not.toContain("cs_agent_secret");

  expect(await decryptAgentKey(a, secret, user.agent_id)).toBe(
    "cs_agent_secret",
  );

  await expect(
    decryptAgentKey(a, "cd".repeat(32), user.agent_id),
  ).rejects.toThrow();

  await expect(decryptAgentKey(a, secret, other.agent_id)).rejects.toThrow();

  await expect(
    decryptAgentKey(
      {
        ...a,
        ciphertext:
          (a.ciphertext[0] === "0" ? "1" : "0") + a.ciphertext.slice(1),
      },
      secret,
      user.agent_id,
    ),
  ).rejects.toThrow();
});

it("provisioning is atomic and stores no raw password or key; reveal is reviewer scoped", async () => {
  const store = new AuthStore(db),
    a = await store.reveal(user.reviewer_id, secret),
    b = await store.reveal(other.reviewer_id, secret);

  expect(a.agent_id).toBe(user.agent_id);

  expect(a.key).not.toBe(b.key);

  const row = await db
    .prepare("SELECT * FROM agents WHERE id=?")
    .bind(a.agent_id)
    .first<{ key_hash: string }>();

  expect(row!.key_hash).toBe(await sha256(a.key));

  expect(JSON.stringify(row)).not.toContain(a.key);

  await expect(
    store.provision(account("alice@example.com"), secret),
  ).rejects.toThrow();

  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM agents")
      .first<{ n: number }>())!.n,
  ).toBe(2);

  await expect(store.reveal("unknown", secret)).rejects.toMatchObject({
    code: "not_found",
  });
});

it("sessions expire at exactly 24 hours and store only hashed tokens", async () => {
  let now = 1000;

  const store = new AuthStore(db, () => now);

  const login = await store.login("alice@example.com", password, "expiry-ip");

  const session = await store.session(login.token);

  expect(session!.expires_at).toBe(86401000);

  expect(JSON.stringify(session)).not.toContain(login.token);

  now = 86400999;

  expect(await store.session(login.token)).not.toBeNull();

  now++;

  expect(await store.session(login.token)).toBeNull();
});

it("login rotates sessions, logout revokes and reset invalidates all sessions", async () => {
  const store = new AuthStore(db),
    one = await store.login("bob@example.com", password, "rotation-ip");

  const two = await store.login(
    "bob@example.com",
    password,
    "rotation-ip",
    one.token,
  );

  expect(await store.session(one.token)).toBeNull();

  expect(await store.session(two.token)).not.toBeNull();

  await store.logout(two.token);

  expect(await store.session(two.token)).toBeNull();

  const three = await store.login("bob@example.com", password, "reset-ip");

  await store.resetPassword(other.reviewer_id, "new password for reviewer");

  expect(await store.session(three.token)).toBeNull();

  await expect(
    store.login("bob@example.com", password, "reset-ip"),
  ).rejects.toMatchObject({ code: "unauthorized" });

  expect(
    await store.login(
      "bob@example.com",
      "new password for reviewer",
      "reset-ip",
    ),
  ).toHaveProperty("token");
});

it("account throttles apply across store instances and recover without permanent lockout", async () => {
  let now = 9000000;

  const email = "missing@example.com";

  for (let n = 0; n < 5; n++)
    await expect(
      new AuthStore(db, () => now).login(email, "wrong", "account-ip"),
    ).rejects.toMatchObject({ code: "unauthorized" });

  await expect(
    new AuthStore(db, () => now).login(email, "wrong", "different-ip"),
  ).rejects.toMatchObject({ code: "rate_limited" });

  now += 900000;

  await expect(
    new AuthStore(db, () => now).login(email, "wrong", "different-ip"),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

const bindings = { ...env, AGENT_KEY_ENCRYPTION_KEY: secret };

async function loginBrowser() {
  const get = await app.request("https://service.test/login", {}, bindings);

  const html = await get.text(),
    csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;

  const cookie = `__Host-cs_login=${csrf}`;

  const response = await app.request(
    "https://service.test/login",
    {
      method: "POST",
      headers: {
        Origin: "https://service.test",
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ email: "alice@example.com", password, csrf }),
    },
    bindings,
  );

  const set = response.headers.get("set-cookie")!;

  const token = /__Host-cs_session=([^;,]+)/.exec(set)![1]!,
    action = /__Host-cs_csrf=([^;,]+)/.exec(set)![1]!;

  return {
    response,
    csrf: action,
    cookie: `__Host-cs_session=${token}; __Host-cs_csrf=${action}`,
  };
}

it("browser login sets secure cookies; masked Connect reveals only with session and CSRF", async () => {
  const login = await loginBrowser();

  expect(login.response.status).toBe(303);

  const cookies = login.response.headers.get("set-cookie")!;

  expect(cookies).toContain("HttpOnly");

  expect(cookies).toContain("Secure");

  expect(cookies).toContain("SameSite=Strict");

  const page = await app.request(
    "https://service.test/connect",
    { headers: { Cookie: login.cookie } },
    bindings,
  );

  expect(await page.text()).not.toContain("cs_agent_");

  expect(page.headers.get("Cache-Control")).toBe("no-store");

  const reveal = () =>
    app.request(
      "https://service.test/connect/reveal",
      {
        method: "POST",
        headers: {
          Cookie: login.cookie,
          Origin: "https://service.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: login.csrf }),
      },
      bindings,
    );

  const response = await reveal();

  expect(response.status).toBe(200);

  expect(response.headers.get("Cache-Control")).toBe("no-store");

  const body = await response.text();

  const key = (await new AuthStore(db).reveal(user.reviewer_id, secret)).key;

  expect(body).toContain(key);

  const prompt =
    /<textarea[^>]*id="setup-prompt"[^>]*>([\s\S]*?)<\/textarea>/.exec(
      body,
    )![1]!;
  const header = /^Authorization: Bearer (\S+)$/m.exec(prompt)![1]!;

  expect(header).toBe(key);

  const identity = await app.request(
    "https://service.test/v1/me",
    { headers: { Authorization: `Bearer ${header}` } },
    bindings,
  );

  expect(identity.status).toBe(200);

  expect(body).not.toContain(
    (await new AuthStore(db).reveal(other.reviewer_id, secret)).key,
  );

  const forbidden = await app.request(
    "https://service.test/connect/reveal",
    {
      method: "POST",
      headers: {
        Cookie: login.cookie,
        Origin: "https://evil.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: login.csrf }),
    },
    bindings,
  );

  expect(forbidden.status).toBe(403);
});

it("agent bearer credentials cannot enter reviewer routes, missing session never reveals", async () => {
  const denied = await app.request(
    "https://service.test/connect/reveal",
    { method: "POST", headers: { Authorization: "Bearer cs_agent_anything" } },
    bindings,
  );

  expect(denied.status).toBe(403);

  const missing = await app.request(
    "https://service.test/connect/reveal",
    { method: "POST" },
    bindings,
  );

  expect(missing.status).toBe(303);

  expect(await missing.text()).not.toContain("cs_agent_");

  const csrf = await app.request(
    "https://service.test/login",
    { method: "POST", headers: { Origin: "https://evil.test" }, body: "" },
    bindings,
  );

  expect(csrf.status).toBe(403);
});

it("IP throttling is independent of account and concurrent reservations are bounded", async () => {
  const now = 45000000,
    scope = await sha256("ip:blocked-ip");

  await db
    .prepare("INSERT INTO login_throttles VALUES(?,30,?)")
    .bind(scope, now)
    .run();

  await expect(
    new AuthStore(db, () => now).login(
      "unused@example.com",
      "wrong",
      "blocked-ip",
    ),
  ).rejects.toMatchObject({ code: "rate_limited" });

  const reservations = await Promise.allSettled(
    Array.from({ length: 7 }, (_, n) =>
      new AuthStore(db, () => now).login(
        "concurrent@example.com",
        "wrong",
        `concurrent-${n}`,
      ),
    ),
  );

  expect(
    reservations.filter(
      (r) => r.status === "rejected" && r.reason.code === "rate_limited",
    ),
  ).toHaveLength(2);
});

it("reset racing login never leaves a valid session authenticated with the old password", async () => {
  const store = new AuthStore(db),
    user = await store.provision(account("race@example.com"), secret);

  const results = await Promise.allSettled([
    store.login("race@example.com", password, "race-ip"),
    store.resetPassword(user.reviewer_id, "new race account password"),
  ]);

  const login = results[0];

  if (login.status === "fulfilled")
    expect(await store.session(login.value.token)).toBeNull();

  expect(results[1].status).toBe("fulfilled");
});

it("HTTP logout validates CSRF and expired sessions cannot reveal keys", async () => {
  const login = await loginBrowser();

  const invalid = await app.request(
    "https://service.test/logout",
    {
      method: "POST",
      headers: {
        Cookie: login.cookie,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "csrf=wrong",
    },
    bindings,
  );

  expect(invalid.status).toBe(403);

  const token = /__Host-cs_session=([^;]+)/.exec(login.cookie)![1]!;

  expect(await new AuthStore(db).session(token)).not.toBeNull();

  const logout = await app.request(
    "https://service.test/logout",
    {
      method: "POST",
      headers: {
        Cookie: login.cookie,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: login.csrf }),
    },
    bindings,
  );

  expect(logout.status).toBe(303);

  expect(await new AuthStore(db).session(token)).toBeNull();

  const old = await new AuthStore(db, () => 0).login(
    "alice@example.com",
    password,
    "old-session-ip",
  );

  const expired = await app.request(
    "https://service.test/connect/reveal",
    {
      method: "POST",
      headers: {
        Cookie: `__Host-cs_session=${old.token}`,
        Origin: "https://service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: old.csrf }),
    },
    bindings,
  );

  expect(expired.status).toBe(303);
});

it("HTTP login failures are generic for unknown emails and wrong passwords", async () => {
  async function attempt(email: string) {
    const get = await app.request("https://service.test/login", {}, bindings),
      html = await get.text();

    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;

    return app.request(
      "https://service.test/login",
      {
        method: "POST",
        headers: {
          Cookie: `__Host-cs_login=${csrf}`,
          Origin: "https://service.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email,
          password: "incorrect password",
          csrf,
        }),
      },
      bindings,
    );
  }

  const a = await attempt("unknown-http@example.com"),
    b = await attempt("alice@example.com");

  expect(a.status).toBe(401);

  expect(b.status).toBe(401);

  expect(await a.text()).toBe(await b.text());
});

it("reviewer middleware does not reject agent API requests or apply its small form limit globally", async () => {
  const response = await app.request(
    "https://service.test/v1/not-built",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer cs_agent_anything",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "x".repeat(5000) }),
    },
    bindings,
  );

  expect(response.status).toBe(401);
});

it("invalid login forms offer recovery without creating a session", async () => {
  for (const scenario of [
    { origin: "https://service.test", cookie: "" },
    { origin: "https://service.test", cookie: "__Host-cs_login=other" },
    { origin: "https://attacker.test", cookie: "__Host-cs_login=token" },
  ]) {
    const response = await app.request(
      "https://service.test/login",
      {
        method: "POST",
        headers: {
          Origin: scenario.origin,
          Cookie: scenario.cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: "token",
          email: "alice@example.com",
          password,
        }),
      },
      bindings,
    );

    expect(response.status).toBe(403);

    expect(response.headers.get("content-type")).toContain("text/html");

    expect(response.headers.get("set-cookie")).toBeNull();

    expect(await response.text()).toContain('href="/login"');
  }
});
