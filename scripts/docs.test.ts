import { URL } from "node:url";
import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { openapiDocument } from "../apps/web/src/openapi";
import { apiSchemas } from "../apps/web/src/api-contract";
import meta from "../tests/fixtures/openapi-3.1-schema.json";
import example from "../examples/react-email/draft.json";

it("generates a valid OpenAPI 3.1 document with compilable JSON Schema components", () => {
  const ajv = new Ajv2020({ strict: false });

  addFormats(ajv);

  ajv.addFormat("media-range", /^[^\s/;]+\/[^\s/;]+(?:\s*;.*)?$/);

  // Ajv supports dynamic anchors only at a resource root. Concretize the
  // unextended OAI schema's nested #meta anchor to its exact static target.
  const structuralMeta = JSON.parse(
    JSON.stringify(meta).replaceAll(
      '"$dynamicRef":"#meta"',
      '"$ref":"#/$defs/schema"',
    ),
  );

  const document = openapiDocument();

  expect(
    ajv.validate(structuralMeta, document),
    JSON.stringify(ajv.errors),
  ).toBe(true);

  for (const schema of Object.values(document.components.schemas)) {
    expect(ajv.validateSchema(schema), JSON.stringify(ajv.errors)).toBe(true);

    expect(() => ajv.compile(schema)).not.toThrow();
  }

  const validate = ajv.compile(document.components.schemas.CreateDraft!);

  expect(validate(example), JSON.stringify(validate.errors)).toBe(true);

  expect(validate({ ...example, to: ["a@example.com", "b@example.com"] })).toBe(
    false,
  );

  expect(validate({ ...example, cc: [] })).toBe(false);

  expect(validate({ ...example, text: "", html: "" })).toBe(false);

  expect(validate({ ...example, subject: "x".repeat(201) })).toBe(false);

  expect(
    apiSchemas.CreateDraft.safeParse({ ...example, subject: "🚀".repeat(200) })
      .success,
  ).toBe(true);

  expect(validate({ ...example, subject: "🚀".repeat(200) })).toBe(true);
});

it("keeps checked-in artifacts synchronized and free of credential examples", async () => {
  const serialized = JSON.stringify(openapiDocument(), null, 2) + "\n";

  expect(
    await readFile(new URL("../docs/openapi.json", import.meta.url), "utf8"),
  ).toBe(serialized);

  expect(serialized).not.toMatch(/cs_agent_[a-f0-9]{64}|Bearer re_/);
});
