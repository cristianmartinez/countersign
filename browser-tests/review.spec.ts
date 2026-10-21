import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { getPlatformProxy } from "wrangler";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { AuthStore, DraftStore } from "../packages/db/src/index";
import { randomToken } from "../packages/core/src/index";
import type { PlatformProxy } from "wrangler";
import emailExample from "../examples/react-email/draft.json" with { type: "json" };

let proxy: PlatformProxy<Env>,
  loginEmail: string,
  draft: string,
  revision: string,
  rejectDraft: string,
  editDraft: string;

const malicious = `<title>Inbox-only title</title><h1>Review browser fixture</h1><p>Safe email text</p><script>parent.previewPwned=true;fetch('https://preview-probe.invalid/script')</script><img alt="Blocked image" src="https://preview-probe.invalid/pixel"><style>@import url('https://preview-probe.invalid/style');p{background-image:url('https://preview-probe.invalid/bg')}</style><a href="https://preview-probe.invalid/nav" target="_top">External link</a><form action="https://preview-probe.invalid/form"><input name="secret"><button>Submit malicious form</button></form><meta http-equiv="refresh" content="0;url=https://preview-probe.invalid/refresh"><iframe src="https://preview-probe.invalid/frame"></iframe>`;

test.beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: "apps/web/wrangler.jsonc",
    envFiles: [fileURLToPath(new URL("./fixtures.env", import.meta.url))],
    persist: { path: ".wrangler/browser-tests/v3" },
    remoteBindings: false,
  });

  const migrations = await readD1Migrations("./packages/db/migrations");

  await proxy.env.DB.exec(
    "CREATE TABLE IF NOT EXISTS browser_migrations (name TEXT PRIMARY KEY)",
  );

  for (const migration of migrations) {
    if (
      !(await proxy.env.DB.prepare(
        "SELECT name FROM browser_migrations WHERE name=?",
      )
        .bind(migration.name)
        .first())
    )
      await proxy.env.DB.batch([
        ...migration.queries.map((q) => proxy.env.DB.prepare(q)),
        proxy.env.DB.prepare("INSERT INTO browser_migrations VALUES(?)").bind(
          migration.name,
        ),
      ]);
  }

  const auth = new AuthStore(proxy.env.DB),
    id = randomToken().slice(0, 12),
    account = await auth.provision(
      {
        email: `browser-${id}@example.com`,
        recipient: `browser-${id}@example.com`,
        name: "Browser reviewer",
        password: "browser reviewer password",
        agentName: "Browser agent",
      },
      proxy.env.AGENT_KEY_ENCRYPTION_KEY,
    );

  loginEmail = `browser-${id}@example.com`;

  const store = new DraftStore(proxy.env.DB),
    created = await store.create(account.agent_id, randomToken(), {
      from: "team@example.com",
      to: [`browser-${id}@example.com`],
      subject: "Browser review",
      text: "Safe plain text",
      html: malicious,
    });

  draft = created.draft_id;

  revision = created.revision_id;

  await store.submit(account.agent_id, draft, revision);

  for (let i = 0; i < 9; i++) {
    const extra = await store.create(account.agent_id, randomToken(), {
      from: "team@example.com",
      to: [loginEmail],
      subject: `Pagination fixture ${i}`,
      text: "Pagination fixture",
    });

    await store.submit(account.agent_id, extra.draft_id, extra.revision_id);

    if (i === 0) rejectDraft = extra.draft_id;
  }
  const editable = await store.create(account.agent_id, randomToken(), {
    from: "team@example.com",
    to: [loginEmail],
    subject: "Editable React Email",
    html: emailExample.html,
    text: emailExample.text,
  });
  editDraft = editable.draft_id;
  await store.submit(account.agent_id, editable.draft_id, editable.revision_id);
});

test.afterAll(async () => {
  await proxy?.dispose();
});

