# Generate OpenAPI From Spectests

## Recommendation: Do Not Pursue

Do not pursue Spectest-to-OpenAPI generation as a long-term production-grade integration. It has no sustainable reliability ceiling by design: Spectests are partial behavioral samples, while OpenAPI is expected to be an authoritative API contract.

The generated document would always be constrained by what tests happen to cover, how precise their assertions are, and which dynamic paths were observed. That makes it useful at most as a local bootstrap or exploratory aid, not as a durable source for production documentation, SDK generation, governance, or contract review.

The better long-term direction is to generate Spectests from an OpenAPI schema, not generate the OpenAPI schema from Spectests. In that model, OpenAPI remains the contract source of truth, and Spectest verifies implementation conformance against it.

## Major Limitations Of This Integration

- Untested endpoints, statuses, headers, auth modes, content types, and error responses will be omitted from the generated contract.
- `response.json` assertions are intentionally partial, so inferred response schemas will be weak, mostly optional, and unable to prove that unasserted fields are absent or required.
- Dynamic tests using `beforeSend`, shared state, generated IDs, dependent flows, or `postTest` cannot be reliably understood by static generation.
- Cassette enrichment depends on recorded samples, which can drift from current behavior, miss important cases, or leak sensitive data without heavy redaction controls.
- Path and query parameter inference from concrete endpoints is heuristic and error-prone, especially for IDs, slugs, optional query parameters, repeated query keys, and templated routes.
- Zod-to-OpenAPI conversion is lossy for transforms, refinements, brands, effects, custom validators, and runtime predicates.
- Filtered test runs can accidentally produce partial OpenAPI documents unless the command has strong guardrails.
- Preservation and merge behavior creates stale-documentation risk when endpoints, response codes, or schema shapes are removed or renamed.
- The output will always reflect test coverage quality rather than actual API surface area, which is the wrong trust model for production OpenAPI.

## Better Direction

Use OpenAPI-to-Spectest generation instead:

- Treat OpenAPI as the source of truth for public contract structure, including paths, parameters, request bodies, responses, auth, and shared schemas.
- Generate Spectest cases, fixtures, and baseline assertions from the OpenAPI schema.
- Use Spectests to verify implementation conformance and report coverage gaps against the contract.
- Allow hand-authored Spectests to extend generated tests for workflows, edge cases, and business behavior that the schema cannot express.
- Produce contract coverage reports showing which OpenAPI operations, statuses, examples, and schemas are exercised by Spectests.

## Summary

Add a first-class `spectest openapi` generation mode that builds an OpenAPI 3.1 document from all discovered spectests for each method and endpoint, updates an existing OpenAPI file in place, and preserves human-authored documentation fields across regeneration.

Generation is static-first: it uses authored request bodies, `response.json`, `response.schema`, headers, status codes, and examples. If a Spectest cassette is available, it also uses recorded SUT responses to enrich examples and inferred schemas without executing tests.

## Key Changes

- Replace the current one-test-per-endpoint generator with aggregation by `METHOD path`.
- Reuse the existing config, suite discovery, loader plugin, and filter preparation flow so OpenAPI generation sees the same tests as the runner.
- Add CLI command:
  - `spectest openapi`
  - `--output <file>` defaults to `openapi.json`
  - `--cassette <file>` defaults to configured `recordingFile`
  - existing `--dir`, `--config`, `--test-dir`, `--file-pattern`, `--tags`, and `--filter` apply.
- Generate OpenAPI 3.1:
  - `paths[path][method]`
  - request body schema/examples from all request bodies for the operation
  - responses grouped by status code
  - merged superset response schemas per status
  - named examples from test cases and cassette observations
- Preserve human-authored OpenAPI fields when updating the output file:
  - operation `summary`, `description`, `tags`, `externalDocs`, `deprecated`, `security`
  - response `description`
  - request/response media-type `examples`
  - schema and property `description`, `title`, `summary`, `examples`, `deprecated`, `externalDocs`
- Add a configurable preserve list, for example `openapi.preserveFields`, seeded with the defaults above.

## Schema Behavior

- Use merged superset schemas for multiple tests/recordings on the same method, path, and status.
- Treat incomplete assertions conservatively:
  - asserted fields become known properties
  - unasserted fields are not considered absent
  - generated response properties are optional unless an explicit JSON Schema or Zod schema marks them required
- When observed values conflict, use OpenAPI 3.1 union types where possible, for example `type: ["string", "number"]`; fall back to `oneOf` only for incompatible object or array shapes.
- Add a Zod conversion dependency and convert authored `response.schema` where possible.
- Support plain JSON Schema in `response.schema` directly.
- Preserve existing human-edited schema descriptions and examples after regenerating structural fields.

## Recording Changes

- Extend cassette format to include SUT request/response observations in addition to outbound dependency recordings.
- Store enough SUT metadata to map observations back to tests:
  - method, endpoint URL/path, request body, response status, response headers, response body
  - test `operationId`, test name, suite name, recorded timestamp
- Keep backward compatibility with current cassette files; old cassettes simply provide no SUT observations.
- Existing outbound cassette entries remain unchanged for replay behavior.

## Test Plan

- Unit test aggregation: multiple tests for the same method/path/status produce one operation with combined examples and merged schemas.
- Unit test preservation: regenerate over an edited OpenAPI file and verify descriptions, summaries, tags, examples, and property descriptions survive.
- Unit test partial assertions: `response.json` with a subset of fields does not mark fields required or forbid additional fields.
- Unit test type conflicts: different observed values for the same property generate OpenAPI 3.1 union types.
- Unit test Zod conversion: `z.object`, `.partial()`, arrays, literals, nullable/optional fields, and nested objects convert correctly.
- Integration test CLI: `spectest openapi --dir examples/http-recording --output <tmp>` loads configured suites and writes valid OpenAPI JSON.
- Integration test cassette enrichment: generation with a cassette containing SUT observations adds examples and schema fields not present in static assertions.

## Assumptions

- OpenAPI 3.1 is the target format.
- The generator updates the output file in place when it exists.
- Static generation never starts the server or sends HTTP requests.
- Cassette enrichment is optional and best-effort.
- Human-authored documentation should live in the generated OpenAPI file and be preserved on future updates.
