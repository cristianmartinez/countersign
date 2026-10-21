import { readFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { agentSkill } from "../apps/web/src/skill";
import { onboardingMarkdown } from "../apps/web/src/onboarding";
import { openapiDocument } from "../apps/web/src/openapi";
import example from "../examples/react-email/draft.json";

const root = fileURLToPath(new URL("../", import.meta.url));

const pages = [["README.md", "project/overview"]] as const;

const destinations = new Map<string, string>([
  ...["email-workflow", "system-architecture"].map(
    (name) =>
      [
        resolve(root, `apps/docs/public/diagrams/${name}.svg`),
        `/diagrams/${name}.svg`,
      ] as const,
  ),
  ...pages.map(
    ([source, slug]) => [resolve(root, source), `/${slug}/`] as const,
  ),
  [resolve(root, "docs/ONBOARDING.md"), "/getting-started/"],
  [resolve(root, "docs/openapi.json"), "/openapi.json"],
  [
    resolve(root, "examples/react-email/draft.json"),
    "/examples/react-email.json",
  ],
]);

function page(title: string, markdown: string) {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${markdown.trim()}\n`;
}

function documentPage(markdown: string, fallback: string) {
  const heading = markdown.match(/^# (.+)\r?\n/);

  return page(heading?.[1] ?? fallback, markdown.replace(/^# .+\r?\n/, ""));
}

function rewriteLinks(markdown: string, source: string) {
  return markdown.replace(
    /\[([^\]]+)\]\(([^\s)]+)\)/g,
    (original, label: string, href: string) => {
      if (/^(?:[a-z]+:|\/|#)/i.test(href)) return original;

      const [pathname, fragment] = href.split("#");

      const target = resolve(root, dirname(source), pathname!);

      const destination = destinations.get(target);

      // Source-only files remain useful repository references, without broken web links.
      return destination
        ? `[${label}](${destination}${fragment ? `#${fragment}` : ""})`
        : `${label} (\`${relative(root, target)}${fragment ? `#${fragment}` : ""}\`)`;
    },
  );
}

type Operation = {
  operationId: string;
  summary: string;
  description: string;
  parameters: unknown[];
  requestBody?: {
    content: { "application/json": { schema: unknown; example: unknown } };
  };
  responses: unknown;
};

const json = (value: unknown) =>
  `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

export async function docsSiteArtifacts(appUrl: string) {
  const spec = openapiDocument(appUrl);

  const skill = agentSkill(appUrl, null);

  const onboarding = onboardingMarkdown(appUrl);

  const operations = Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, value]) => {
        const operation = value as Operation;

        const request = operation.requestBody?.content["application/json"];

        return `## ${operation.operationId}\n\n**${method.toUpperCase()} \`${path}\`** — ${operation.summary}\n\n${operation.description}\n\n${operation.parameters.length ? `### Parameters\n\n${json(operation.parameters)}\n\n` : ""}${request ? `### Request body\n\n${json(request.schema)}\n\nExample:\n\n${json(request.example)}\n\n` : ""}<details>\n<summary>Responses</summary>\n\n${json(operation.responses)}\n\n</details>\n`;
      }),
    )
    .join("\n");

  const schemas = Object.entries(spec.components.schemas)
    .map(
      ([name, schema]) =>
        `### ${name}\n\n<details>\n<summary>${name} JSON Schema</summary>\n\n${json(schema)}\n\n</details>\n`,
    )
    .join("\n");

  const artifacts: Record<string, string> = {
    "src/content/docs/generated/getting-started.md": documentPage(
      onboarding,
      "Your first five minutes",
    ),
    "src/content/docs/generated/agent-workflow.md": documentPage(
      skill.replace(/^---\n[\s\S]*?\n---\n/, ""),
      "Agent workflow",
    ),
    "src/content/docs/generated/api-reference.md": page(
      "API reference",
      `Generated from the same route definitions and schemas as the live API.\n\nBase URL: \`${appUrl}\`. All operations require \`Authorization: Bearer <agent key>\`. Get that key from the human’s authenticated [Connect page](${appUrl}/connect). Reviewer cookies do not authenticate the API. There is no agent approval or send endpoint.\n\nDownload [OpenAPI JSON](/openapi.json), or read the [agent workflow](/agent-workflow/) for limits, retries, recipient rules and polling. The live service at [${appUrl}/openapi.json](${appUrl}/openapi.json) is authoritative for its deployed version.\n\n${operations}\n## Schemas\n\nReferences such as \`#/components/schemas/CreateDraft\` refer to these components in the downloadable OpenAPI document.\n\n${schemas}`,
    ),
    "src/content/docs/generated/react-email.md": page(
      "React Email example",
      "Render HTML and plain text before submitting a draft. Countersign stores the final bodies and never executes agent-supplied code.\n\nDownload the [rendered example](/examples/react-email.json), or use the API reference to submit your own bodies. The repository example is in `examples/react-email`; run `pnpm --filter @countersign/react-email render` to regenerate it.",
    ).replace("---\n", "---\nslug: react-email\n"),
    "public/SKILL.md": skill,
    "public/openapi.json": JSON.stringify(spec, null, 2) + "\n",
    "public/onboarding.md": onboarding,
    "public/examples/react-email.json": JSON.stringify(example, null, 2) + "\n",
    "public/llms.txt": `# Countersign\n\nAgents prepare emails. Humans approve the exact recipients and content.\n\n- [Agent skill](/SKILL.md)\n- [OpenAPI](/openapi.json)\n- [First five minutes](/onboarding.md)\n- [API reference](/api-reference/)\n- [Rendered React Email example](/examples/react-email.json)\n\nService origin: ${appUrl}\nCanonical live contract: ${appUrl}/openapi.json\nKeys come only from the human’s authenticated Connect page. These public files contain no credentials.\n`,
  };

  // Explicit slugs keep generated files in their own directory without changing public URLs.
  for (const slug of ["getting-started", "agent-workflow", "api-reference"]) {
    const path = `src/content/docs/generated/${slug}.md`;

    artifacts[path] = artifacts[path]!.replace("---\n", `---\nslug: ${slug}\n`);
  }

  for (const [source, slug] of pages) {
    const markdown = rewriteLinks(
      await readFile(resolve(root, source), "utf8"),
      source,
    );

    artifacts[`src/content/docs/generated/${slug}.md`] = documentPage(
      markdown,
      slug,
    ).replace("---\n", `---\nslug: ${slug}\n`);
  }

  return artifacts;
}