test("preview blocks active behavior and requests; tabs, queue and approval work in a browser", async ({
  page,
}) => {
  const external: string[] = [];

  page.on("request", (request) => {
    if (request.url().includes("preview-probe.invalid"))
      external.push(request.url());
  });

  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);

  await expect(page.locator("html")).toHaveClass("dark");

  await expect(page.locator('[data-slot="card"]')).toBeVisible();

  await page.screenshot({
    path: "test-results/dark-login.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator('[data-slot="card"]')).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: "test-results/dark-login-mobile.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByLabel("Email", { exact: true }).fill(loginEmail);

  await page
    .getByLabel("Password", { exact: true })
    .fill("browser reviewer password");

  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();

  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );

  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();

  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );

  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveAttribute("data-slot", "button");

  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCSS("font-weight", "500");

  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/review$/);

  await page.goto("/review");

  await expect(page.getByRole("table", { name: "Emails" })).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search emails" })
    .fill("Browser review");

  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page).toHaveURL(/q=Browser/);

  await page.screenshot({
    path: "test-results/dark-review-table.png",
    fullPage: true,
  });

  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toHaveCount(0);

  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toHaveCount(1);

  await page.goto("/review?view=all&q=Browser%20review");

  await page.getByRole("combobox", { name: "Status", exact: true }).click();

  await page.getByRole("option", { name: "in review", exact: true }).click();

  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page).toHaveURL(/status=in_review/);

  await page.setViewportSize({ width: 390, height: 844 });

  const reviewAction = page.getByRole("button", {
    name: "Review",
    exact: true,
  });

  await expect(reviewAction).toBeInViewport();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: "test-results/review-queue-mobile.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator(`a[href="/review/drafts/${draft}"]`).first().click();

  await expect(
    page.getByRole("heading", { name: "Browser review", exact: true }),
  ).toBeVisible();

  await page.screenshot({
    path: "test-results/reviewer-detail.png",
    fullPage: true,
  });

  await expect(
    page.getByRole("heading", { name: "Revision history" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Revisions" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Revision 1", exact: true }),
  ).toHaveAttribute("aria-current", "true");

  const tabsBounds = (await page
    .getByRole("tablist", { name: "Email bodies" })
    .boundingBox())!;

  const previewBounds = (await page
    .locator('iframe[title="Email HTML preview"]')
    .boundingBox())!;

  expect(tabsBounds.height).toBeLessThan(60);

  expect(tabsBounds.y + tabsBounds.height).toBeLessThanOrEqual(previewBounds.y);

  await page.setViewportSize({ width: 390, height: 844 });

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: "test-results/reviewer-detail-mobile.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 720 });

  const frame = page.frameLocator('iframe[title="Email HTML preview"]');

  await expect(frame.getByText("Safe email text")).toBeVisible();
  await expect(frame.getByText("Inbox-only title")).toHaveCount(0);

  expect(
    await page.evaluate(() => Object.hasOwn(globalThis, "previewPwned")),
  ).toBe(false);

  expect(
    await frame
      .locator("script,form,input,iframe,meta[http-equiv=refresh]")
      .count(),
  ).toBe(0);

  const before = page.url();

  await frame.getByText("External link").click();

  await page.waitForTimeout(150);

  expect(page.url()).toBe(before);

  expect(external).toEqual([]);

  await page.getByRole("tab", { name: "HTML", exact: true }).click();

  await expect(page.locator("#panel-source")).toBeVisible();

  await expect(page.locator("#panel-source")).toContainText(
    "<script>parent.previewPwned",
  );

  await page.getByRole("tab", { name: "Text", exact: true }).click();

  await expect(page.locator("#panel-text")).toContainText("Safe plain text");

  await expect(page.locator("#panel-source")).toBeHidden();

  await page.getByRole("tab", { name: "Text", exact: true }).press("Home");

  await page.getByRole("tab", { name: "Preview", exact: true }).press("Enter");

  await expect(
    page.getByRole("tab", { name: "Preview", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await expect(page.locator("#panel-preview")).toBeVisible();

  await expect(page.locator("#panel-text")).toBeHidden();

  await page
    .getByRole("button", { name: "Approve revision 1", exact: true })
    .click();

  await expect(page.getByText("Current revision: approved")).toBeVisible();

  const send = await proxy.env.DB.prepare(
    "SELECT payload FROM sends WHERE revision_id=?",
  )
    .bind(revision)
    .first<{ payload: string }>();

  expect(JSON.parse(send!.payload).html).toBe(malicious);

  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
});

test("rejection requires confirmation and a reason in a modal", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel("Email", { exact: true }).fill(loginEmail);

  await page
    .getByLabel("Password", { exact: true })
    .fill("browser reviewer password");

  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/review$/);

  await page.goto(`/review/drafts/${rejectDraft}`);

  let rejections = 0;

  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/reject"))
      rejections++;
  });

  const trigger = page.getByRole("button", {
    name: "Reject revision 1",
    exact: true,
  });

  await expect(
    page.getByLabel("Reason for rejection", { exact: true }),
  ).toBeHidden();

  await trigger.click();

  const dialog = page.getByRole("dialog", {
    name: "Reject revision 1?",
    exact: true,
  });

  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Confirm rejection" }).click();

  await expect(dialog).toBeVisible();

  expect(rejections).toBe(0);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(dialog).toBeHidden();

  await expect(trigger).toBeFocused();

  expect(rejections).toBe(0);

  await trigger.click();

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();

  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });

  await trigger.click();

  await dialog
    .getByLabel("Reason for rejection", { exact: true })
    .fill("Please remove the delivery promise.");

  const bounds = (await dialog.boundingBox())!;

  expect(bounds.x).toBeGreaterThanOrEqual(0);

  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);

  await page.screenshot({
    path: "test-results/rejection-modal-mobile.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Confirm rejection" }).click();

  await expect(page.getByText("Current revision: rejected")).toBeVisible();

  await expect(page.getByText("Current revision: rejected")).toBeVisible();

  await expect(
    page.getByText("Please remove the delivery promise.", { exact: true }),
  ).toBeVisible();

  expect(rejections).toBe(1);
});

