# Direct OpenAPI Loader For Spectest

## Summary

Build OpenAPI consumption as a first-class input path using `spectest --openapi <path>`, targeting OpenAPI 3.0 and 3.1. The runner will convert operations into in-memory Spectest suites at load time, without writing intermediary files. File generation remains a secondary future workflow for users who want editable scaffolds, but not the v1 default.

This optimizes for contract-as-source-of-truth DevX: users keep OpenAPI authoritative, run Spectest directly against it, and add config hooks for runtime details OpenAPI cannot safely provide.

## Approach And Tradeoffs

- **Direct loader merits**: no generated file drift, better for large schemas, easier CI usage, OpenAPI remains the source of truth, supports coverage reporting naturally.
- **Direct loader constraints**: harder debugging because tests are virtual, requires robust OpenAPI parsing/schema validation, cannot infer realistic request values without examples/defaults, auth must be supplied externally.
- **Generated files merits**: easy to inspect/edit, simpler first implementation, fits existing `.spectest.{json,yaml,js}` model, good onboarding/scaffold workflow.
- **Generated files constraints**: stale generated tests, merge/regeneration complexity, poor scalability for large APIs, unclear ownership between OpenAPI and edited Spectests.
- **Recommendation**: implement direct loading first, but structure conversion code so a later `spectest generate openapi --output <dir>` command can reuse the same operation-to-test mapper.

## Key Changes

- Add CLI/config support:
  - CLI flag: `--openapi <path>` for v1. The flag is path-only; URL loading is a later feature.
  - Config field: `openapi?: string`.
  - Config field: `openapiAuth?: Record<string, OpenApiRequestMutator>`.
  - Config field: `openapiServer?: string | number` to select a `servers` entry by URL or index when the OpenAPI document has multiple viable servers.
  - Existing filters still apply to generated tests: `--tags`, `--filter`, `--happy`, `--timeout`, `--recording`.
- Add explicit OpenAPI source loading:
  - Do not depend on `testDir`, `filePattern`, or generic `.yaml` discovery for OpenAPI documents.
  - After normal suite file discovery, if `cfg.openapi` is set, resolve it relative to `projectRoot` and append the OpenAPI-generated suite to the in-memory suite list.
  - Missing or unreadable OpenAPI files are configuration errors and should fail fast before starting the server.
- Refactor loader plugin registration:
  - Store all `onLoad` callbacks with their filters instead of overwriting the previous callback.
  - `PluginHost.loadSuites(path)` should call only loaders whose filter matches the path, in registration order, and concatenate returned suites.
  - Add a way to call a loader for an explicit source type, for example `loadSuites(path, { source: 'openapi' })`. Use this for `cfg.openapi` so an OpenAPI `.yaml` file is not routed through the core Spectest YAML loader.
  - Preserve current Spectest file loading behavior for `.spectest.*` and `.suite.*` files.
- Add an OpenAPI loader:
  - Parse JSON/YAML OpenAPI 3.0 and 3.1 documents.
  - Validate the top-level `openapi` version and reject Swagger/OpenAPI 2.0.
  - Resolve local `$ref` references before generating tests.
  - Create one Spectest suite per OpenAPI document.
  - Create one test per operation and primary expected response.
  - Detect duplicate generated `operationId`s and fail the OpenAPI load with a clear error. Runtime dependency logic depends on unique operation IDs.

## Test Generation Behavior

- Test `name`: use `summary`, then `operationId`, then `METHOD path`.
- Test `operationId`: use OpenAPI `operationId`; otherwise use a stable slug from method/path. If the final ID collides with another generated or loaded test in the same run, fail fast rather than silently suffixing.
- Tags: include OpenAPI operation tags plus `openapi`.
- Endpoint and server:
  - Convert OpenAPI path templates like `/users/{id}` using examples/defaults.
  - Use `cfg.baseUrl` as the network base URL by default.
  - If the OpenAPI document has a single relative server URL, prefix generated endpoints with that server path.
  - If the document has an absolute server URL and `cfg.baseUrl` is absent, use that server URL as the effective base URL.
  - If multiple server choices exist and neither `cfg.baseUrl` nor `cfg.openapiServer` resolves the ambiguity, fail fast with a configuration error.
  - If an operation-level `servers` override is present and cannot be resolved by the same rules, skip only that operation with `skipReason`.
- Parameters:
  - Required `path`, `query`, `header`, and `cookie` parameters must have an `example`, a usable value under `examples`, or a `schema.default`.
  - Optional parameters are omitted unless they have an example/default.
  - Missing required parameter values generate `skip: true` with `skipReason`.
  - Query parameters are serialized only with the default OpenAPI style/explode behavior in v1. Non-default serialization styles generate skipped tests.
  - Header and cookie parameters are applied to the generated request headers.
- Request body:
  - Prefer `application/json` request bodies.
  - Use explicit media-type examples first, then schema examples, then schema defaults if the schema object itself has a default.
  - Required JSON request bodies without usable examples/defaults generate skipped tests.
  - Unsupported required body media types generate skipped tests. Optional unsupported bodies are omitted.
  - Do not synthesize arbitrary payloads from schemas in v1.
- Response:
  - Prefer the lowest documented `2xx` response with a supported `application/json` schema or example.
  - If no `2xx` response exists but `default` exists, generate a test without a concrete status assertion and attach the response schema if usable. This is weaker than a status-specific assertion and must be recorded in generated metadata.
  - If there is no usable response status, schema, or example, generate a skipped test with `skipReason`.
  - For `204` and `304`, assert status only and do not require a response body schema.
- Assertions:
  - Default assertions are response status plus JSON Schema validation when a usable response schema exists.
  - If only a response example exists, assert `response.json` from the example.
  - Non-JSON response validation is not supported in v1; status-only assertions are allowed when a concrete success status is present.

