# Arazzo: First-Class Support

## Status: implemented

All milestones (M0–M5) shipped; see `src/arazzo/`, `src/plugins/arazzo-loader.ts`, the README section "Running Arazzo workflows" (with its feature-support matrix) and `test/arazzo-*.test.ts`. Where the implementation departs from the plan below:

- **Arazzo 1.1 is supported too** (Selector Objects, `querystring` parameters, step `timeout`/`dependsOn`, action `parameters`, `$self`), alongside 1.0. AsyncAPI-based parts are reported as unsupported (skipped with a reason).
- **Backward `goto` is supported** (open decision 3). Instead of a separate executor, a workflow that can revisit a step is unrolled into numbered iterations of its chain, bounded by `maxIterations` (default 10). Nodes gate themselves on a per-scope flow cursor. Retry with a `stepId`/`workflowId` (call, then return) uses the same mechanism. Iterations that never run are hidden with `quiet`.
- **Core primitives**: `assert`, `retry` and `when` as planned, plus `virtual` (nodes without a request: sub-workflow joins and the per-workflow terminal node), `quiet`, async `when` and per-skip `quiet`. No "settled" dependency policy was needed. A failed sub-workflow is handed to the calling step's `onFailure` actions by having the child's failing step pass with a note while its scope records the failure. That happens only when the calling step has failure actions; otherwise the failure is reported normally.
- **Per-workflow terminal node** (`operationId` = workflowId): its result data holds the workflow outputs, which gives hand-written tests a stable `dependsOn` target.
- **Decisions taken**: (1) steps without `successCriteria` get the OpenAPI contract check (`arazzoResponseValidation: auto`); (2) failures handled by `onFailure` actions are reported as passed, with a note; (4) filter closure applies to Arazzo nodes only; (5) duplicate ids fail fast, and `x-spectest.idPrefix` namespaces a document.
- **Additions found during validation**: Arazzo steps don't follow redirects (a `3xx` is the operation's result); JSON text templates keep the type of a quoted single expression (the official BNPL example depends on it); a load-time warning for path/query parameters the operation doesn't declare; github `blob` URL rewriting; `$workflows.<id>.outputs` resolves to a retry/goto run of that workflow when there is one.
- `npm run test:unit` now runs files serially (`--test-concurrency=1`): the CLI-spawning end-to-end tests made the timing-sensitive server tests flaky.

## Summary