test("Connect reveals a complete copyable prompt and public onboarding works without an agent credential", async ({
  page,
  context,
}) => {
  const clientErrors: string[] = [];

  page.on("pageerror", (error) => clientErrors.push(error.message));

  page.on("console", (message) => {
    if (message.type() === "error") clientErrors.push(message.text());
  });

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/login");

  await page.getByLabel("Email", { exact: true }).fill(loginEmail);

  await page
    .getByLabel("Password", { exact: true })
    .fill("browser reviewer password");

  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/review$/);

  await page.getByRole("link", { name: "Countersign", exact: true }).click();

  await expect(page).toHaveURL(/\/review$/);

  await expect(
    page.getByRole("link", { name: "Agent documentation", exact: true }),
  ).toHaveAttribute(
    "href",
    `http://localhost:${process.env.COUNTERSIGN_TEST_DOCS_PORT ?? 4321}`,
  );

  await page
    .getByRole("link", { name: "Agent documentation", exact: true })
    .click();

  await expect(page).toHaveURL(
    `http://localhost:${process.env.COUNTERSIGN_TEST_DOCS_PORT ?? 4321}/`,
  );

  await page
    .getByRole("link", { name: "Your first five minutes", exact: true })
    .click();

  await expect(
    page.getByRole("heading", {
      name: "Your first five minutes with Countersign",
      exact: true,
    }),
  ).toBeVisible();

  await expect(
    page.getByText("GET /v1/me", { exact: false }).first(),
  ).toBeVisible();

  await expect(
    page.getByText("Authorization: Bearer <the supplied agent key>", {
      exact: true,
    }),
  ).toBeVisible();

  await page.screenshot({
    path: "test-results/agent-docs.png",
    fullPage: true,
  });

  await page.getByRole("link", { name: "Open app", exact: false }).click();

  await expect(page).toHaveURL(/localhost:8791\/review$/);

  await page.goto("/connect");

  await page
    .getByRole("button", { name: "Reveal agent key and setup prompt" })
    .click();

  const key = await page.getByLabel("Agent key", { exact: true }).inputValue();

  const prompt = await page
    .getByLabel("Setup prompt", { exact: true })
    .inputValue();

  expect(prompt).toContain(`Bearer ${key}`);

  for (const path of ["/SKILL.md", "/openapi.json", "/onboarding.md"])
    expect(prompt).toContain(path);

  await page
    .getByRole("button", { name: "Copy setup prompt", exact: true })
    .click();

  await expect(page.getByRole("status")).toHaveText("Copied");

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    prompt,
  );

  const identity = await page.request.get("/v1/me", {
    headers: { Authorization: `Bearer ${key}` },
  });

  expect(identity.status()).toBe(200);

  expect((await identity.json()).allowed_recipients).toContain(loginEmail);

  await page.getByRole("link", { name: "Hide key", exact: true }).click();

  await expect(page.getByLabel("Agent key", { exact: true })).toHaveCount(0);

  expect(clientErrors).toEqual([]);
});

