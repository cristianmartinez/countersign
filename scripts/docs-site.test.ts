import { it, expect } from "vitest";
import { docsSettings } from "../apps/docs/site-settings";
import { docsSiteArtifacts } from "./docs-site-content";
import { agentSkill } from "../apps/web/src/skill";
import { onboardingMarkdown } from "../apps/web/src/onboarding";
import { openapiDocument } from "../apps/web/src/openapi";

it("renders existing Markdown and publishes agent artifacts from the live contract sources", async () => {
  const appUrl = "https://app.countersign.test";

  const artifacts = await docsSiteArtifacts(appUrl);

  expect(JSON.parse(artifacts["public/openapi.json"]!)).toEqual(
    openapiDocument(appUrl),
  );

  expect(artifacts["public/SKILL.md"]).toBe(agentSkill(appUrl, null));

  expect(artifacts["public/onboarding.md"]).toBe(onboardingMarkdown(appUrl));

  expect(artifacts["public/SKILL.md"]).toContain(`${appUrl}/v1`);

  expect(artifacts["public/SKILL.md"]).toContain(`${appUrl}/health`);

  expect(artifacts["public/SKILL.md"]).not.toContain("Development status:");

  expect(artifacts["src/content/docs/generated/getting-started.md"]).toContain(
    "OpenAPI operationId: createDraft",
  );

  expect(artifacts["src/content/docs/generated/project/overview.md"]).toContain(
    "approval",
  );

  expect(
    Object.keys(artifacts).filter((path) => path.includes("/project/")),
  ).toEqual(["src/content/docs/generated/project/overview.md"]);

  expect(Object.values(artifacts).join("\n")).not.toMatch(
    /docs\/(?:KICKOFF|DECISIONS|PRODUCT|ONBOARDING-ACCEPTANCE)\.md|project\/(?:kickoff|decisions|product)/,
  );

  const reference = artifacts["src/content/docs/generated/api-reference.md"]!;

  for (const methods of Object.values(openapiDocument().paths))
    for (const value of Object.values(methods))
      expect(reference).toContain(
        `## ${(value as { operationId: string }).operationId}`,
      );

  expect(Object.values(artifacts).join("\n")).not.toMatch(
    /cs_agent_[a-f0-9]{64}|Bearer re_/,
  );
});

it("accepts public deployment origins and rejects credentials or ambiguous base paths", () => {
  expect(
    docsSettings({
      COUNTERSIGN_APP_URL: "https://app.example.com",
      COUNTERSIGN_DOCS_URL: "https://docs.example.com/",
    }),
  ).toEqual({
    appUrl: "https://app.example.com",
    docsUrl: "https://docs.example.com",
  });

  for (const value of [
    "javascript:alert(1)",
    "https://key:secret@example.com",
    "https://example.com/docs",
    "https://example.com/?key=secret",
    "https://example.com/#fragment",
  ])
    expect(() => docsSettings({ COUNTERSIGN_APP_URL: value })).toThrow();
});
