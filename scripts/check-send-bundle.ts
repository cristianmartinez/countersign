import { readFile } from "node:fs/promises";
import { URL } from "node:url";

// Inspect esbuild's actual dependency graph, independently of minification/output text.
const meta: { inputs: Record<string, unknown> } = JSON.parse(
  await readFile(
    new URL("../apps/send/dist/metafile.json", import.meta.url),
    "utf8",
  ),
);

const rendererInputs = Object.keys(meta.inputs).filter((path) =>
  /(?:\.pnpm\/(?:react|react-dom)@|node_modules\/(?:react|react-dom)\/|\.pnpm\/@react-email\+render@)/.test(
    path,
  ),
);

if (rendererInputs.length)
  throw new Error(
    "Send bundle unexpectedly includes a React renderer: " +
      rendererInputs.join(", "),
  );

console.log("Send dependency graph excludes React and React Email rendering.");
