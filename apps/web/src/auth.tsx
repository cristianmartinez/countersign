/** @jsxImportSource hono/jsx */
import { UiButton, UiHeader, UiCopyPrompt, UiLoginCard } from "./ui";
import { discoveryLinks } from "./onboarding";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { AuthStore, AuthError, type Session } from "@countersign/db";
import { randomToken, sha256, LIMITS } from "@countersign/core";

const COOKIE = "__Host-cs_session",
  CSRF = "__Host-cs_csrf",
  LOGIN = "__Host-cs_login";

const options = {
  httpOnly: true,
  secure: true,
  sameSite: "Strict" as const,
  path: "/",
};

const auth = new Hono<{ Bindings: Env; Variables: { session: Session } }>();

const reviewerPath = (path: string) =>
  path === "/login" ||
  path === "/logout" ||
  path === "/connect" ||
  path.startsWith("/connect/");

auth.use("*", async (c, next) => {
  if (!reviewerPath(c.req.path)) return next();

  c.header("Cache-Control", "no-store");

  c.header("Referrer-Policy", "same-origin");

  c.header("X-Content-Type-Options", "nosniff");

  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );

  if (c.req.header("Authorization"))
    return c.json(
      {
        error: {
          code: "agent_key_not_allowed",
          message: "Reviewer session required",
        },
      },
      403,
    );

  await next();
});

const formLimit = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
});

auth.use("*", (c, next) =>
  reviewerPath(c.req.path) ? formLimit(c, next) : next(),
);

auth.onError((error, c) => {
  if (error instanceof AuthError) {
    if (error.code === "rate_limited") {
      c.header("Retry-After", String(error.retryAfter));

      return c.json(
        { error: { code: error.code, message: "Try again later" } },
        429,
      );
    }

    return c.json(
      {
        error: {
          code: error.code,
          message: "Unable to authenticate or access this resource",
        },
      },
      error.code === "not_found" ? 404 : 401,
    );
  }

  // Do not log exception objects that could contain credential-bearing parameters.
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Authentication is temporarily unavailable",
      },
    },
    500,
  );
});

function Page({
  children,
  login = false,
  docsUrl,
}: {
  children: import("hono/jsx").Child;
  login?: boolean;
  docsUrl: string;
}) {
  return (
    <html lang="en" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Countersign</title>
        <link rel="stylesheet" href="/assets/ui.css" />
      </head>
      <body class={login ? "login-page" : "auth-page"}>
        <UiHeader docsUrl={docsUrl} />
        <main>{children}</main>
      </body>
    </html>
  );
}

auth.get("/login", (c) => {
  const token = randomToken();

  setCookie(c, LOGIN, token, { ...options, maxAge: 600 });

  return c.html(
    <Page login docsUrl={c.env.DOCS_URL}>
      <div id="login-card-root">
        <UiLoginCard csrf={token} />
      </div>
      <script type="module" src="/assets/ui-client.js"></script>
    </Page>,
  );
});

