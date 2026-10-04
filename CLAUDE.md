# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spectest is a declarative API testing CLI (`npx spectest`). Test suites are `*.spectest.{js,mjs,cjs,json,yaml}` files exporting request/response fixtures; the CLI loads them, optionally starts the SUT server, executes tests with dependency-aware scheduling, and reports results. It also has first-class OpenAPI 3.0/3.1 support (generate and run tests directly from a spec) and first-class Arazzo 1.0/1.1 support (run multi-step workflow documents, `*.arazzo.{yaml,yml,json}`).

## Commands

- Build: `npm run build` (esbuild, non-minified) or `npm run build:prod` (minified). Bundles `src/cli.ts`, `src/helpers.ts`, `src/recordings.ts`, `src/arazzo.ts`, `src/recording-preload.ts`, `src/throttle-preload.ts` into `dist/` as ESM, `--packages=external`.
- Integration/self-test: `npm test` — builds, then runs the built CLI against `https://jsonplaceholder.typicode.com` using the suites under `test/`. This is the project's own dogfood run, not a mocked test suite.
- Unit tests: `npm run test:unit` — runs `test/*.test.ts` directly with `node --test --test-concurrency=1`, using `test/support/resolve-ts-hooks.mjs` (a `node:module` register hook) to execute TypeScript without a separate compile step. Files run serially on purpose: the end-to-end tests spawn the real CLI (`test/support/harness.ts`: `runCli`, `startMockServer`, `parseResults`), and the timing-sensitive server tests (fixed port 8080) flake under that load.
- Run a single unit test file: `node --import ./test/support/resolve-ts.mjs --test test/openapi-loader.test.ts`
- Run the CLI locally against a project: `node dist/cli.js --base-url=<url> [suiteFile]` (rebuild first if `src/` changed).
- `npx spectest generate openapi-tests --openapi <path> --output <dir>` scaffolds editable `.spectest.js` files from an OpenAPI doc; `generate arazzo-tests --arazzo <path> --output <dir>` does the same for an Arazzo doc (the scaffold calls `spectest/arazzo` at run time).

There is no lint script and no `.ts` support for user-authored test files (only `.js`/`.mjs`/`.cjs`/`.json`/`.yaml`, plus `*.arazzo.{yaml,yml,json}` documents).

## Architecture

### Plugin pipeline (`plugin-api.ts`, `plugin-host.ts`)

The runner (`cli.ts`) is a thin orchestrator around a `PluginHost` that wires together lifecycle hooks:

- `onLoad({filter, source}, cb)` — registers a suite loader. Loaders are matched either by `source` (e.g. `'openapi'`, used explicitly by `cli.ts` for `cfg.openapi`) or by a filename regex (`filePattern`, used for on-disk suite files).
- `onPrepare(cb)` — transforms/filters the full suite list after loading, before execution (tag filtering, `happy`, `randomize`, snapshot-based `--filter=failures`, etc. live here).
- `onFetch(cb)` — transforms the outbound `Request` before it's sent.
- `onRunStart`/`onRunEnd`/`onTestStart`/`onTestEnd` — reporting hooks (console output, coverage bookkeeping).

Built-in plugins registered in `runAllTests` (`cli.ts`): `coreLoaderPlugin` (loads `.spectest.*` files), `openApiLoaderPlugin` (loads/generates tests from an OpenAPI doc), `arazzoLoaderPlugin` (compiles Arazzo docs, `source: 'arazzo'`), `coreFilterPlugin` (tag/happy/randomize/smart-filter logic, `--workflow`, and pulling in the rest of an Arazzo workflow when one step is selected), `consoleReporterPlugin` (progress + summary output). New cross-cutting behavior should generally be added as another plugin rather than inline in `cli.ts`.

### Execution model (`cli.ts: runAllTests`)

Tests run in three phases — `setup` → `main` → `teardown` — each a separate dependency-scheduled wave. Within a phase, tests form a DAG via `operationId`/`dependsOn`: a test is scheduled once all its dependencies have resolved as `passed`, tests run concurrently by default (rate-limited by `RateLimiter`, keyed on `rps`), and a failed/skipped dependency cascades to `failed-precondition` for dependents. `operationId`s must be globally unique across hand-written and OpenAPI-generated tests (`validateUniqueOperationIds`) — this is what lets a hand-written suite's `dependsOn` target a spec-generated operation.

Generic test-case primitives the runner supports (used heavily by the Arazzo compiler, but available to any suite): `assert` (extra assertions that keep the response; can add a `note`, request a retry, or set `data` for virtual tests), `retry` (`{ limit, delayMs, shouldRetry }`, wraps `runAttempt`), `when` (evaluated in `schedule()`; a false/`{ skip }` result is a *pass-through* skip that releases dependents instead of cascading failure), `virtual` (no HTTP request), `quiet` (hidden from results unless it ran), and `source` (provenance metadata). Hooks get state via `cloneStateForHook`, which turns stored `Headers` into plain objects.

`testState.completedCases[operationId]` accumulates passed results and is the mechanism for chaining requests (`beforeSend`/`postTest` read/write it — see README "Testing multi-step flows"). `SIGINT` triggers a graceful cancellation via `AbortController`, synthesizing `cancelled` results for anything in flight rather than hard-exiting.

### OpenAPI loading (`plugins/openapi-loader.ts`, ~960 lines — the largest module)

