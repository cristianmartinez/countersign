import { URL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { openapiDocument } from "../apps/web/src/openapi";
import { onboardingMarkdown } from "../apps/web/src/onboarding";

const artifacts = [
  ["../docs/openapi.json", JSON.stringify(openapiDocument(), null, 2) + "\n"],
  ["../docs/ONBOARDING.md", onboardingMarkdown()],
] as const;

for (const [path, content] of artifacts) {
  const file = new URL(path, import.meta.url);

  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== content)
      throw new Error(`${path} is stale. Run pnpm docs:generate.`);
  } else await writeFile(file, content);
}

console.log(
  process.argv.includes("--check")
    ? "Generated docs match their sources."
    : "Generated OpenAPI and onboarding artifacts.",
);
