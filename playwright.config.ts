import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const docsPort = Number(process.env.COUNTERSIGN_TEST_DOCS_PORT ?? 4321);

export default defineConfig({
  testDir: "./browser-tests",
  workers: 1,
  use: { baseURL: "http://localhost:8791", headless: true },
  webServer: [
    {
      command: `pnpm exec wrangler dev -c apps/web/wrangler.jsonc -c apps/send/wrangler.jsonc --persist-to .wrangler/browser-tests --port 8791 --var DOCS_URL:http://localhost:${docsPort} --env-file "${fileURLToPath(new URL("./browser-tests/fixtures.env", import.meta.url))}"`,
      url: "http://localhost:8791",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: `COUNTERSIGN_APP_URL=http://localhost:8791 pnpm --filter @countersign/docs build && pnpm --filter @countersign/docs exec astro preview --host 127.0.0.1 --port ${docsPort} --ignore-lock`,
      url: `http://localhost:${docsPort}`,
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
