# Unified Response Schema Validation (Drop `__spectestJsonSchema`, Standardize on Ajv2020)

## Summary

`response.schema` (`types.d.ts:9-10`) is documented as accepting "Zod or JSON schema" (`README.md:249`,
`README.md:364`), but that's only half true today: a hand-written suite can pass a Zod schema, and
`openapi-loader.ts` can internally produce a JSON Schema, but a human cannot pass a raw JSON/OpenAPI
schema object directly — it must be wrapped as `{ __spectestJsonSchema: true, schema, openapiVersion }`
(`openapi-loader.ts:817-822`), an internal marker never meant to be spec-facing
(`openapi-loader-v2-first-class-support.md:67`). The wrapper exists to carry one piece of information
past `validateWithSchema` (`cli.ts:633-645`): which Ajv draft to compile with, chosen from
`doc.openapi` (`3.0.x` → plain `Ajv`/draft-07, `3.1.x` → `Ajv2020`/2020-12, `cli.ts:650-652`).

This doc proposes dropping the wrapper and standardizing on a single `Ajv2020` instance for all
non-Zod schemas, regardless of source. Zod vs. JSON Schema discrimination falls out naturally from
`typeof schema.safeParse === 'function'`, which already works today and doesn't need a marker.
The only real behavioral gap this surfaces — OpenAPI 3.0's boolean-style `exclusiveMinimum`/
`exclusiveMaximum` vs. 2020-12's numeric form — gets fixed in `normalizeOpenApiSchema`, the same
place `nullable` is already normalized.

Net effect: `response.schema` becomes symmetric for hand-written and OpenAPI-generated tests — you
can paste an OpenAPI 3.0 or 3.1 Schema Object, or a plain JSON Schema object, directly into a
`.spectest.js` file and it validates exactly like the generated tests do, with no wrapper, no
version field, and no draft-selection logic anywhere.

## Background: current behavior

```ts
// cli.ts:633-645
function validateWithSchema(data, schema) {
  if (schema?.__spectestJsonSchema) {
    return validateWithJsonSchema(data, schema.schema, schema.openapiVersion);
  }
  if (typeof schema.safeParse !== 'function') {
    return { success: false, errors: ['response schema is not a valid zod schema'] };
  }
  const result = schema.safeParse(data);
  return { success: result.success, errors: result.success ? [] : result.error.issues.map((i) => i.message) };
}

function validateWithJsonSchema(data, schema, openapiVersion?: string) {
  const jsonSchema = normalizeOpenApiSchema(schema);
  const ajv = String(openapiVersion || '').startsWith('3.1.')
    ? new Ajv2020({ allErrors: true, strict: false })
    : new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(jsonSchema);
  // ...
}
```

```ts
// openapi-loader.ts:817-822
test.response!.schema = {
  __spectestJsonSchema: true,
  schema: response.schema,
  openapiVersion: doc.openapi,
};
```

`normalizeOpenApiSchema` (`cli.ts:668-708`) strips OpenAPI-only keywords (`nullable`, `example`,
`examples`, `discriminator`, `xml`, `externalDocs`, `deprecated`, `readOnly`, `writeOnly`) and
rewrites `nullable: true` into a `type` array or `anyOf` branch, so the resulting schema is valid
JSON Schema regardless of which Ajv instance compiles it.

`grep` confirms `__spectestJsonSchema` is written in exactly one place (`openapi-loader.ts:819`) and
read in exactly one place (`cli.ts:634`) — it has no other producers or consumers, and no test file
references it (`test/` has zero hits for `__spectestJsonSchema`, `validateWithSchema`, or
`normalizeOpenApiSchema`). This path is currently unexercised by the test suite.

## Problems

1. **README overpromises**: "Zod or JSON schema" (`README.md:249`) is only true for schemas the
   OpenAPI loader generates internally. A user copying a schema out of their own OpenAPI doc into a
   hand-written suite gets `'response schema is not a valid zod schema'` unless they know to
   reach for the undocumented internal wrapper.
2. **The wrapper's only payload is a draft selector**, not a schema-shape concern. Once the project
   commits to one JSON Schema dialect for validation, the wrapper has nothing left to carry.
3. **Latent 3.0 gap, independent of this change**: OpenAPI 3.0 schemas can use
   `{ minimum: 5, exclusiveMinimum: true }` (boolean form, inherited from JSON Schema Draft
   Wright-00/draft-4). Neither `Ajv` (draft-07) nor `Ajv2020` (2020-12) accept boolean
   `exclusiveMinimum`/`exclusiveMaximum` — both drafts moved to the numeric form in draft-06.
   `normalizeOpenApiSchema` doesn't convert this today, so any 3.0 doc using the boolean form
   already fails to compile under the *current* code, regardless of which Ajv instance is picked.
   This is a pre-existing bug this doc happens to be well-positioned to fix.