## JSON Schema Validation

- Current runner only accepts Zod-like `safeParse`; add support for JSON Schema through a small adapter.
- Use a proven validator dependency such as `ajv` plus `ajv-formats`.
- Keep Zod support unchanged.
- For OpenAPI 3.0:
  - Normalize `nullable: true` to include `null`.
  - Convert or ignore OpenAPI-only schema keywords that AJV cannot validate directly.
  - Treat unsupported constructs that affect validation correctness as skipped tests, not silently weakened validations.
- For OpenAPI 3.1:
  - Use AJV's JSON Schema 2020-12 support or a validator configuration that correctly handles the document dialect.
- Support `allOf`, `oneOf`, `anyOf`, enums, arrays, objects, primitive constraints, and local schema refs.
- Constraint: full OpenAPI discriminator semantics, `readOnly`/`writeOnly` request/response projections, circular schema refs, and external `$ref` resolution are not required for v1. If encountered and not safely handled, the generated test should be skipped with a clear reason.

## Auth Integration

- Security schemes are never guessed.
- Add a request mutation hook rather than a headers-only hook:

  ```ts
  type OpenApiRequestMutator = (ctx: {
    schemeName: string;
    scheme: unknown;
    operation: unknown;
    method: string;
    path: string;
  }) => Promise<{
    headers?: HeadersInit;
    query?: Record<string, string>;
    cookies?: Record<string, string>;
  } | void> | {
    headers?: HeadersInit;
    query?: Record<string, string>;
    cookies?: Record<string, string>;
  } | void;
  ```

- The loader should understand whether a security requirement object means alternative schemes or combined schemes.
- If an operation requires security and no complete matching hook exists, generate the test as skipped with `skipReason`.
- Constraint: OAuth2/OpenID token acquisition flows are not implemented in v1. Users must provide ready-to-use credentials through config hooks.

## Skipped Tests And Reporting

- Add `skipReason?: string` to generated `TestCase` metadata.
- Add `skipReason?: string` or `error?: string` propagation to skipped `TestResult`s.
- Console reporting should show skip reasons when `testOutput === 'errors'` or `verbose` is enabled.
- Main OpenAPI skip reasons:
  - missing required path/query/header/cookie parameter example/default
  - missing required request body example/default
  - unsupported parameter serialization style
  - unsupported required request or response media type
  - missing auth hook
  - unsupported schema construct
  - external or unresolved `$ref`
  - unsupported operation-level server override
  - no usable response assertion
- Constraint: skipped tests currently do not fail the process. Preserve that default for v1, but record enough metadata to support a future `--fail-on-openapi-skips` flag.

## Implementation Notes

- Keep OpenAPI discovery explicit through `--openapi`; do not include generic `.yaml` OpenAPI detection in `filePattern`, because YAML is already a Spectest format.
- Keep generated OpenAPI tests in memory for v1. Do not write `.spectest` files as part of direct runs.
- Keep the conversion function pure where possible: `openApiOperationToTest(operation, context) -> TestCase`.
- Keep the parser/resolver separate from the operation mapper so future generated-file workflows can reuse the mapper.
- Do not support Swagger/OpenAPI 2.0 in v1.
- Do not support OpenAPI callbacks or webhooks in v1; ignore them with a documented warning.
- Document the new CLI flag, config fields, skipped-test behavior, and v1 constraints in the README.

## Test Plan

- Unit: parses OpenAPI 3.0 JSON, OpenAPI 3.0 YAML, and OpenAPI 3.1 YAML.
- Unit: rejects Swagger/OpenAPI 2.0 and invalid top-level OpenAPI documents.
- Unit: resolves local `$ref` in request and response schemas.
- Unit: reports external or unresolved `$ref` as skipped tests or load errors according to the rule above.
- Unit: converts operation metadata into stable Spectest `name`, `operationId`, `endpoint`, `request`, `response`, tags, and `skipReason`.
- Unit: fails on duplicate generated `operationId`s.
- Unit: handles server selection for no servers, one relative server, one absolute server, multiple servers with explicit selection, and ambiguous multiple servers.
- Unit: serializes required path/query/header/cookie parameters from examples/defaults.
- Unit: skips operations with unresolved required params, missing required request body examples, missing auth hooks, unsupported media types, unsupported parameter styles, or no usable response.
- Unit: validates response bodies through JSON Schema adapter, including OpenAPI 3.0 `nullable` and OpenAPI 3.1 dialect handling.
- Unit: preserves Zod schema validation behavior for existing Spectest suites.
- Unit: creates skipped results with skip reasons.
- Integration: `node dist/cli.js --openapi ./examples/openapi/petstore.yaml --base-url <server>` runs generated tests through the normal runner without requiring `testDir` discovery.
- Integration: `--tags`, `--filter`, and `--happy` apply to OpenAPI-generated tests.
- Integration: auth hook can add headers, query params, and cookies.
- Regression: existing `.spectest.js`, `.spectest.json`, and `.spectest.yaml` suites still load and run unchanged.

## Assumptions And Constraints

- OpenAPI 3.0 and 3.1 are the only supported contract versions for v1.
- `--openapi <path>` is the primary user-facing workflow.
- Missing examples/defaults produce skipped tests, not synthetic data.
- Default assertions are response status plus response schema where available.
- Auth is provided by user config hooks, never inferred.
- External `$ref`, callbacks, webhooks, non-default parameter serialization, full discriminator semantics, OAuth2/OpenID acquisition, and generated `.spectest` output are out of scope for v1.
- Generated `.spectest` files may be added later as a scaffold/export command using the same mapper.