[Arazzo 1.0.1](https://github.com/OAI/Arazzo-Specification/blob/main/versions/1.0.1.md) (OpenAPI Initiative) is a declarative format for multi-step API workflows: an ordered list of steps, each pointing at an OpenAPI operation, with parameters, request bodies, `successCriteria`, `outputs`, and `onSuccess`/`onFailure` control flow. It is a description format with no runner of its own, so it needs an engine to execute it.

Spectest already has most of that engine:

| Arazzo | Spectest today |
|---|---|
| step → OpenAPI operation | `TestCase` with `endpoint`/`request`, resolved by `openapi-loader.ts` |
| step ordering, `workflow.dependsOn` | `dependsOn` DAG in `runAllTests` |
| `$steps.x.outputs.y`, `$response.body#/…` | `state.completedCases[opId]` + `resolveRuntimeExpression` (subset) |
| `successCriteria` | status/headers/json/schema assertions (no expression language) |
| `onFailure: retry` / `end` / `goto` | **missing** |

This doc proposes compiling each Arazzo workflow into ordinary `TestCase`s inside a new `arazzoLoaderPlugin`. Each step becomes one test, sequencing becomes `dependsOn`, and expressions become `beforeSend` plus a new `assert` hook. Three small, generic core primitives (`assert`, `retry`, `when`) fill the control-flow gap. All three are also useful in hand-written suites, so Arazzo does not get a separate runtime.

The result:
- Arazzo steps show up in reporting, filtering, snapshots, rate limiting, recording, and SIGINT cancellation exactly like any other test.
- Hand-written suites and OpenAPI-generated tests can `dependsOn` an Arazzo step, and the reverse also works.

## Design goals / non-goals

- Goal: run unmodified Arazzo 1.0.x documents. Any construct the loader can't support degrades to a **skipped test with a `skipReason`**, never a crash. This is the same contract `openapi-loader.ts` keeps.
- Goal: map onto the existing `TestCase` model. Every core change must be generic and useful to hand-written suites.
- Goal: one runtime-expression implementation, shared by OpenAPI `links` and Arazzo.
- Non-goal (initially): backward `goto` (loops), `xpath` criteria, remote (`https://`) source descriptions. See *Phasing* and *Open decisions*.
- Non-goal: generating Arazzo from Spectest suites (same reasoning as `archive/openapi-generation-from-spectests.md`).

## The mapping

### Identity

| Arazzo | `TestCase` field |
|---|---|
| `workflowId` + `stepId` | `operationId: "<workflowId>/<stepId>"`. Already globally unique-checked by `validateUniqueOperationIds`, so a hand-written suite can `dependsOn: ['checkout/confirmPayment']`. |
| `step.description` / `stepId` | `name: "<workflow summary or id> › <stepId>"` |
| document `info.title` | `suiteName` |
| — | `tags: ['arazzo', 'arazzo:<workflowId>', ...x-spectest.tags]` |
| — | `source: { kind: 'arazzo', workflowId, stepId, sourceOperationId, file }` (new optional metadata, see core change 4) |

### Request

- **`operationId` / `operationPath`**: resolve against the referenced `sourceDescriptions` OpenAPI document using the operation index `openapi-loader.ts` already builds (`buildOperationEntries`, `resolveRefs`, `effectiveServerPrefix`). That gives `endpoint` (path template plus server prefix) and `request.method`.
  - With more than one source, `$sourceDescriptions.<name>.<operationId>` is required by the spec.
  - `operationPath` is `{$sourceDescriptions.<name>.url}#/paths/~1pets~1{petId}/get`. Resolve the JSON pointer with the existing `resolvePointer`.
- **`parameters`**: workflow-level parameters are merged with step-level ones (the step wins, keyed by `name`+`in`), and `$components.parameters.*` references are expanded.
  - Values that are constants or depend only on `$inputs` are **baked at load time** into the endpoint, query, headers or cookies, so compiled tests stay inspectable and serializable (M5 scaffolding).
  - Values that reference `$steps`, `$workflows` or `$response` are deferred to a generated `beforeSend`, using the same patching logic as `applyPendingLinks`.
- **`requestBody`**: `payload` is deep-walked. Embedded `{$expr}` strings and whole-value expressions are evaluated, then each `replacements[]` entry (`target` JSON pointer → `value`) is applied with `setByJsonPointer`. `contentType` becomes the `content-type` header.
- **Auth**: Arazzo passes credentials explicitly (for example an `Authorization` header parameter fed from `$steps.login.outputs.token`). `openapiAuth` is therefore **not** applied by default. A step can opt in with `x-spectest.security` (see *Extensions*).

### Response, criteria, outputs

- **`successCriteria`** compile into the new `assert` hook (core change 1). Each criterion that fails contributes one error string, for example `criterion "$statusCode == 201" failed (got 400)`. All criteria must pass, per the spec.
  - `simple`: a small Pratt-parser evaluator for `== != < <= > >= ! && || ( ) [] .` over runtime expressions and literals. String comparison is case-insensitive per the spec.
  - `regex`: `new RegExp(condition).test(String(eval(context)))`.
  - `jsonpath`: evaluated against `eval(context)`, and passes if it returns a non-empty match set. RFC 9535 is the default; `draft-goessner-dispatch-jsonpath-00` is accepted via the `{type, version}` form.
  - `xpath`: skipped test with reason in phase 1.
- **No `successCriteria`**: see *Open decisions*. The recommendation is to validate the response body against the source OpenAPI response schema for the received status when one is documented. That is free contract checking and spectest's main value add over a bare Arazzo runner.
- **`outputs`** are **not** stored eagerly. `completedCases[opId]` already holds the step's full `TestResult` (sent request config plus response), so `$steps.login.outputs.token` resolves lazily: look up the step's output expression map, which is known at load time, and evaluate it against `completedCases['<wf>/login']`. This needs no new state and works across phases, because `completedCases` is run-global.
  - Workflow `outputs` (`$workflows.<id>.outputs.x`) resolve the same way, on top of step outputs.

### Sequencing and control flow

Defaults, per spec:
- `onSuccess` omitted → next sequential step.
- `onFailure` omitted → break and return, so the workflow fails.

| Arazzo construct | Compiles to | Needs |
|---|---|---|
| sequential steps | step *n* `dependsOn: [step n-1]` | nothing new; a failure cascades as `failed-precondition` (matches "break and return") |
| `workflow.dependsOn: [other]` | first step of this workflow `dependsOn` the terminal step(s) of `other` | nothing new |
| `onFailure: retry` (`retryAfter` seconds, `retryLimit`) | `TestCase.retry = { limit, delayMs, when? }` | core change 2 |
| `onSuccess: end` / `onFailure: end` (with optional `criteria`) | the step records a flow decision. Later steps in the workflow carry `when` and resolve to a pass-through `skipped` | core change 3 |
| forward `goto: stepId` | same mechanism: intermediate steps' `when` is false, so they pass through and the target runs | core change 3 |
| `goto: workflowId` | the target workflow's first step gets an extra gating `when`. The workflow runs only if some step routed to it | core change 3 |
| **backward `goto`** (loop) | unsupported in phases 1–3: the workflow loads as skipped with reason `backward goto not supported` | see *Open decisions* |
| step with `workflowId` (sub-workflow) | **inline expansion**: the child's steps are emitted as `<parent>/<step>/<childStep>`, with the step's `parameters` bound as the child's `$inputs` (per spec, parameters map to inputs). A recursion guard skips cycles | nothing new |
| `components.successActions` / `failureActions` references, workflow-level `successActions` / `failureActions` | merged into each step (the step overrides and cannot remove, per spec) | — |

The flow decision lives in run state under a reserved key, `state.__arazzo[<workflowId>] = { next: stepId | null }`. It is written by the step's `assert`/action evaluation and read by later steps' `when`. Because `when` runs in the scheduler and not inside `beforeSend`, a skipped step never touches the rate limiter or the network.

### Inputs

`$inputs.x` comes from, in order of precedence:
1. CLI `--arazzo-inputs <file.json>`, shaped `{ [workflowId]: { ... } }`
2. `cfg.arazzoInputs` in `spectest.config.js`, either a plain object or `(workflowId) => object`. This is how secrets get in, via `process.env`.
3. `default` / first of `examples` in the workflow's `inputs` JSON Schema.
4. `{{uuid}}` / `{{timestamp}}` / `{{shortId}}` generator placeholders, reusing `resolveGeneratorPlaceholders`.

Resolved inputs are validated against the workflow's `inputs` schema with the existing module-scope `Ajv2020` instance. A missing required input or a schema violation makes **every step of that workflow skipped** with a reason, for example `missing required input 'password' for workflow 'login'`.

### Phases

The runner builds `opIdMap` per phase (`cli.ts:runTests`), so a `dependsOn` that crosses phases is treated as an invalid dependency. A workflow is therefore placed in exactly one phase, `main` unless `x-spectest.phase` says otherwise. A `workflow.dependsOn` edge into an earlier phase is dropped at compile time, since phase ordering already guarantees it ran, and a failed setup already skips `main`.

## Example

```yaml
arazzo: 1.0.1
info: { title: Auth & checkout, version: 1.0.0 }
sourceDescriptions:
  - { name: api, url: ./openapi.yaml, type: openapi }
workflows:
  - workflowId: login
    inputs:
      type: object
      required: [email, password]
      properties: { email: { type: string }, password: { type: string } }
    steps:
      - stepId: getToken
        operationId: loginUser
        requestBody:
          contentType: application/json
          payload: { email: $inputs.email, password: $inputs.password }
        successCriteria: [{ condition: $statusCode == 200 }]
        outputs: { token: $response.body#/token }
    outputs: { token: $steps.getToken.outputs.token }

  - workflowId: checkout
    dependsOn: [login]
    steps:
      - stepId: createPayment
        operationId: createPaymentIntent
        parameters:
          - { name: Authorization, in: header, value: "Bearer {$workflows.login.outputs.token}" }
          - { name: Idempotency-Key, in: header, value: "{{uuid}}" }
        requestBody: { contentType: application/json, payload: { amount: 1000, currency: usd } }
        successCriteria: [{ condition: $statusCode == 201 }]
        outputs: { id: $response.body#/id }
      - stepId: pollStatus
        operationId: getPaymentIntent
        parameters:
          - { name: id, in: path, value: $steps.createPayment.outputs.id }
          - { name: Authorization, in: header, value: "Bearer {$workflows.login.outputs.token}" }
        successCriteria:
          - condition: $statusCode == 200 && $response.body#/status == 'succeeded'
        onFailure:
          - { name: wait, type: retry, retryAfter: 1, retryLimit: 10 }
```

It compiles to the following. This is shown for illustration; nothing is written to disk.

```js
[
  { name: 'login › getToken', operationId: 'login/getToken',
    endpoint: '/auth/login', request: { method: 'POST', headers: { 'content-type': 'application/json' },
    body: { email: 'me@example.com', password: '…' } },          // $inputs baked at load time
    assert: criteria(['$statusCode == 200']),
    source: { kind: 'arazzo', workflowId: 'login', stepId: 'getToken', sourceOperationId: 'loginUser' } },

  { name: 'checkout › createPayment', operationId: 'checkout/createPayment',
    dependsOn: ['login/getToken'],                                 // workflow.dependsOn → terminal step
    endpoint: '/payment_intents', request: { method: 'POST', /* … */ },
    beforeSend: resolveDeferred(/* Authorization from $workflows.login.outputs.token */),
    assert: criteria(['$statusCode == 201']) },

  { name: 'checkout › pollStatus', operationId: 'checkout/pollStatus',
    dependsOn: ['checkout/createPayment'],
    endpoint: '/payment_intents/{id}', request: { method: 'GET' },
    beforeSend: resolveDeferred(/* path id, Authorization */),
    assert: criteria([...]),
    retry: { limit: 10, delayMs: 1000 } },
]
```

## Core changes (generic, not Arazzo-specific)

Each is small, ships with unit tests, and gets a README entry in the hand-written-suite docs.

1. **`TestCase.assert?: (result, state) => string[] | void | Promise<…>`**. This runs after the built-in status/header/json/schema checks in `runTest`, and the returned strings are appended to `errors`. Today the only way to add custom assertions is to throw from `postTest`. That path lands in the `catch` and **discards the response** (`response: { status: 0, data: null }`), which makes reports useless. `assert` keeps the full result.
2. **`TestCase.retry?: { limit: number; delayMs?: number; when?: (result) => boolean }`**. When the assertions fail (or `when` returns true), the whole send/assert cycle is re-run, including `beforeSend` so deferred values are re-resolved. The loop uses `abortableDelay` (SIGINT-safe) and calls `rateLimiter.acquire` on every attempt. The final attempt's result is reported with a new `attempts` field. This directly fixes "poll until payment succeeded" in hand-written suites too.
3. **`TestCase.when?: (state) => boolean | { skip: true; reason: string }`, plus a pass-through skip**. `when` is evaluated in `schedule()` before `dispatchTestStart`. When it is false, the test resolves as `skipped` and, unlike any other non-pass status, **its dependents are released instead of cascaded**. The new rule in `schedule()` is: a result with `status === 'skipped' && passThrough` decrements dependents' `unresolvedDependencies`. `completedCases` is not written, so a later step that reads a skipped step's outputs fails with a clear "no completed result" error, which is correct. The phase-pass check (`phasePassed`) treats pass-through skips as success.
4. **`TestCase.source?: { kind: string; [k: string]: unknown }`**. This is optional provenance metadata. The console reporter uses it to group Arazzo steps under their workflow, and `coverage-report.ts` uses `sourceOperationId` to count Arazzo steps toward OpenAPI operation coverage.
5. **Discovery**: `runAllTests` also picks up `*.arazzo.{yaml,yml,json}` under `testDir`, alongside explicit `--arazzo <path>`, which is repeatable. These are routed to the plugin via `host.loadSuites(p, { source: 'arazzo' })`, mirroring how `cfg.openapi` is handled.
6. **Filter closure**: with `--tags`, `--filter` or `focus`, a selected Arazzo step today would lose its predecessors and become `failed-precondition` ("Invalid dependency"). `core-filter.ts` gains `includeDependencies(tests, selected)`, which pulls in the transitive `dependsOn` closure. It is enabled for tests with `source.kind === 'arazzo'`. Whether to make it universal is an open decision, since it is a behavior change for hand-written suites. A `--workflow <id>` flag is also added as sugar for `--tags arazzo:<id>`.

## Shared refactor (precedes everything else, no behavior change)

`openapi-loader.ts` is 1,341 lines, and Arazzo needs about a third of it. The plan is to extract the following without changing behavior:

- `src/openapi/document.ts`: `parseDocument`, `assertOpenApiDocument`, `resolvePointer`, `resolveRefs`, `buildOperationEntries` (or a leaner `indexOperations`), `effectiveServerPrefix`, `applySecurity`, `mergeCookieHeader`.
- `src/runtime-expression.ts`: a full parser for the Arazzo/OpenAPI runtime-expression ABNF covering `$url $method $statusCode $request.{header,query,path,body#} $response.{header,body#} $inputs $outputs $steps $workflows $sourceDescriptions $components`, plus `{$expr}` string templating. Spectest's own `$generated.*` / `$state.*` are kept as an extension namespace.
  - OpenAPI `links` move onto it and get `$url`, `$method`, `$statusCode` and `$request.query` for free.
  - The existing `$request.path` caveat (the URL is already substituted) is solved by having `runTest` keep the unexpanded path params on the result.

`test/openapi-loader.test.ts` is the regression net, and it must pass unchanged.

## New modules

```
src/arazzo/
  types.ts           Arazzo 1.0 TS types
  schema/arazzo-1.0.json   vendored official JSON Schema (validated with the existing Ajv2020)
  document.ts        parse, validate, resolve sourceDescriptions + $components, workflow/step merging
  criteria.ts        simple / regex / jsonpath evaluators
  compile.ts         workflow → TestCase[] (the mapping above; pure, unit-testable)
src/plugins/arazzo-loader.ts   onLoad({ filter: /\.arazzo\.(ya?ml|json)$/i, source: 'arazzo' })
test/arazzo-*.test.ts, test/fixtures/arazzo/
```

New dependency: one JSONPath library (RFC 9535, for example `jsonpath-rfc9535`, or `jsonpath-plus` if the Goessner draft must be bit-exact). Everything else, including YAML, Ajv and pointer helpers, is already present.

Config additions to `SpectestConfig` and `config.ts`:
- `arazzo?: string | string[]` and `arazzoInputs?: Record<string, Record<string, unknown>> | ((workflowId: string) => Record<string, unknown>)`
- `arazzoSources?: Record<string, string>`, which overrides a `sourceDescriptions[].url` by name. It is useful when the doc points at a published spec but you want the local copy. If it is unset and the doc has one OpenAPI source while `cfg.openapi` is set, `cfg.openapi` is used.
- CLI flags: `--arazzo`, `--arazzo-inputs`, `--workflow`.
- Each new option gets the parse-time and post-merge validator pair that `config.ts` uses for enum-like options.

### Extensions (`x-spectest` on workflows and steps)

Arazzo allows `x-` extensions, so the existing vendor key is reused rather than inventing a new one: `tags`, `skip`/`skipReason`, `phase` (workflow-level only), `timeout`, `delay`, `recording`, `security` (opt into `openapiAuth`), `beforeSend`/`postTest` (resolved against `cfg.openapiHooks`). These have the same semantics and the same "missing hook → skipped with reason" behavior as the OpenAPI loader.

## Phasing

Each milestone is an independently shippable PR.

| # | Scope | Covers |
|---|---|---|
| **M0** | Shared refactor: `openapi/document.ts`, `runtime-expression.ts` (no behavior change) | — |
| **M1** | Core: `assert` hook, `source` metadata, discovery + `--arazzo` / `--arazzo-inputs` / `arazzoSources` config | — |
| **M2** | Arazzo MVP: parse + validate, `operationId` / `operationPath`, parameters, requestBody + replacements, inputs, step / workflow outputs, `simple` + `regex` + `jsonpath` criteria, linear sequencing, `workflow.dependsOn`, `x-spectest`. Anything else → skipped with reason | login → token → protected call; most happy-path payment flows |
| **M3** | Core `retry` + `when` / pass-through skip; map `onFailure: retry`, `end`, forward `goto`, `goto: workflowId`, action `criteria`, component / workflow-level actions | payment status polling, early-exit branches |
| **M4** | Sub-workflow inline expansion, console grouping by workflow, coverage-report integration, filter closure + `--workflow` | reusable "login" workflow shared across flows |
| **M5** (optional) | `spectest generate arazzo-tests` (scaffold `.spectest.js` that calls a runtime helper exported as `spectest/arazzo`), remote `https://` sources, `xpath`, backward `goto` | — |

Dogfood: add `test/jsonplaceholder.arazzo.yaml` with a minimal companion OpenAPI doc (`GET /users/{id}` → `GET /posts?userId={$steps.getUser.outputs.id}` → criteria on the result), so `npm test` exercises the loader end to end.

## Test plan

- `compile.ts` is pure, so most coverage is table tests: Arazzo fixture in, expected `TestCase[]` out (ids, `dependsOn`, baked vs deferred values, skip reasons).
- `runtime-expression.ts` and `criteria.ts` get grammar-level unit tests, including the case-insensitive string comparison and `{$expr}` templating edge cases (escaped braces, multiple expressions per string).
- Core primitives get tests in the style of `test/server-startup-wait.test.ts`: retry + SIGINT, pass-through skip releasing dependents, `assert` preserving the response on failure.
- Never-throw contract: a fixture with every unsupported construct (`xpath`, backward `goto`, missing source, unknown `operationId`, cyclic sub-workflow) loads without throwing and yields skipped tests with specific reasons.
- Run the official Arazzo example documents (pet-store, the FAPI / OAuth examples in the spec repo) through `compile.ts` as a smoke test.

## Open decisions

1. **Steps with no `successCriteria`**: the spec gives no default. Options: (a) pass on any response; (b) assert 2xx; (c) validate against the source OpenAPI response schema for the received status, with no status assertion. **Recommend (c)**, with `x-spectest` / config to disable.
2. **Handled failures**: when `onFailure: goto/end` catches a failed step, report it as `passed` with a note (the workflow handled it), or as `failed` (the exit code turns red)? **Recommend `passed`** plus the failed criteria in the message, because the author declared that path as expected.
3. **Backward `goto`** (loops): leave it unsupported, or add a dedicated sequential workflow executor (one DAG node per workflow, which runs its steps as a state machine and emits per-step results)? `retry` covers the common polling case, so **recommend unsupported until someone needs it**. The executor is a significant core change and gives up the "steps are just TestCases" property.
4. **Filter closure scope**: Arazzo-only, or universal? Universal is arguably the correct behavior for hand-written `dependsOn` chains too, but it changes what `--tags` selects today.
5. **`operationId` format**: `<workflowId>/<stepId>` collides if two Arazzo docs reuse a `workflowId`. The duplicate check catches this and fails fast. An alternative is to prefix with the doc's file slug at the cost of uglier ids. **Recommend fail-fast**, plus an `x-spectest.idPrefix` escape hatch.
