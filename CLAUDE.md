# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spectest is a declarative API testing CLI (`npx spectest`). Test suites are `*.spectest.{js,mjs,cjs,json,yaml}` files exporting request/response fixtures; the CLI loads them, optionally starts the SUT server, executes tests with dependency-aware scheduling, and reports results. It also has first-class OpenAPI 3.0/3.1 support: it can generate and run tests directly from a spec.

## Commands

- Build: `npm run build` (esbuild, non-minified) or `npm run build:prod` (minified). Bundles `src/cli.ts`, `src/helpers.ts`, `src/recordings.ts`, `src/recording-preload.ts` into `dist/` as ESM, `--packages=external`.
- Integration/self-test: `npm test` — builds, then runs the built CLI against `https://jsonplaceholder.typicode.com` using the suites under `test/`. This is the project's own dogfood run, not a mocked test suite.
- Unit tests: `npm run test:unit` — runs `test/*.test.ts` directly with `node --test`, using `test/support/resolve-ts-hooks.mjs` (a `node:module` register hook) to execute TypeScript without a separate compile step.
- Run a single unit test file: `node --import ./test/support/resolve-ts.mjs --test test/openapi-loader.test.ts`
- Run the CLI locally against a project: `node dist/cli.js --base-url=<url> [suiteFile]` (rebuild first if `src/` changed).
- `npx spectest generate openapi-tests --openapi <path> --output <dir>` scaffolds editable `.spectest.js` files from an OpenAPI doc.

There is no lint script and no `.ts` support for user-authored test files (only `.js`/`.mjs`/`.cjs`/`.json`/`.yaml`).

## Architecture

### Plugin pipeline (`plugin-api.ts`, `plugin-host.ts`)

The runner (`cli.ts`) is a thin orchestrator around a `PluginHost` that wires together lifecycle hooks:

- `onLoad({filter, source}, cb)` — registers a suite loader. Loaders are matched either by `source` (e.g. `'openapi'`, used explicitly by `cli.ts` for `cfg.openapi`) or by a filename regex (`filePattern`, used for on-disk suite files).
- `onPrepare(cb)` — transforms/filters the full suite list after loading, before execution (tag filtering, `happy`, `randomize`, snapshot-based `--filter=failures`, etc. live here).
- `onFetch(cb)` — transforms the outbound `Request` before it's sent.
- `onRunStart`/`onRunEnd`/`onTestStart`/`onTestEnd` — reporting hooks (console output, coverage bookkeeping).

Built-in plugins registered in `runAllTests` (`cli.ts`): `coreLoaderPlugin` (loads `.spectest.*` files), `openApiLoaderPlugin` (loads/generates tests from an OpenAPI doc), `coreFilterPlugin` (tag/happy/randomize/smart-filter logic), `consoleReporterPlugin` (progress + summary output). New cross-cutting behavior should generally be added as another plugin rather than inline in `cli.ts`.

### Execution model (`cli.ts: runAllTests`)

Tests run in three phases — `setup` → `main` → `teardown` — each a separate dependency-scheduled wave. Within a phase, tests form a DAG via `operationId`/`dependsOn`: a test is scheduled once all its dependencies have resolved as `passed`, tests run concurrently by default (rate-limited by `RateLimiter`, keyed on `rps`), and a failed/skipped dependency cascades to `failed-precondition` for dependents. `operationId`s must be globally unique across hand-written and OpenAPI-generated tests (`validateUniqueOperationIds`) — this is what lets a hand-written suite's `dependsOn` target a spec-generated operation.

`testState.completedCases[operationId]` accumulates passed results and is the mechanism for chaining requests (`beforeSend`/`postTest` read/write it — see README "Testing multi-step flows"). `SIGINT` triggers a graceful cancellation via `AbortController`, synthesizing `cancelled` results for anything in flight rather than hard-exiting.

### OpenAPI loading (`plugins/openapi-loader.ts`, ~960 lines — the largest module)

Turns spec operations into `TestCase`s without writing files. Key behaviors to know before touching this file:
- Resolves parameter/body values from `examples` maps (one generated test per example key, `operationId` becomes `${operationId}+${exampleKey}`) or falls back to schema defaults; anything it can't resolve becomes a skipped test with a `skipReason` (never a crash).
- Reads the `x-spectest` vendor extension (operation-level, overridable per-example) for `status`, `tags`, `skip`, `phase`, `dependsOn`, `beforeSend`/`postTest` (resolved against `cfg.openapiHooks`), `security` (resolved against `cfg.openapiAuth`), and `generate` (dynamic `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` values).
- Auto-derives `dependsOn` + a `beforeSend` from native OpenAPI `responses.<status>.links` when a linked operationId resolves unambiguously to one generated test.
- A missing `openapiHooks`/`openapiAuth` lookup degrades to a skipped test with a reason — this loader must never throw on a spec it can't fully resolve.

### Response validation (`cli.ts: runTest` / `validateWithSchema`)

A test's `response.schema` can be either a Zod schema (`.safeParse`) or a JSON Schema wrapped as `{ __spectestJsonSchema: true, schema, openapiVersion }`. `normalizeOpenApiSchema` strips OpenAPI-only schema keywords (`nullable`, `example`, `discriminator`, etc.) and rewrites `nullable: true` into `type: [..., 'null']`/`anyOf` before handing off to Ajv (`Ajv2020` for 3.1 docs, `Ajv` for 3.0).

### HTTP recording (`recording-cassette.ts`, `recording-preload.ts`, `recordings.ts`, `server.ts`)

Record/replay only applies to *outbound* calls made by the SUT server process, not to Spectest's own requests to the SUT. It works by starting the server with a `--import` preload (`recording-preload.ts`, via `@mswjs/interceptors`) that intercepts `fetch`/`http`/`https`/common libs and reads/writes a JSON cassette (`recording-cassette.ts`). Because instrumentation requires controlling process startup, recording is incompatible with `runningServer: 'reuse'` — Spectest must be the one spawning the server. `recordings.ts` exports `useHttpRecordings` as a framework-agnostic helper for plain Node test runners (not just Spectest suites) — see `package.json` `exports["./recordings"]`.

### Config resolution (`config.ts`)

Layering order: `default.config.ts` → `spectest.config.js` in `projectRoot` → `--config <file>` → CLI flags (highest precedence). Each enum-like option (`recording`, `runningServer`, `testOutput`, `missingRecordingBehavior`) has both a CLI-parse-time validator and a post-merge `validateConfigured*` assertion, since a value can arrive from either CLI args or a config file. `cfg.projectRoot` anchors relative-path resolution for `recordingFile`, `openapi`, `coverageReportFile`, and `testDir`.

### Batch helpers (`helpers.ts`, exported as `spectest/helpers`)

Thin functional helpers (`focus`, `delay`, `recording`, etc.) that map a property onto every test case in an array — exist purely to avoid repeating the same field across a large hand-written suite (see README "Working with large test suites").
