# Changelog

All notable changes to this project are documented in this file, dates are the date of the version-bump commit.

## 3.0.0

### Breaking changes
- **`response.schema` no longer needs (or accepts in the old form) the `__spectestJsonSchema` wrapper.** It now accepts either a Zod schema (detected via `.safeParse`) or a raw JSON Schema / OpenAPI 3.0/3.1 Schema Object directly. `normalizeOpenApiSchema` strips OpenAPI-only keywords and converts 3.0-style `exclusiveMinimum`/`exclusiveMaximum` before validating against a shared Ajv2020 instance. Suites using the old wrapper must pass the schema unwrapped.

### Added
- Negative testing and fuzz-testing support for OpenAPI-generated tests: new schema mutator generates invalid-input cases to verify the API rejects bad input, with coverage reporting.
- Outbound request throttling: rate-limit outbound calls made by the SUT server process via new config options.
- More reliable server startup: reworked start/wait logic with configurable timeouts and clearer failure modes for crash-on-boot, crash-on-signal, and slow-to-start servers.
- `credentials: include` support in generated suites, and generator placeholders are now refreshed on every `generate` run instead of being stale/cached.
- A single OpenAPI `example` is now promoted into the `examples` map so it benefits from per-example test generation the same way multi-example operations do.

---

## [2.3.1] — 2025-07-08 (commit `31d9c97`)
- Improved server-start reliability (config-level startup wait/health handling).

## [2.3.0] — 2025-07-08 (commit `61682fc`)
- Implemented outbound request throttling for the SUT server process.
- Added a project `CLAUDE.md` guidance file; updated the negative-testing design plan.

## [2.2.0] — 2025-07-08 (commit `4c3db37`)
- Improved OpenAPI support broadly: turning `examples` into individual generated tests, deriving `dependsOn`/`beforeSend` from `links`, and reading the `x-spectest` vendor extension.
- Added a `help` command to the CLI.

## [2.1.1] — 2026-07-06 (commit `ce63f20`)
- Config filters are now passed through to suite loaders (so loader-level filtering respects CLI/config filters).
- Fixed server stop to reliably kill the spawned server process.

## [2.1.0] — 2026-05-23 (commit `c525539`)
- Added OpenAPI spec loading support to the spectest loader (early version of first-class OpenAPI support).
- Added HTTP call recording/replay support for the SUT server process.
- Added `--test-output` format support and additional docs.
- Added Ctrl+C (SIGINT) handling for graceful cancellation of in-flight tests.
- Merged skipped-test handling into the normal execution flow.
- Test discovery now scans test directories recursively and reports the number of matching files found; nested suites use their relative path as a fallback name.

## [2.0.3] — 2025-11-25 (commit `3d7b1ec`)
- Fixed a rounding error in the progress bar rendering.

## [2.0.2] — 2025-11-24 (commit `2e43391`)
- Increased test timeout to 60s.

## [2.0.1] — 2025-11-24 (commit `978cde3`)
- `composePostTest` functions now execute sequentially instead of concurrently, fixing ordering issues for chained post-test hooks.

## [2.0.0] — 2025-11-19 (commit `63e5d3e`)
Major refactor release.
- Refactored the runner onto a plugin-first architecture (the basis of today's `PluginHost`/`onLoad`/`onPrepare`/`onFetch` pipeline).
- Refactored test execution into distinct phases (setup/main/teardown) with dependency-aware scheduling.
- Added a progress bar and reorganized the results summary by suite.
- Fixed response-body handling and header handling in the HTTP client.
- Fixed the `skip` implementation and included skipped tests in the summary/report.
- Auto-assigns an `operationId` to test cases that don't declare one.

## [1.1.0] — 2025-11-15 (commit `860e384`)
- Implemented `setup`/`teardown` at both the test-case and suite level.
- Replaced `axios` with Node's native `http` module for outbound requests, dropping a runtime dependency.

## [1.0.9] — 2025-11-01 (commit `5fc99ad`)
- Improved Zod validation error formatting for clearer failure output.

## [1.0.8] — 2025-08-18 (commit `72ac0d5`)
- Packaging/metadata update (`package.json`) — no functional changes.

## [1.0.7] — 2025-08-08 (commit `5fb5859`)
- Added `dependsOn` support so tests can declare dependencies on other operations, with basic validation and skip-cascading when a dependency is skipped or missing.
- Added an optional `operationId` field to test cases.
- Test responses are now saved on pass, enabling chaining via completed-case state.
- Added a `proxy` option; added `Suite`/`TestCase` types; introduced a dedicated suite loader module.
- Added YAML test-suite support (`.spectest.yaml`).
- Added an optional server-build step and support for overriding the project root.
- Removed the `bail` option (superseded by dependency-aware scheduling); fixed a null-`requestId` edge case.

## [1.0.5] — 2025-07-13 (commit `6e039f7`)
- Fixed the build command and bumped the version (build-tooling fix, no user-facing feature change).

## [1.0.4] — 2025-07-12 (commit `58aace4`)
- README updates only.

## [1.0.2] — 2025-07-12 (commit `5b7d4a2`)
- Added support for suite objects (not just arrays of test cases) and JSON test-suite files.
- Added `.cjs`/`.mjs` import support.
- Added a `filter` config option and suite-name extraction from file paths.
- Introduced a dedicated renderer class for output; simplified CLI args parsing; minified the production bundle.
- Removed unused dependencies and leftover cruft from the earlier `fest` codebase.
- Added `.npmignore` to exclude development files from the published package (#5).

## [1.0.1] — 2025-07-11 (commit `9383485`)
- README and config documentation updates; build-script cleanup.

## [1.0.0] — 2025-07-10 (commit `9660a03`)
First "stable" 1.0 release after the initial rename/rewrite.
- Added MIT license.
- Fixed the `test` command; general readme/logo polish.

## [0.1.1] — 2025-07-10 (commit `9b9d426`)
Rapid feature-buildout release right after the TypeScript rewrite.
- Renamed the project from `fest` to `spectest` (including the CLI symlink path).
- Added rate limiting (requests-per-second) and a `bombard` helper for concurrent test expansion.
- Added `randomize`, `bail`, `happy`-path filtering, per-test `timeout` overrides, and snapshot options.
- Added a script to generate an OpenAPI schema from suites; added a `user-agent` option and support for a caller-provided request ID.
- Refactored server-helper functions into a `Server` class; switched CLI arg parsing to Commander.
- Made process-kill logic platform-agnostic, fixed the rate limiter hanging, and prevented a bug that nullified requests.
- Added build/test badges; simplified project-root detection.

## [0.1.0] — 2025-07-07 (commit `cd18048`)
First tagged release. Converted the original `fest` prototype into a TypeScript CLI with CI, pointed the example suite at `jsonplaceholder.typicode.com`, and did initial cleanup (#1).

---

## Pre-release history
- **Initial commit** (`4457ee6`, 2025-07-07) — project scaffolded as `fest`, later renamed to `spectest` before the `v0.1.0` tag.

## Notes on this changelog
- npm's published-versions list additionally shows `1.0.3` and `1.0.6`, but no corresponding `package.json` bump commit exists in git history for either — likely a version bump published directly without a distinct commit being preserved through the `fest`→`spectest` rename. No changelog entry could be reconstructed for them from git alone.