test("reviewer can edit subject and body with React Email, then review and approve the new revision", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(loginEmail);
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser reviewer password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.goto(`/review/drafts/${editDraft}`);
  await page.getByRole("button", { name: "Edit email", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/review/drafts/${editDraft}$`));
  await expect(
    page.getByRole("heading", { name: "Message details", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Revision history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Approve revision/ }),
  ).toHaveCount(0);

  await page
    .getByLabel("Subject", { exact: true })
    .fill("Reviewer edited email");
  await expect(
    page.locator('.email-editor [contenteditable="true"]'),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save revision", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reviewer edited email", exact: true }),
  ).toBeVisible();
  const subjectOnly = await proxy.env.DB.prepare(
    "SELECT html_body,text_body FROM revisions WHERE draft_id=? ORDER BY number DESC LIMIT 1",
  )
    .bind(editDraft)
    .first<{ html_body: string | null; text_body: string }>();
  expect(subjectOnly!.html_body).toBe(emailExample.html);
  expect(subjectOnly!.text_body).toBe(emailExample.text);
  await page.getByRole("button", { name: "Edit email", exact: true }).click();
  await expect(
    page.locator('.email-editor [contenteditable="true"]'),
  ).toBeVisible();
  await page
    .locator('.email-editor [contenteditable="true"]')
    .fill("A corrected email from the reviewer.");
  await page.screenshot({
    path: "test-results/reviewer-email-editor.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save revision", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reviewer edited email", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("By Reviewer", { exact: true })).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Email HTML preview"]')
      .getByText("A corrected email from the reviewer.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  await expect(page.locator("#panel-text")).toContainText(
    "A corrected email from the reviewer.",
  );
  const revisionTimeline = page.getByRole("list", { name: "Revisions" });
  await expect(revisionTimeline.getByRole("listitem")).toHaveCount(3);
  await expect(
    revisionTimeline.getByRole("link", { name: "Revision 3", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await revisionTimeline
    .getByRole("link", { name: "Revision 1", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "Revisions" })
      .getByRole("link", { name: "Revision 1", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page
    .getByRole("list", { name: "Revisions" })
    .getByRole("link", { name: "Revision 3", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reviewer edited email", exact: true }),
  ).toBeVisible();

  await page.screenshot({
    path: "test-results/reviewer-edited-email.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Approve revision 3", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit email", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Sending details", exact: true })
    .click();
  await expect(
    page.getByText("No provider receipt", { exact: true }),
  ).toBeVisible();
  const statusCard = page
    .getByRole("heading", { name: "Sending status", exact: true })
    .locator("xpath=ancestor::*[@data-slot='card']");
  const eventsCard = page
    .getByRole("heading", { name: "Delivery events", exact: true })
    .locator("xpath=ancestor::*[@data-slot='card']");
  await expect(statusCard.locator("xpath=ancestor::aside")).toHaveCount(1);
  const contentBounds = await page
    .getByRole("heading", { name: "Email content", exact: true })
    .boundingBox();
  const eventsBounds = await eventsCard.boundingBox();
  expect(eventsBounds!.y).toBeGreaterThan(contentBounds!.y);
  expect(eventsBounds!.x).toBeLessThan((await statusCard.boundingBox())!.x);
  await page.screenshot({
    path: "test-results/delivery-layout.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Sending details", exact: true })
    .click();
  await expect(
    page.getByText("No provider receipt", { exact: true }),
  ).toBeHidden();
});

test("five-second polling updates in place, skips unchanged snapshots and preserves edits", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(loginEmail);
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser reviewer password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.goto("/review?q=Live%20polling%20email");

  let polls = 0;
  let snapshots = 0;
  const responses: number[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/review/updates") polls++;
    else if (request.headers()["accept"] === "application/json") snapshots++;
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/review/updates")
      responses.push(response.status());
  });

  await page.clock.runFor(5000);
  await expect.poll(() => responses.length).toBe(1);
  expect(responses[0]).toBe(304);
  expect(snapshots).toBe(0);

  const owner = await proxy.env.DB.prepare(
    "SELECT owner_agent_id FROM drafts WHERE id=?",
  )
    .bind(rejectDraft)
    .first<{ owner_agent_id: string }>();
  const store = new DraftStore(proxy.env.DB);
  const content = {
    from: "team@example.com",
    to: [loginEmail] as [string],
    subject: "Live polling email",
    text: "Original body",
  };
  const created = await store.create(
    owner!.owner_agent_id,
    randomToken(),
    content,
  );
  await store.submit(
    owner!.owner_agent_id,
    created.draft_id,
    created.revision_id,
  );
  await page.clock.runFor(5000);
  await expect(
    page.getByRole("link", { name: "Live polling email", exact: true }),
  ).toBeVisible();
  expect(snapshots).toBe(1);
  await expect(page).toHaveURL(/\/review\?q=Live%20polling%20email$/);

  await page.goto(`/review/drafts/${created.draft_id}`);
  await page.getByRole("button", { name: "Edit email", exact: true }).click();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Unsaved reviewer subject");
  const beforeEditPolls = polls;
  const revision = await store.revise(
    owner!.owner_agent_id,
    created.draft_id,
    created.revision_id,
    randomToken(),
    { ...content, subject: "Agent updated subject" },
  );
  await store.submit(
    owner!.owner_agent_id,
    created.draft_id,
    revision.revision_id,
  );
  await page.clock.runFor(15_000);
  expect(polls).toBe(beforeEditPolls);
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
    "Unsaved reviewer subject",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.runFor(5000);
  await expect(
    page.getByRole("heading", { name: "Agent updated subject", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/review/drafts/${created.draft_id}$`),
  );

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenPolls = polls;
  await page.clock.runFor(15_000);
  expect(polls).toBe(hiddenPolls);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => polls).toBe(hiddenPolls + 1);

  await expect.poll(() => responses.length).toBe(polls);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  const cachedPolls = polls;
  await page.clock.runFor(15_000);
  expect(polls).toBe(cachedPolls);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect.poll(() => polls).toBe(cachedPolls + 1);
  await expect.poll(() => responses.length).toBe(polls);

  let rateLimit = true;
  await page.route("**/review/updates", async (route) => {
    if (rateLimit) {
      rateLimit = false;
      await route.fulfill({
        status: 503,
        headers: { "Retry-After": "15" },
        body: "",
      });
    } else await route.continue();
  });
  await page.clock.runFor(5000);
  await expect.poll(() => responses.at(-1)).toBe(503);
  const failedPolls = polls;
  await page.clock.runFor(14_999);
  expect(polls).toBe(failedPolls);
  await page.clock.runFor(1);
  await expect.poll(() => polls).toBe(failedPolls + 1);

  await page.screenshot({
    path: "test-results/live-status-polling.png",
    fullPage: true,
  });
});