function originMatches(request: Request) {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

auth.post("/login", async (c) => {
  const invalidForm = () =>
    c.html(
      <Page docsUrl={c.env.DOCS_URL}>
        <h1>Sign-in form is no longer valid</h1>
        <p>
          The form may have expired or been replaced in another tab. Open a
          fresh form and try again.
        </p>
        <a href="/login">Return to sign in</a>
      </Page>,
      403,
    );

  if (!originMatches(c.req.raw)) return invalidForm();

  const form = await c.req.parseBody();

  const loginToken = getCookie(c, LOGIN);

  if (
    typeof form.csrf !== "string" ||
    !loginToken ||
    (await sha256(form.csrf)) !== (await sha256(loginToken))
  )
    return invalidForm();

  if (typeof form.email !== "string" || typeof form.password !== "string")
    return c.json({ error: { code: "bad_request" } }, 400);

  const result = await new AuthStore(c.env.DB).login(
    form.email,
    form.password,
    c.req.header("CF-Connecting-IP") ?? "local",
    getCookie(c, COOKIE),
  );

  setCookie(c, COOKIE, result.token, {
    ...options,
    maxAge: LIMITS.sessionSeconds,
  });

  setCookie(c, CSRF, result.csrf, {
    ...options,
    maxAge: LIMITS.sessionSeconds,
  });

  deleteCookie(c, LOGIN, options);

  return c.redirect("/review", 303);
});

auth.use("/connect*", async (c, next) => {
  const session = await new AuthStore(c.env.DB).session(getCookie(c, COOKIE));

  if (!session) return c.redirect("/login", 303);

  c.set("session", session);

  await next();
});

auth.use("/logout", async (c, next) => {
  const session = await new AuthStore(c.env.DB).session(getCookie(c, COOKIE));

  if (!session) return c.json({ error: { code: "unauthorized" } }, 401);

  c.set("session", session);

  await next();
});

async function csrfValid(request: Request, token: unknown, session: Session) {
  return (
    originMatches(request) &&
    typeof token === "string" &&
    (await sha256(token)) === session.csrf_hash
  );
}

auth.get("/connect", (c) =>
  c.html(
    <Page docsUrl={c.env.DOCS_URL}>
      <h1>Connect your agent</h1>
      <p>
        Copy the setup prompt into your agent. It will prepare an email and
        return a link for your review.
      </p>
      <details>
        <summary>API and agent reference</summary>
        <nav>
          {discoveryLinks.map(([name, path]) => (
            <p>
              <a href={path}>{name}</a>
            </p>
          ))}
        </nav>
      </details>
      <p>
        <a href="/review">View emails</a>
      </p>
      <p>
        Your agent key is hidden. Reveal it to copy a complete setup prompt.
        Sharing the prompt shares the key with your chosen agent tool.
      </p>
      <p>
        {c.env.SEND_ENABLED === "true"
          ? "Draft APIs, human review and automatic sending are available."
          : "Draft APIs and human review are available. Sending is paused."}
      </p>
      <form method="post" action="/connect/reveal">
        <input type="hidden" name="csrf" value={getCookie(c, CSRF) ?? ""} />
        <UiButton>Reveal agent key and setup prompt</UiButton>
      </form>
      <form method="post" action="/logout">
        <input type="hidden" name="csrf" value={getCookie(c, CSRF) ?? ""} />
        <UiButton variant="outline">Sign out</UiButton>
      </form>
    </Page>,
  ),
);

auth.post("/connect/reveal", async (c) => {
  const form = await c.req.parseBody();

  if (!(await csrfValid(c.req.raw, form.csrf, c.get("session"))))
    return c.json({ error: { code: "csrf_invalid" } }, 403);

  const value = await new AuthStore(c.env.DB).reveal(
    c.get("session").reviewer_id,
    c.env.AGENT_KEY_ENCRYPTION_KEY,
  );

  const url = new URL(c.req.url).origin;

  const prompt = `Use Countersign at ${url}. Use curl or send User-Agent: CountersignAgent/1.0 with your HTTP client, including discovery requests. Read ${url}/SKILL.md, ${url}/onboarding.md and ${url}/openapi.json. Authenticate with this exact header:
Authorization: Bearer ${value.key}

First call GET /v1/me to discover the fixed sender and allowed recipients. Create and submit the requested email for human review. If trying the walkthrough, use delivered@resend.dev; do not guess a real recipient. Return the review link and current status. Follow next.action and poll_after_seconds; wait at most two minutes, then return the link/status. Never approve, send directly, or create replacement emails automatically. Never claim delivery until the service confirms it.`;

  return c.html(
    <Page docsUrl={c.env.DOCS_URL}>
      <h1>Connect your agent</h1>
      <nav>
        {discoveryLinks.map(([name, path]) => (
          <p>
            <a href={path}>{name}</a>
          </p>
        ))}
      </nav>
      <p>
        <a href="/review">View emails</a>
      </p>
      <p>
        {c.env.SEND_ENABLED === "true"
          ? "Approved emails are sent automatically."
          : "Development: sending is paused."}{" "}
        Keep this key private.
      </p>
      <label>
        Agent key <input readonly value={value.key} />
      </label>
      <label for="setup-prompt">Setup prompt</label>
      <textarea id="setup-prompt" readonly rows={8} cols={80}>
        {prompt}
      </textarea>
      <div id="copy-prompt-root">
        <UiCopyPrompt />
      </div>
      <a href="/connect">Hide key</a>
      <script type="module" src="/assets/ui-client.js"></script>
    </Page>,
  );
});

auth.post("/logout", async (c) => {
  const form = await c.req.parseBody();

  if (!(await csrfValid(c.req.raw, form.csrf, c.get("session"))))
    return c.json({ error: { code: "csrf_invalid" } }, 403);

  const token = getCookie(c, COOKIE);

  if (token) await new AuthStore(c.env.DB).logout(token);

  deleteCookie(c, COOKIE, options);

  deleteCookie(c, CSRF, options);

  return c.redirect("/login", 303);
});

export { auth, csrfValid, COOKIE as SESSION_COOKIE, CSRF as CSRF_COOKIE };
