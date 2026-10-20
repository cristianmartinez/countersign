import { z } from "zod";
import { agentRoutes, apiSchemas, statuses } from "./api-contract";
import example from "../../../examples/react-email/draft.json";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const schemas = Object.fromEntries(
  Object.entries(apiSchemas).map(([name, schema]) => {
    const { $schema, ...json } = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
    });

    return [name, json];
  }),
);

const jsonResponse = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});

export function openapiDocument(origin = "/") {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [operationId, route] of Object.entries(agentRoutes)) {
    const path = "/v1" + route.path.replace(/:([a-z]+)/g, "{$1}");

    const parameters: Record<string, unknown>[] = Array.from(
      route.path.matchAll(/:([a-z]+)/g),
      (match) => ({
        name: match[1]!,
        in: "path",
        required: true,
        description: "Immutable ID from a previous service response.",
        schema: { type: "string", format: "uuid" },
      }),
    );

    if ("idempotency" in route)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Persist one key with the exact body per intended create/revise operation. Reuse both after response loss. Successful replay protection lasts 24 hours.",
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:/-]+$",
        },
      });

    if ("list" in route)
      parameters.push(
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "cursor",
          in: "query",
          description:
            "Opaque, context-bound next_cursor returned by the previous page; URL-encode and preserve unchanged.",
          schema: { type: "string" },
        },
      );

    if ("filter" in route)
      parameters.push({
        name: "status",
        in: "query",
        schema: { type: "string", enum: [...statuses] },
      });

    const errors: Record<string, unknown> = {
      401: jsonResponse("Error", "Missing or invalid agent credential."),
      500: jsonResponse(
        "Error",
        "Transient service failure. Retry mutations with the identical key/body.",
      ),
    };

    if (parameters.length || route.method === "post")
      errors[400] = jsonResponse(
        "Error",
        "Malformed JSON/headers, missing key or invalid pagination.",
      );

    if (route.path.includes(":draft"))
      errors[404] = jsonResponse("Error", "Unknown or out-of-scope object.");

    if (route.method === "post")
      Object.assign(errors, {
        409: jsonResponse(
          "Error",
          "Revision/state/idempotency conflict. Follow error.code and hint.",
        ),
        413: jsonResponse("Error", "Entire JSON exceeds 256 KiB."),
        422: jsonResponse(
          "Error",
          "Invalid or disallowed fields/recipient. Correct details.fields.",
        ),
      });

    const requestExample =
      "request" in route
        ? route.request === "CreateDraft"
          ? example
          : route.request === "ReviseDraft"
            ? {
                ...example,
                base_revision_id: "11111111-1111-4111-8111-111111111111",
              }
            : { revision_id: "11111111-1111-4111-8111-111111111111" }
        : undefined;

    const operation = {
      operationId,
      summary: route.summary,
      description: "description" in route ? route.description : route.summary,
      tags: ["Agent API"],
      security: [{ AgentBearer: [] }],
      parameters,
      ...("request" in route
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: ref(route.request),
                  example: requestExample,
                },
              },
            },
          }
        : {}),
      responses: {
        ...errors,
        [route.code]: jsonResponse(route.response, "Successful result."),
      },
    };

    (paths[path] ??= {})[route.method] = operation;
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Countersign agent API",
      version: "1.0.0",
      description:
        "Agents prepare emails; humans approve exact immutable revisions. Agent Bearer keys cannot approve or send. Public skill: /SKILL.md. Walkthrough: /onboarding.md. No account or Resend API key is required from agents. Sending is paused in the local configuration. UTF-8 byte limits and recipient permissions are enforced in addition to JSON Schema.",
    },
    servers: [{ url: origin }],
    security: [{ AgentBearer: [] }],
    tags: [
      {
        name: "Agent API",
        description:
          "Private drafts for the authenticated agent. Reviewer sessions never authenticate these routes.",
      },
    ],
    paths,
    components: {
      securitySchemes: {
        AgentBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "cs_agent_…",
          description:
            "Agent key from the human’s authenticated Connect page; never a reviewer password or Resend API key.",
        },
      },
      schemas,
    },
  };
}
