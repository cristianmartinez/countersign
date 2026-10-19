import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          DOCS_URL: "http://localhost:4321",
          MIGRATIONS: await readD1Migrations("./packages/db/migrations"),
        },
      },
    })),
  ],

  test: {
    testTimeout: 30000,
    include: ["tests/**/*.test.ts", "packages/db/tests/**/*.test.ts"],
  },
});
