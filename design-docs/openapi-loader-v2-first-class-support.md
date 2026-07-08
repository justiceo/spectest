# OpenAPI Loader v2: First-Class Support

## Summary

`openapi-to-spectest-loader-plan.md` (implemented, see `src/plugins/openapi-loader.ts`) generates exactly one static, single-example test per operation. That's sufficient for read-only/happy-path contract checks, but it can't absorb the two hardest categories of hand-written Spectest suites seen in real projects (e.g. `ngdomain-server`): dense negative/validation matrices (many examples per operation, each expecting a different error status) and stateful multi-step flows with real side effects (payment gateway calls, log-scraped tokens, chained state).

This doc proposes the changes needed to close that gap, so that "migrate most/all tests to the spec" becomes achievable rather than aspirational. Everything here is either a standard OpenAPI construct (`examples`, `links`) or a single new vendor extension (`x-spectest`) — no new file format, and the v1 principle of "no synthetic data without an explicit example" is preserved.

Reverse generation (building an OpenAPI spec from existing Spectests) is explicitly **not** revisited here — see `archive/openapi-generation-from-spectests.md` for why that direction was rejected. This doc only strengthens the OpenAPI → Spectest direction.

## Prior Art

Evaluated as alternatives to building this in Spectest, before committing engineering time:

- **Dredd** — validates an implementation against literal examples in an API Blueprint/OpenAPI doc, with multi-language hooks for setup/teardown. Closest in spirit to Spectest's v1 loader. Ruled out: the `apiaryio/dredd` repo is **archived** (confirmed via `gh api repos/apiaryio/dredd` — `archived: true`, last push 2024-05-11, 260 open issues). No negative/fuzz testing, no stateful chaining, and no further fixes are coming.
- **Schemathesis** — Python/Hypothesis-based property-based testing. MIT-licensed and actively released (v4.22.3, 2026-07-02). It already does, automatically and without hand-written examples, a chunk of what #2/#5/#6 below propose: mutation-based negative data generation (13+ mutation types) straight from schema constraints, and deliberate auth stripping/corruption to verify 401/403. It also supports stateful chaining via OpenAPI `links`, schema analysis, and `Location` headers. **Where it doesn't fit**: it's a separate Python ecosystem (hooks, CI, dependency chain) bolted onto a Node/TypeScript stack; its fuzzed negative cases are structural/schema-conformance checks, not the curated business-rule negatives real projects need (e.g. "google.com is already registered → 500" isn't a schema violation, it's domain state); and it doesn't orchestrate real side-effecting flows (payment gateway sandboxes, log-scraped tokens) any more natively than Spectest does — that still needs a hook, just written in Python instead of JS. Conclusion: worth piloting as a complementary structural/auth-negative fuzz layer once a spec exists, but it doesn't reduce the need for #3/#4 (named hooks for real side effects), and it *does* argue for keeping #2 scoped to business-rule examples rather than trying to hand-author exhaustive structural negative cases in the spec — Schemathesis-style fuzzing covers that ground better.
- **StepCI** — YAML/JSON workflow tool with native `captures` (pull a value from one step's response into a later step, no JS needed) plus a `plugin-openapi` that generates steps from an OpenAPI spec's examples. Architecturally the closest existing match to "OpenAPI-driven generation + native chaining in one coherent tool," and validates the `links`-based chaining approach in #7 as a proven shape. Ruled out on maintenance grounds: not archived, but `stepci/stepci` last pushed 2024-08-03 with its last release (2.8.2) on 2024-06-10, and `stepci/plugin-openapi` last pushed 2024-03-01 — roughly two years of no activity as of 2026-07, which is a worse signal than Dredd's honest archival for something meant to sit in CI.
- **Net takeaway**: no maintained, JS-native tool combines OpenAPI-driven test generation with first-class support for real stateful side effects the way Spectest already does for hand-written suites. That's the actual gap this doc closes; #1-#10 below are additive to that base rather than a reinvention of what these tools already do well.

## Design Goals / Non-Goals

- Goal: represent validation matrices, simple chained flows, and auth-negative cases directly from the spec.
- Goal: keep OpenAPI authoritative; extend via standard constructs first, one vendor extension second.
- Non-goal: synthesizing request payloads from schema alone. Still explicit examples/generators.
- Non-goal: OAuth2/OpenID acquisition flows (unchanged from v1).
- Non-goal: spec-from-tests generation (rejected direction; not reopened).

## Key Changes

### 1. Multiple examples per operation → multiple generated tests

Today `firstExample()` (`openapi-loader.ts:95-101`) reads only the first key of an `examples` map. Change `operationToTest` to iterate every entry (falling back to today's single-`example`/default behavior when no map exists) and emit one `TestCase` per entry.

Test identity: `operationId` becomes `${operationId}+${exampleKey}`, name becomes `${summary} — ${exampleKey}`. The existing `assertUniqueOperationIds` fail-fast still applies by construction. Applies uniformly to request body examples, parameter examples, and response examples.

### 2. Per-example expected response

v1's `chooseResponse` always picks the lowest documented `2xx` — correct for one happy-path example, wrong once an operation has many examples where most are meant to hit `400`/`404`/`500`.

Resolution order for a given request example:
1. `x-spectest.status` declared on that example (see #3).
2. A response example under a documented non-2xx status sharing the same key as the request example (e.g. request example `missingDomainName` pairs with the `400` response's `examples.missingDomainName`).
3. v1's existing lowest-2xx default.

This is the actual unlock for validation-matrix migration: one `register` operation documented with ~20 request `examples` (one per invalid-field variant) plus a `400` response schema can fully replace the ~20 hand-written cases currently in a file like `register.test.js`.

### 3. `x-spectest` vendor extension — single, documented escape hatch

Allowed on an operation, and on an individual entry inside an `examples` map (example-level overrides operation-level):

```yaml
x-spectest:
  status: 400
  tags: [slow, real-backend]
  skip: true
  skipReason: "hits real registrar, run manually"
  phase: setup | main | teardown
  dependsOn: [operationId, "otherOperationId+exampleKey"]
  beforeSend: hookName        # looked up in cfg.openapiHooks
  postTest: hookName
  security: none | variantName   # see #6
  generate:                   # see #5
    orderId: uuid
    "product.domainName": uniqueDomain
```

An operation with no `x-spectest` behaves exactly as in v1. Deliberately one extension key, not several scattered `x-spectest-*` keys, so there's one place to look. (`response.schema.__spectestJsonSchema` stays an internal marker, not spec-facing.)

### 4. Named hook registry — the bridge to real side effects

Add `openapiHooks?: Record<string, { beforeSend?: OpenApiBeforeSendHook; postTest?: OpenApiPostTestHook }>` to `SpectestConfig`, resolved the same way `openapiAuth` already is.

`x-spectest.beforeSend`/`postTest` reference a key in this map; the loader attaches the resolved function to the generated `TestCase.beforeSend`/`postTest` exactly like a hand-written suite already does (`types.d.ts:49-51`) — no new execution mechanism, just a new way to attach the same fields from a spec.

This is what lets flows like `ngdomain-server`'s Paystack/Stripe execution and log-scraped one-time-token extraction (`tests/e2e/helpers/hooks.js`) move under the spec: the *spec* declares "these operations are chained, and this one needs `extractOneTimeTokenFromLogs` before send"; the *hook body* (real gateway calls, log regex, etc.) stays ordinary TS in `spectest.config.js`, unchanged in substance from today.

### 5. Dynamic example values for collision-prone tests

Add a small built-in generator set usable as a plain string in place of a literal example value: `"{{uuid}}"`, `"{{timestamp}}"`, `"{{shortId}}"`. Resolved once per generated `TestCase` at load time.

Add `x-spectest.generate` (path-keyed) as the alternative for object bodies, for authors who'd rather keep the example object literal and list which fields need freshness per run.

Covers the `uniqueDomain1`, `shortId()`, `Date.now()` patterns seen throughout `ngdomain-server`'s tests — they exist specifically so repeated runs don't collide with previously-registered domains/emails on a real registrar.

Out of scope: full schema-driven synthetic data for every property. Still an explicit, opt-in list, consistent with v1's "no synthetic data" default.

### 6. Explicit non-default auth cases

v1's `applySecurity` (`openapi-loader.ts:297-331`) skips a test outright if a hook for the required scheme isn't configured — there's no way to deliberately generate a test with missing/expired credentials to assert `401`/`403`.

Add `x-spectest.security: 'none'` to bypass security application for that example, or `x-spectest.security: '<variantName>'` to select an alternate entry from a per-scheme map (`openapiAuth.session = { valid: fn, expired: fn, missing: fn }`), so "expired session cookie → 401" becomes a spec-declared example instead of a hand-written test.

### 7. Native `links` for simple chaining (no vendor extension needed)

OpenAPI's `responses.<status>.links` object exists exactly for "take a value from this response and feed it into another operation" via runtime expressions like `$response.body#/orderId`.

Add link resolution: when operation B's parameter/body value is unresolved but an earlier operation A declares a `link` targeting B's `operationId` with a matching parameter name, auto-generate `dependsOn: [A]` for B and a generated `beforeSend` that reads `state.completedCases[A].response` at the link's JSON pointer.

Covers pure data-passing chains (register a domain, then fetch its invoice using the returned `orderId`) using the standard OpenAPI mechanism, no invented syntax. Flows needing a real external call in between (gateway charge, log scraping) still go through #4.

### 8. Contract coverage reporting

This is the direction already recorded as preferable in `archive/openapi-generation-from-spectests.md` ("produce contract coverage reports showing which OpenAPI operations, statuses, examples are exercised"), not yet built.

Add `spectest --openapi <path> --coverage-report [file]`: after a run, emit per-operation status — `generated & passed`, `generated & skipped (<reason>)`, `covered by hand-written test <operationId>` (requires #9 to cross-reference in one run), or `uncovered`. This is the concrete tool for answering "have we actually migrated most/all tests" instead of eyeballing file counts.

### 9. Allow one run to combine `openapi` + `testDir`

Today these are mutually exclusive run modes (README: "OpenAPI loading is explicit and does not depend on `testDir`"). Loosen this: when both are configured, load OpenAPI-generated suites first, then hand-written suites, into the same in-memory suite list before dependency resolution.

Unlocks: hand-written suites can `dependsOn` a spec-generated `operationId` (a stateful payment-flow suite depends on the generated `login` contract test instead of duplicating a login call), and #8's coverage report can cross-reference both sets in one invocation.

Risk: ordering/name collisions between generated and hand-written `operationId`s. Reuse `assertUniqueOperationIds` across the combined set; fail fast on collision, same as today.

### 10. `spectest generate openapi-tests --output <dir>` (materialize, optional)

Already anticipated in the v1 plan ("structure conversion code so a later `spectest generate openapi --output <dir>` command can reuse the same operation-to-test mapper"). Reuse `operationToTest` to write editable `.spectest.js` scaffolds instead of running in-memory, for teams who want a starting point for suites that will grow real `beforeSend`/`postTest` logic by hand. Lower priority than #1-#9 — a convenience/onboarding feature, not a coverage unlock, since anything expressible this way is already expressible via direct `--openapi` loading.

## Explicitly Not Doing

- Spec-from-tests generation — rejected, see `archive/openapi-generation-from-spectests.md`; nothing here reopens it.
- Full schema-driven synthetic payload generation — conflicts with v1's "no synthetic data" principle; #5 stays an explicit opt-in list.
- OAuth2/OpenID token acquisition — unchanged from v1, still a user-supplied hook.

## Suggested Sequencing

1. #1 + #2 (multi-example + per-example response) — unlocks the bulk of negative/validation-matrix migration on their own.
2. #3 + #4 (vendor extension + named hooks) — unlocks tagging/skip/phase/dependsOn from the spec, and the escape hatch for real side effects.
3. #6 (auth variants) + #5 (generators) — closes the remaining gap for auth-negative and collision-prone tests.
4. #7 (links) — nice-to-have chaining sugar once #4 already covers the hard cases.
5. #8 (coverage report) — do once #1-#4 exist, so there's something meaningful to report on.
6. #9 (combined run) and #10 (scaffold command) — DX polish, not coverage-blocking.

## Test Plan

- Unit: an operation with a 3-entry `examples` map (1 success + 2 negative) generates 3 distinct `operationId`s and correct expected statuses via #2's resolution order.
- Unit: `x-spectest.beforeSend`/`postTest` resolve to `cfg.openapiHooks` entries and are attached verbatim to the generated `TestCase`.
- Unit: a missing `openapiHooks` entry referenced by `x-spectest` fails the same way a missing `openapiAuth` hook does today (skip with reason), not a hard crash.
- Unit: `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` resolve to distinct values per generated test, stable within a single run for repeat/bombard.
- Unit: `x-spectest.security: none` bypasses `applySecurity`; a named variant selects the corresponding `openapiAuth` sub-hook.
- Unit: a response `links` entry produces correct `dependsOn` + value extraction against `state.completedCases`.
- Integration: combined `openapi` + `testDir` run in one process produces a single dependency graph; a hand-written suite's `dependsOn: ['login']` resolves against a spec-generated `login` operation.
- Integration: `--coverage-report` output lists every spec operation exactly once with one of the defined statuses.
- Regression: an operation with no `x-spectest` extension and a single `example` behaves identically to today's v1 output.
