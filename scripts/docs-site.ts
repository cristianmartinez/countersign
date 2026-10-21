import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { docsSettings } from "../apps/docs/site-settings";
import { docsSiteArtifacts } from "./docs-site-content";

const artifacts = await docsSiteArtifacts(docsSettings().appUrl);

// Remove stale generated pages so private or removed sources cannot survive a rebuild.
await rm(new URL("../apps/docs/src/content/docs/generated/", import.meta.url), {
  recursive: true,
  force: true,
});

for (const [path, content] of Object.entries(artifacts)) {
  const file = new URL(`../apps/docs/${path}`, import.meta.url);

  await mkdir(dirname(fileURLToPath(file)), { recursive: true });

  await writeFile(file, content);
}

console.log(
  `Prepared ${Object.keys(artifacts).length} documentation pages and agent artifacts from shared sources.`,
);
