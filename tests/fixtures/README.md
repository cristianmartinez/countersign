openapi-3.1-schema.json is the official OpenAPI Initiative document schema from
https://spec.openapis.org/oas/3.1/schema/2022-10-07 (Apache-2.0, OpenAPI Initiative).
It validates the OpenAPI document structure. The Node tests separately compile
and validate the generated JSON Schema 2020-12 components with Ajv and formats.
No network access is used by schema validation.

Ajv only supports dynamic anchors at resource roots. For the unextended official
structure schema, the test replaces #meta dynamic references with their exact
static target #/$defs/schema at validation time. The fixture remains unchanged.
This follows the limitation documented at https://ajv.js.org/guide/combining-schemas.html.