Turns spec operations into `TestCase`s without writing files. Key behaviors to know before touching this file:
- Resolves parameter/body values from `examples` maps (one generated test per example key, `operationId` becomes `${operationId}+${exampleKey}`) or falls back to schema defaults; anything it can't resolve becomes a skipped test with a `skipReason` (never a crash).
- Reads the `x-spectest` vendor extension (operation-level, overridable per-example) for `status`, `tags`, `skip`, `phase`, `dependsOn`, `beforeSend`/`postTest` (resolved against `cfg.openapiHooks`), `security` (resolved against `cfg.openapiAuth`), and `generate` (dynamic `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` values).
- Auto-derives `dependsOn` + a `beforeSend` from native OpenAPI `responses.<status>.links` when a linked operationId resolves unambiguously to one generated test.
- A missing `openapiHooks`/`openapiAuth` lookup degrades to a skipped test with a reason — this loader must never throw on a spec it can't fully resolve.

### Arazzo (`src/arazzo/`, `plugins/arazzo-loader.ts`)

Arazzo documents compile into ordinary `TestCase`s; there is no separate workflow runtime in the scheduler.
- `document.ts` loads a document and its `sourceDescriptions` (local, `http(s)`, nested `type: arazzo`; cyclic references are safe through the shared `DocumentCache`), validating against the vendored official schemas in `schemas.ts`. Only "not Arazzo at all" throws; source problems become per-source `error`s.
- `model.ts` normalizes workflows and steps (reusable components resolved, workflow-level parameters and actions merged, `operationId`/`operationPath`/`workflowId` resolved). Static problems land on `step.error`.
- `compile.ts` emits one linear `dependsOn` chain per top-level workflow: the step nodes for iteration 1, then goto/retry-workflow *blocks*, then further iterations only if the workflow can jump backwards (`needsIterations`), then a virtual terminal node (`operationId` = workflowId) whose result data is the workflow outputs. Workflow steps inline the child workflow's nodes followed by a virtual *join* node. Any static error makes the whole workflow emit skipped nodes with the same ids (`emitSkipped`). Nested and later-iteration nodes are `quiet`.
- `runtime.ts` implements the semantics behind those hooks. Each *scope* (one execution of a workflow) keeps a `FlowState` cursor in `state.__arazzo[scopeId]`; `gateStep` (`when`) runs a node only when the cursor is on it, and `decideStep` (`assert`) evaluates criteria and the OpenAPI contract check, stores outputs in `state.__arazzoOutputs[nodeId]`, and applies success/failure actions by moving the cursor. Plain `retry` maps onto the core `retry` primitive; retry-with-target and backward `goto` move the cursor to a later iteration.
- `criteria.ts` (simple-condition Pratt parser, regex, JSONPath, XPath) and `selectors.ts` (json-p3 / jsonpath-plus / fontoxpath / xpath, the last two lazily imported) are shared by criteria, Selector Objects and payload replacements. `src/runtime-expression.ts` is the single runtime-expression parser for both OpenAPI links and Arazzo.
- Fixtures: `test/fixtures/arazzo/` (`shop.openapi.yaml` + `test/support/shop-server.ts` mock, feature docs, official examples and the official schema suite). CLI discovery skips `fixtures/` and `node_modules/` sub-directories of `testDir`.

### Response validation (`cli.ts: runTest` / `validateWithSchema`)

A test's `response.schema` can be either a Zod schema (`.safeParse`) or a raw JSON Schema / OpenAPI 3.0/3.1 Schema Object — no wrapper needed, `.safeParse` presence is the only discriminator. All non-Zod schemas compile under a single module-scope `Ajv2020` instance. `normalizeOpenApiSchema` strips OpenAPI-only schema keywords (`nullable`, `example`, `discriminator`, etc.), rewrites `nullable: true` into `type: [..., 'null']`/`anyOf`, and converts OpenAPI 3.0's boolean-style `exclusiveMinimum`/`exclusiveMaximum` into 2020-12's numeric form, before handing off to Ajv.

### HTTP recording (`recording-cassette.ts`, `recording-preload.ts`, `recordings.ts`, `server.ts`)

Record/replay only applies to *outbound* calls made by the SUT server process, not to Spectest's own requests to the SUT. It works by starting the server with a `--import` preload (`recording-preload.ts`, via `@mswjs/interceptors`) that intercepts `fetch`/`http`/`https`/common libs and reads/writes a JSON cassette (`recording-cassette.ts`). Because instrumentation requires controlling process startup, recording is incompatible with `runningServer: 'reuse'` — Spectest must be the one spawning the server. `recordings.ts` exports `useHttpRecordings` as a framework-agnostic helper for plain Node test runners (not just Spectest suites) — see `package.json` `exports["./recordings"]`.

### Config resolution (`config.ts`)

Layering order: `default.config.ts` → `spectest.config.js` in `projectRoot` → `--config <file>` → CLI flags (highest precedence). Each enum-like option (`recording`, `runningServer`, `testOutput`, `missingRecordingBehavior`) has both a CLI-parse-time validator and a post-merge `validateConfigured*` assertion, since a value can arrive from either CLI args or a config file. `cfg.projectRoot` anchors relative-path resolution for `recordingFile`, `openapi`, `coverageReportFile`, and `testDir`.

### Batch helpers (`helpers.ts`, exported as `spectest/helpers`)

Thin functional helpers (`focus`, `delay`, `recording`, etc.) that map a property onto every test case in an array — exist purely to avoid repeating the same field across a large hand-written suite (see README "Working with large test suites").
