import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import app from "../apps/web/src/index";
import { api } from "../apps/web/src/api";
import { apiSchemas, agentRoutes } from "../apps/web/src/api-contract";
import { AuthStore } from "../packages/db/src/index";
import { processSend } from "../apps/send/src/process";
import { documentedClient } from "./helpers/documented-client";
import example from "../examples/react-email/draft.json";

const origin = "https://service.test",
  db = env.DB,
  secret = "de".repeat(32),
  signingKey = Buffer.alloc(32, 41),
  bindings = {
    ...env,
    AGENT_KEY_ENCRYPTION_KEY: secret,
    RESEND_WEBHOOK_SECRET: "whsec_" + signingKey.toString("base64"),
    SENDER_EMAIL: "team@example.com",
    SEND_ENABLED: "false",
    SEND_QUEUE: { send: vi.fn(async () => {}) },
  };

let reviewer: string, csrf: string, cookie: string, prompt: string, key: string;

const publicGet = (path: string) => app.request(origin + path, {}, bindings);

function field(html: string, name: string) {
  const value = html.match(
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`),
  )?.[1];

  if (!value) throw new Error(`Form missing ${name}`);

  return value;
}

beforeAll(async () => {
  await applyD1Migrations(db, env.MIGRATIONS);

  const auth = new AuthStore(db),
    account = await auth.provision(
      {
        email: "fresh@example.com",
        recipient: "fresh@example.com",
        name: "Fresh reviewer",
        password: "fresh reviewer password",
        agentName: "Fresh agent",
      },
      secret,
    );

  reviewer = account.reviewer_id;

  const session = await auth.login(
    "fresh@example.com",
    "fresh reviewer password",
    "onboarding-ip",
  );

  csrf = session.csrf;

  cookie = `__Host-cs_session=${session.token}; __Host-cs_csrf=${csrf}`;

  const response = await app.request(
    origin + "/connect/reveal",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf }),
    },
    bindings,
  );

  expect(response.status).toBe(200);

  const html = await response.text();

  prompt =
    html.match(
      /<textarea[^>]*id="setup-prompt"[^>]*>([\s\S]*?)<\/textarea>/,
    )?.[1] ?? "";

  key = prompt.match(/Bearer (cs_agent_[a-f0-9]{64})/)?.[1] ?? "";

  expect(key).toMatch(/^cs_agent_[a-f0-9]{64}$/);
});

async function humanDecision(
  reviewUrl: string,
  decision: "approve" | "reject",
  reason = "",
) {
  const html = await (
    await app.request(reviewUrl, { headers: { Cookie: cookie } }, bindings)
  ).text();

  const form = {
    csrf,
    revision_id: field(html, "revision_id"),
    content_hash: field(html, "content_hash"),
    ...(reason ? { reason } : {}),
  };

  const response = await app.request(
    reviewUrl + "/" + decision,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    },
    bindings,
  );

  expect(response.status).toBe(303);
}

it("public docs are discoverable without credentials and do not reveal account material", async () => {
  for (const path of [
    "/openapi.json",
    "/onboarding.md",
    "/llms.txt",
    "/SKILL.md",
    "/examples/react-email.json",
  ]) {
    const response = await publicGet(path);

    expect(response.status).toBe(200);

    const body = await response.text();

    expect(body).not.toContain(key);

    expect(body).not.toContain(secret);

    expect(body).not.toContain("fresh@example.com");
  }

  const connect = await app.request(
      origin + "/connect",
      { headers: { Cookie: cookie } },
      bindings,
    ),
    html = await connect.text();

  expect(html).not.toContain(key);

  for (const path of [
    "/openapi.json",
    "/onboarding.md",
    "/examples/react-email.json",
  ])
    expect(html).toContain(path);

  expect(prompt).toContain(origin + "/SKILL.md");

  expect(prompt).toContain(origin + "/openapi.json");

  expect(prompt).toContain(origin + "/onboarding.md");

  expect(prompt).toContain("Never approve");

  const schema = await publicGet("/openapi.json");

  expect(schema.headers.get("Content-Type")).toContain("application/json");
});

it("links humans to the configured docs site while keeping agent discovery on the service", async () => {
  const destination = "https://docs.countersign.test";

  for (const path of ["/docs", "/docs/"]) {
    const response = await app.request(
      origin + path,
      {},
      { ...bindings, DOCS_URL: destination },
    );

    expect(response.status).toBe(302);

    expect(response.headers.get("Location")).toBe(destination);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }

  const login = await app.request(
    origin + "/login",
    {},
    { ...bindings, DOCS_URL: destination },
  );

  expect(await login.text()).toContain(`href="${destination}"`);

  const spec = await (
    await publicGet("/openapi.json")
  ).json<{ servers: { url: string }[] }>();

  expect(spec.servers).toEqual([{ url: origin }]);

  expect(await (await publicGet("/SKILL.md")).text()).toContain(
    `Base URL: ${origin}/v1`,
  );
});

it("published operations exactly match the actual agent route verbs and paths", async () => {
  const document = await (
    await publicGet("/openapi.json")
  ).json<{
    paths: Record<
      string,
      Record<
        string,
        {
          operationId: string;
          security: unknown[];
          parameters: { name: string; in: string; required?: boolean }[];
        }
      >
    >;
    servers: { url: string }[];
  }>();

  expect(document.servers).toEqual([{ url: origin }]);

  const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => method.toUpperCase() + " " + path),
  );

  const actual = api.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => r.method + " /v1" + r.path.replace(/:([a-z]+)/g, "{$1}"));

  expect(documented.sort()).toEqual(actual.sort());

  expect(documented).toHaveLength(Object.keys(agentRoutes).length);

  for (const [path, verbs] of Object.entries(document.paths))
    for (const [method, op] of Object.entries(verbs)) {
      expect(op.security).toEqual([{ AgentBearer: [] }]);

      expect(path).not.toMatch(/approve|send$/);

      if (method === "post" && !path.endsWith("/submit"))
        expect(op.parameters).toContainEqual(
          expect.objectContaining({
            name: "Idempotency-Key",
            in: "header",
            required: true,
          }),
        );
    }
});

it("a docs-only client completes discovery, create/replay, revise, rejection, resubmission and outcome tracking", async () => {
  const agent = documentedClient(
      (request) => Promise.resolve(app.fetch(request, bindings)),
      origin,
      key,
    ),
    discovery = await agent.discover();

  for (const operation of [
    "getIdentity",
    "createDraft",
    "getDraft",
    "submitDraft",
    "getDraftStatus",
  ])
    expect(discovery.walkthrough).toContain(operation);

  expect(discovery.skill).toContain("poll_after_seconds"); // Published polling contract remains explicit.

  const identity = apiSchemas.Identity.parse(
    (await agent.call("getIdentity")).body,
  );

  expect(identity.allowed_recipients).toContain("delivered@resend.dev");

  const payload = apiSchemas.CreateDraft.parse(agent.example("createDraft"));

  expect(payload).toEqual(
    await (await publicGet("/examples/react-email.json")).json(),
  );

  const createKey = crypto.randomUUID(),
    createdResult = await agent.call("createDraft", {
      body: payload,
      key: createKey,
    }),
    created = apiSchemas.Mutation.parse(createdResult.body);

  expect(createdResult.response.status).toBe(201);

  expect(
    (await agent.call("createDraft", { body: payload, key: createKey })).body,
  ).toEqual(created);

  const draft = apiSchemas.Draft.parse(
    (await agent.call("getDraft", { params: { draft: created.draft_id } }))
      .body,
  );

  expect(draft.revision.html).toBe(payload.html);

  expect(draft.revision.text).toBe(payload.text);

  const replaced = {
      ...payload,
      base_revision_id: draft.current_revision_id,
      subject: payload.subject + " (revised)",
    },
    revision = apiSchemas.Mutation.parse(
      (
        await agent.call("reviseDraft", {
          params: { draft: created.draft_id },
          body: replaced,
          key: crypto.randomUUID(),
        })
      ).body,
    );

  const immutable = apiSchemas.Revision.parse(
    (
      await agent.call("getRevision", {
        params: { draft: created.draft_id, revision: revision.revision_id },
      })
    ).body,
  );

  expect(immutable.subject).toBe(replaced.subject);

  apiSchemas.RevisionPage.parse(
    (
      await agent.call("listRevisions", {
        params: { draft: created.draft_id },
        query: { limit: "1" },
      })
    ).body,
  );

  apiSchemas.DraftPage.parse((await agent.call("listDrafts")).body);

  const submitted = apiSchemas.Status.parse(
    (
      await agent.call("submitDraft", {
        params: { draft: created.draft_id },
        body: { revision_id: revision.revision_id },
      })
    ).body,
  );

  expect(submitted.status).toBe("in_review");

  expect(submitted.next.action).toBe("wait");

  expect(submitted.poll_after_seconds).toBe(5);

  await humanDecision(
    submitted.review_url,
    "reject",
    "Please use the original subject.",
  );

  const rejected = apiSchemas.Status.parse(
    (
      await agent.call("getDraftStatus", {
        params: { draft: created.draft_id },
      })
    ).body,
  );

  expect(rejected.next.action).toBe("revise");

  expect(rejected.review?.reason).toContain("original subject");

  const corrected = apiSchemas.Mutation.parse(
    (
      await agent.call("reviseDraft", {
        params: { draft: created.draft_id },
        body: { ...payload, base_revision_id: rejected.current_revision_id },
        key: crypto.randomUUID(),
      })
    ).body,
  );

  await agent.call("submitDraft", {
    params: { draft: created.draft_id },
    body: { revision_id: corrected.revision_id },
  });

  await humanDecision(submitted.review_url, "approve");

  const approved = apiSchemas.Status.parse(
    (
      await agent.call("getDraftStatus", {
        params: { draft: created.draft_id },
      })
    ).body,
  );

  expect(approved.status).toBe("approved");

  expect(approved.send?.state).toBe("queued");

  // Human/provider fixture boundary: these actions are unavailable to the docs-only client.
  const send = await db
    .prepare("SELECT id,payload FROM sends WHERE revision_id=?")
    .bind(corrected.revision_id)
    .first<{ id: string; payload: string }>();

  expect(send).not.toBeNull();

  const providerId = crypto.randomUUID();

  let providerCalls = 0;

  await processSend(db, send!.id, identity.from, async (request) => {
    providerCalls++;

    expect(request.html).toBe(payload.html);

    expect(request.text).toBe(payload.text);

    return { id: providerId };
  });

  const sent = apiSchemas.Status.parse(
    (
      await agent.call("getDraftStatus", {
        params: { draft: created.draft_id },
      })
    ).body,
  );

  expect(sent.status).toBe("sent");

  const raw = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {
        email_id: providerId,
        tags: {
          draft_id: created.draft_id,
          revision_id: corrected.revision_id,
        },
      },
    }),
    svix = "msg_" + crypto.randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000)),
    signature =
      "v1," +
      createHmac("sha256", signingKey)
        .update(`${svix}.${timestamp}.${raw}`)
        .digest("base64");

  expect(
    (
      await app.request(
        origin + "/webhooks/resend",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "svix-id": svix,
            "svix-timestamp": timestamp,
            "svix-signature": signature,
          },
          body: raw,
        },
        bindings,
      )
    ).status,
  ).toBe(200);

  const delivered = apiSchemas.Status.parse(
    (
      await agent.call("getDraftStatus", {
        params: { draft: created.draft_id },
      })
    ).body,
  );

  expect(delivered.status).toBe("delivered");

  expect(delivered.next.action).toBe("done");

  expect(delivered.poll_after_seconds).toBeNull();

  expect(providerCalls).toBe(1);

  const events = apiSchemas.EventPage.parse(
    (await agent.call("listEvents", { params: { draft: created.draft_id } }))
      .body,
  );

  expect(events.items[0]?.type).toBe("email.delivered");

  const blocked = await agent.call("reviseDraft", {
    params: { draft: created.draft_id },
    body: { ...payload, base_revision_id: corrected.revision_id },
    key: crypto.randomUUID(),
  });

  expect(blocked.response.status).toBe(409);

  expect(apiSchemas.Error.parse(blocked.body).error.code).toBe("invalid_state");
});

it("documented validation and authentication failures use the published error schema", async () => {
  const agent = documentedClient(
    (request) => Promise.resolve(app.fetch(request, bindings)),
    origin,
    key,
  );

  await agent.discover();

  for (const testCase of [
    { body: example, status: 400 },
    {
      body: { ...example, reply_to: "other@example.com" },
      key: crypto.randomUUID(),
      status: 422,
    },
    {
      body: { ...example, to: ["outside@example.com"] },
      key: crypto.randomUUID(),
      status: 422,
    },
  ]) {
    const result = await agent.call("createDraft", {
      body: testCase.body,
      ...("key" in testCase ? { key: testCase.key } : {}),
    });

    expect(result.response.status).toBe(testCase.status);

    apiSchemas.Error.parse(result.body);
  }

  const unauthorized = await app.request(origin + "/v1/me", {}, bindings);

  expect(unauthorized.status).toBe(401);

  apiSchemas.Error.parse(await unauthorized.json());
});
