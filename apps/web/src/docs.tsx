import { Hono } from "hono";
import { openapiDocument } from "./openapi";
import { discoveryLinks, onboardingMarkdown } from "./onboarding";
import example from "../../../examples/react-email/draft.json";

const docs = new Hono<{ Bindings: Env }>();

docs.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");

  c.header("X-Content-Type-Options", "nosniff");

  await next();
});

docs.get("/openapi.json", (c) =>
  c.json(openapiDocument(new URL(c.req.url).origin)),
);

docs.get("/onboarding.md", (c) =>
  c.text(onboardingMarkdown(new URL(c.req.url).origin)),
);

docs.get("/examples/react-email.json", (c) => c.json(example));

docs.get("/llms.txt", (c) =>
  c.text(
    `# Countersign\n\nAgents prepare emails. Humans approve the exact recipients and content.\n\n${discoveryLinks.map(([name, path]) => `- [${name}](${new URL(path, c.req.url).href})`).join("\n")}\n\nAgent keys come only from the human’s authenticated Connect page. Public docs contain no credentials.\n`,
  ),
);

// Stable entry point for old bookmarks, Connect links and agent discovery.
docs.get("/docs", (c) => c.redirect(c.env.DOCS_URL, 302));

docs.get("/docs/", (c) => c.redirect(c.env.DOCS_URL, 302));

export { docs };
