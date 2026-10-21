import { test, expect } from "@playwright/test";

const docsUrl = `http://localhost:${process.env.COUNTERSIGN_TEST_DOCS_PORT ?? 4321}`;

test("Starlight renders Markdown, searches the built index and serves agent-readable contracts", async ({
  page,
  request,
}) => {
  await page.goto(docsUrl);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await expect(
    page.getByRole("heading", {
      name: "Agents draft. Humans decide.",
      exact: true,
    }),
  ).toBeVisible();

  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(10, 10, 10)",
  );

  await page.screenshot({
    path: "test-results/starlight-docs.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Search", exact: true }).click();

  await page.locator("#starlight__search input").fill("Idempotency");

  const result = page.locator(".pagefind-ui__result-link").first();

  await expect(result).toBeVisible();

  await result.click();

  await expect(
    page.getByRole("dialog", { name: "Search", exact: true }),
  ).not.toBeVisible();

  for (const path of [
    "/getting-started/",
    "/agent-workflow/",
    "/api-reference/",
    "/react-email/",
    "/project/overview/",
  ]) {
    const response = await request.get(docsUrl + path);

    expect(response.status()).toBe(200);
  }

  const specResponse = await request.get(docsUrl + "/openapi.json");

  expect(specResponse.headers()["content-type"]).toContain("application/json");

  const spec = await specResponse.json();

  expect(spec.servers).toEqual([{ url: "http://localhost:8791" }]);

  expect(spec.paths["/v1/drafts"].post.operationId).toBe("createDraft");

  const skill = await request.get(docsUrl + "/SKILL.md");

  expect(await skill.text()).toContain("Base URL: http://localhost:8791/v1");

  expect(await skill.text()).not.toContain("<html");

  expect(
    await (await request.get(docsUrl + "/onboarding.md")).text(),
  ).toContain("OpenAPI operationId: createDraft");

  expect(await (await request.get(docsUrl + "/llms.txt")).text()).toContain(
    "Agent skill",
  );

  expect(
    (await (await request.get(docsUrl + "/examples/react-email.json")).json())
      .to,
  ).toEqual(["delivered@resend.dev"]);

  await page.goto(docsUrl);

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(
    page.getByRole("heading", {
      name: "Agents draft. Humans decide.",
      exact: true,
    }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: "test-results/starlight-docs-mobile.png",
    fullPage: true,
  });
});
