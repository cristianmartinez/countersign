/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { LIMITS } from "@countersign/core";
import { readSchemaVersion } from "@countersign/db";

import { docs } from "./docs";
import { auth } from "./auth";
import { api } from "./api";
import { agentSkill } from "./skill";
import { webhooks } from "./webhooks";
import { review } from "./review";

const app = new Hono<{ Bindings: Env }>();

app.route("/", auth);

app.route("/", docs);

app.route("/v1", api);

app.route("/webhooks", webhooks);

app.route("/review", review);

app.get("/SKILL.md", (c) =>
  c.text(agentSkill(new URL(c.req.url).origin, c.env.SEND_ENABLED === "true")),
);

app.get("/", (c) => {
  c.header("Cache-Control", "no-store");

  return c.redirect("/review", 303);
});

app.get("/health", async (c) => {
  c.header("Cache-Control", "no-store");

  try {
    const schemaVersion = await readSchemaVersion(c.env.DB);

    return c.json({
      status: "ok",
      stage: "agent-onboarding",
      schema_version: schemaVersion,
      max_request_bytes: LIMITS.requestBytes,
      sending_enabled: c.env.SEND_ENABLED === "true",
    });
  } catch {
    return c.json(
      {
        status: "unavailable",
        hint: "Run pnpm db:migrate before starting local development.",
      },
      503,
    );
  }
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    },
    404,
  ),
);

export default app;