## Goals

- `response.schema` accepts a Zod schema, a raw JSON Schema object, or a raw OpenAPI 3.0/3.1 Schema
  Object, with no wrapper, in both hand-written and OpenAPI-generated tests.
- One Ajv instance/dialect (`Ajv2020`, JSON Schema 2020-12) for all non-Zod schema validation.
- Fix the boolean `exclusiveMinimum`/`exclusiveMaximum` gap as part of the same normalization pass
  that already handles `nullable`.
- No change to Zod validation behavior.

### Non-goals

- Supporting JSON Schema drafts older than 2020-12 for constructs that have no OpenAPI 3.0/3.1
  equivalent (e.g. draft ≤2019-09 tuple validation via array-form `items`). OpenAPI 3.0 doesn't
  support tuple `items` at all, and OpenAPI 3.1 schemas that need tuples already use `prefixItems`
  (native 2020-12), so this isn't a practical loss for OpenAPI-sourced schemas — only for someone
  hand-pasting an old-style JSON Schema tuple, which this project has no evidence of anyone doing.
- Auto-detecting or config-selecting a JSON Schema draft per schema. Considered and rejected — see
  Alternatives.
- Runtime/JSON-Schema-level validation of `x-spectest` or other vendor extensions — out of scope,
  unrelated to `response.schema`.

## Design

### 1. Collapse `validateWithSchema` to a single JSON Schema path

