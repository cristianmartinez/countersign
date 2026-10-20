import { readFile, writeFile } from "node:fs/promises";
import { renderDraft } from "../src/email";

const output = new URL("../draft.json", import.meta.url),
  expected = JSON.stringify(await renderDraft(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== expected)
    throw new Error("React Email artifact is stale. Run pnpm docs:generate.");

  console.log("React Email artifact matches its template.");
} else {
  await writeFile(output, expected);

  console.log(
    "Rendered examples/react-email/draft.json (no network requests).",
  );
}