```ts
// cli.ts
const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv2020);

function validateWithSchema(data, schema) {
  if (typeof schema?.safeParse === 'function') {
    const result = schema.safeParse(data);
    return { success: result.success, errors: result.success ? [] : result.error.issues.map((i) => i.message) };
  }
  try {
    const validate = ajv2020.compile(normalizeOpenApiSchema(schema));
    const success = validate(data);
    return {
      success: Boolean(success),
      errors: success ? [] : (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message || 'failed validation'}`),
    };
  } catch (error) {
    return { success: false, errors: [error.message || 'invalid JSON schema'] };
  }
}
```

`validateWithJsonSchema` and the plain `Ajv` (draft-07) import/instance are removed;
`import Ajv from 'ajv'` (`cli.ts:5`) goes away, `Ajv2020` (`cli.ts:6`) stays as the only import.
The Zod check moves first since it's the cheaper/more specific test (a method-presence check vs. a
try/compile), and dropping straight to JSON Schema on anything without `.safeParse` is what makes
the wrapper unnecessary — no schema needs to *declare* which kind it is.

Hoisting `ajv2020` to module scope (compiled schemas aren't cached across calls today either way,
but the Ajv instance itself is stateless configuration) avoids re-constructing an `Ajv2020` instance
per test; this is a minor incidental cleanup, not required for correctness.

### 2. Fix the OpenAPI 3.0 boolean exclusive-bounds gap in `normalizeOpenApiSchema`

Add the same treatment `nullable` already gets (`cli.ts:694-705`):

```ts
if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') {
  result.exclusiveMinimum = schema.minimum;
  delete result.minimum;
} else if (schema.exclusiveMinimum === false) {
  delete result.exclusiveMinimum;
}
// mirror for exclusiveMaximum/maximum
```

Boolean `false` is dropped outright (2020-12 has no equivalent — absence already means "not
exclusive"). Numeric `exclusiveMinimum`/`exclusiveMaximum` (the 3.1-native and already-valid-2020-12
form) passes through the existing per-key copy loop unchanged.

### 3. `openapi-loader.ts`: emit the raw schema, no wrapper

```ts
// openapi-loader.ts:817-822, replacing the wrapper construction
if (response.schema) {
  test.response!.schema = response.schema;
}
```

`doc.openapi` is no longer threaded into the generated `TestCase` at all — nothing downstream needs
it anymore.

### 4. Docs: make the README claim true

- `types.d.ts:9`: `/** Zod schema, or a raw JSON Schema / OpenAPI Schema Object, to validate the response body */`.
- `README.md`: extend the existing Zod example section (`README.md:362-396`, "Making dynamic
  assertions") with a second example showing a raw schema object used directly, e.g.:

  ```js
  response: {
    status: 201,
    schema: {
      type: 'object',
      required: ['id', 'title'],
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
      },
    },
  },
  ```

  and a one-line note that OpenAPI 3.0/3.1 Schema Objects (`nullable`, `example`, boolean
  `exclusiveMinimum`, etc.) work unmodified — the same normalization the loader already applies to
  generated tests applies here too.
- `openapi-loader-v2-first-class-support.md:67`: the parenthetical "(`response.schema.__spectestJsonSchema`
  stays an internal marker, not spec-facing)" is superseded by this doc — the marker is removed
  entirely rather than staying internal-only.

## Backward compatibility

- **OpenAPI 3.1 generated tests**: no change in validation behavior — already compiled with
  `Ajv2020`.
- **OpenAPI 3.0 generated tests**: compiled with `Ajv2020` instead of draft-07 `Ajv`. Every
  keyword `normalizeOpenApiSchema` already touches (`nullable`, `example`, `examples`,
  `discriminator`, `xml`, `externalDocs`, `deprecated`, `readOnly`, `writeOnly`) is unaffected by
  draft choice — those are either stripped or rewritten before compilation either way. The one
  keyword pair that *did* depend on draft (`exclusiveMinimum`/`exclusiveMaximum` boolean form) is
  fixed by this doc rather than broken by it (see Problems #3) — net improvement, not a regression.
- **Hand-written suites using Zod**: unaffected — `.safeParse` detection is unchanged, just
  reordered to run first.
- **Hand-written suites using `__spectestJsonSchema` directly**: not a supported/documented API
  (confirmed zero references outside `openapi-loader.ts`/`cli.ts`), so no known consumer breaks.
  If anyone was relying on it, `{ schema: {...}, openapiVersion: '3.0.0' }.__spectestJsonSchema`
  would now fail Zod's `.safeParse` check and fall through to being compiled as JSON Schema itself
  (the wrapper shape isn't valid JSON Schema, so it would fail loudly at `ajv.compile`, not
  silently misvalidate) — a clear, debuggable failure rather than a silent behavior change.

## Tests

No existing coverage exercises this path (confirmed above), so this is net-new:

- `test/response-schema-validation.test.ts` (new, unit, `node --test`):
  - Zod schema still validates via `.safeParse` (pass and fail cases).
  - Raw JSON Schema object (no OpenAPI keywords) validates directly, no wrapper needed.
  - Raw OpenAPI 3.0-style schema with `nullable: true` validates a `null` field correctly
    (regression for existing `normalizeOpenApiSchema` behavior).
  - Raw OpenAPI 3.0-style schema with `{ minimum: 5, exclusiveMinimum: true }` correctly rejects
    `5` and accepts `6` (new coverage for Problem #3's fix).
  - A schema that is neither a Zod schema nor a compilable JSON Schema (e.g. `{ type: 'bogus' }`)
    returns `success: false` with a message, not a throw.
- `test/openapi-loader.test.ts`: extend/add a case asserting a generated test's `response.schema`
  equals the spec's raw schema object (no `__spectestJsonSchema`/`schema`/`openapiVersion`
  wrapper keys present).
- `npm test` (the dogfood run against `jsonplaceholder.typicode.com`) is the regression backstop
  for anything with a `response.schema` in `test/*.spectest.*` — should be unaffected since none of
  those schemas are known to use OpenAPI-3.0-only exclusive-bound syntax.

## Alternatives considered

- **Keep the wrapper, just document it as public API.** Rejected — once every schema compiles under
  the same Ajv instance, the wrapper carries no information (`openapiVersion` was its only field
  besides the schema itself); keeping it would just be ceremony around an unconditional branch.
- **Auto-sniff the draft per schema** (e.g. detect boolean `exclusiveMinimum` or absence of
  `prefixItems` to infer "this is a 3.0-style schema," discussed earlier in this conversation).
  Rejected in favor of a hard commitment to 2020-12: sniffing is a heuristic with edge cases
  (a schema with neither tell either way), whereas normalizing the one real divergence
  (`exclusiveMinimum`/`exclusiveMaximum`) at the source makes sniffing unnecessary rather than
  papering over it.
- **Config-level draft selection** (a `SpectestConfig` flag choosing draft-07 vs. 2020-12 globally).
  Rejected as premature — no evidence any consumer needs draft-07-specific behavior; adds a config
  surface for a distinction users shouldn't need to know exists.

## Assumptions

- No other file in this repo or its documented public surface (`README.md`, `package.json`
  `exports`) constructs or reads `__spectestJsonSchema` — verified by grep; this doc does not
  audit downstream/external consumers of `spectest` as a library beyond what's in this repo.
- OpenAPI 3.0 schemas in practice don't rely on other draft-4-era JSON Schema constructs beyond
  the keywords `normalizeOpenApiSchema` already strips and the exclusive-bounds pair this doc adds
  — not exhaustively audited against the full JSON Schema Draft Wright-00 spec, only against the
  keywords OpenAPI 3.0's Schema Object actually documents.
- The `ajv` npm package (`^8.20.0`, already a dependency) bundles `ajv/dist/2020.js`; no new
  dependency is introduced or removed by this change, only which of the two already-imported
  classes gets used.
