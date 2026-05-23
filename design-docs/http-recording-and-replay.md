# HTTP Recording And Replay For Node SUTs

## Summary

Add first-class HTTP cassette support for outbound HTTP requests made by a Node-based SUT. Spectest will still send real requests to the local SUT, but the SUT's external HTTP calls will be intercepted, replayed, recorded, or bypassed according to run-level and test-level policy.

Use `@mswjs/interceptors` because it covers Node HTTP clients through `http`/`https`, `fetch`, XHR, and common libraries built on those primitives.

## Public API

- Add CLI/config:
  - `recording`: `'off' | 'replay' | 'record'`, default `'off'`.
  - `recordingFile`: path to the JSON cassette, default `'.spectest/cassette.json'`.
  - `missingRecordingBehavior`: `'fail' | 'record' | 'bypass'`, default `'fail'`.
  - `recordingExcludeUrls`: URL patterns that should always bypass cassette handling, default `[]`.
  - CLI flags: `--recording=replay|record|off`, `--recording-file=<path>`, `--missing-recording-behavior=fail|record|bypass`.
- Add test case override:
  - `recording?: 'off' | 'replay' | 'record'`.
  - When unset, the test inherits the run-level recording mode.
  - Per-test overrides are passed to the SUT through Spectest-managed headers and applied to outbound calls made during that request.
- Export a framework-agnostic unit-test helper from `spectest/recordings`:
  - `useHttpRecordings(options): Promise<{ dispose(): Promise<void> }>`
  - Options mirror CLI config: `{ file, mode, missingRecordingBehavior, recordingExcludeUrls?, match?, redact? }`.
  - Intended use: call in `before`/`beforeAll`, call `dispose` in `after`/`afterAll`, without mocking individual requests.

### URL Exclusions

Some outbound calls should remain live even when the rest of a test run records or replays from cassette. Common examples are telemetry endpoints, local observability collectors, cloud metadata endpoints, or an intentionally non-deterministic dependency that a test does not assert on.

Support these with config-level `recordingExcludeUrls`:

```js
export default {
  recording: 'replay',
  recordingExcludeUrls: [
    'https://telemetry.example.com/',
    /^https:\/\/metadata\.google\.internal\//,
    (url) => url.hostname.endsWith('.internal.example.com'),
  ],
};
```

The option accepts:

- `string`: canonical URL prefix match. This keeps the most common origin/path exclusions readable.
- `RegExp`: tested against the canonical URL string.
- `(url: URL, request: SerializedHttpRequest) => boolean`: advanced JS-config escape hatch.

Excluded requests always use the existing `bypass` decision. They pass through to the network in both `record` and `replay` modes, are never written to the cassette, and are not considered replay misses.

## Implementation Changes

- Add a recording runtime loaded into spawned Node SUTs with `NODE_OPTIONS=--import <spectest recording preload>`.
  - Only enable this when `recording !== 'off'`.
  - Require Spectest to start the server process; if `runningServer: 'reuse'` and recording is enabled, fail with a clear error because an already-running process cannot be instrumented reliably.
- Update `Server.start()` to spawn with IPC when recording is enabled.
  - Parent process owns cassette reads/writes.
  - Child preload intercepts outbound HTTP, sends request events to the parent, and receives replay/pass-through decisions.
- In the preload runtime:
  - Use `@mswjs/interceptors` BatchInterceptor with the Node preset.
  - Patch Node `http`/`https` server request handling with `AsyncLocalStorage` so outbound calls can inherit the active Spectest test's recording mode.
  - Read Spectest headers such as `x-spectest-case-id` and `x-spectest-recording-mode`; strip them from outbound matching data.
- Store cassettes as deterministic JSON:
  - Top-level metadata: schema version, created/updated timestamps, Spectest version.
  - Entries array with stable IDs, match key, request, response, timings, and optional test identity.
  - Store request/response bodies as base64 with content type, byte length, and SHA-256 hash.
  - Store headers as ordered `[name, value]` arrays to preserve duplicates and casing as much as the interceptor exposes.
- Matching behavior:
  - Default match key: method + canonical URL + request body hash + selected request headers.
  - Exclude volatile hop-by-hop headers from matching: `connection`, `keep-alive`, `transfer-encoding`, `content-length`.
  - Apply `recordingExcludeUrls` before cassette lookup or match-key generation so excluded requests cannot create replay misses or cassette entries.
  - Allow future config extension for custom include/exclude header matching and redaction, but implement defaults first.
- Mode behavior:
  - `replay`: replay matching entries; missing entries follow `missingRecordingBehavior`.
  - `record`: pass through real network calls and upsert cassette entries.
  - `missingRecordingBehavior=fail`: throw a clear unmatched-recording error.
  - `missingRecordingBehavior=record`: pass through and append/upsert only the missing entry.
  - `missingRecordingBehavior=bypass`: pass through without saving.
- Incremental updates:
  - Preserve existing entries and order.
  - Upsert by stable match key in `record` mode.
  - Append new entries for misses.
  - Write atomically through a temporary file rename from the parent process.
- Exclusion handling:
  - Keep exclusion evaluation in `HttpRecordingCassette.decide()` so CLI-spawned SUT recording and the exported `useHttpRecordings` helper share identical behavior.
  - Pass `recordingExcludeUrls` from loaded config into the CLI-owned cassette, and from helper options into the helper-owned cassette.
  - Do not send exclusion config to the SUT preload; the child process only serializes outbound requests and waits for the parent decision.

## Tests

- Unit-test cassette matching:
  - Same method/URL/body matches.
  - Different body hash misses.
  - Volatile headers do not affect matching.
  - Binary body round-trips through base64.
- Unit-test mode behavior:
  - Replay hit returns recorded response.
  - Replay miss fails by default.
  - `missingRecordingBehavior=record` appends a new entry.
  - `missingRecordingBehavior=bypass` makes a real request and does not write.
- Unit-test URL exclusions:
  - String prefix, `RegExp`, and predicate exclusions return `bypass`.
  - Excluded requests are not looked up, not recorded, and do not fail as replay misses.
  - Non-matching URLs keep normal record/replay behavior.
- Integration-test spawned Node SUT:
  - SUT using native `fetch` is recorded, then replayed with the upstream server offline.
  - SUT using `http.request` is recorded and replayed.
  - Test-level `recording: 'off'` bypasses replay while run-level replay is enabled.
  - Config-level `recordingExcludeUrls` bypasses selected upstream calls and leaves them out of the cassette.
  - Running with `runningServer: 'reuse'` and recording enabled fails with a useful error.
- Unit-test exported helper:
  - Works without Spectest CLI.
  - Can replay a cassette in a plain Node test and restore normal networking on `dispose`.
  - Honors `recordingExcludeUrls` with the same behavior as CLI recording.

### Real Server Integration Fixture

Add a concrete fixture under `examples/http-recording` or a test-only equivalent:

- Start a real local Node HTTP server with `startCmd`; do not reuse an already-running process.
- Expose local endpoints such as `/posts/:id`, `/users/:id/summary`, and `/search/comments`.
- Each endpoint should make real outbound HTTP calls, for example with native `fetch` to `https://jsonplaceholder.typicode.com`.
- Run Spectest once with `recording: 'record'` and assert the cassette contains the upstream calls made by those local endpoints.
- Run Spectest again with `recording: 'replay'` while the upstream base URL is unavailable or intentionally invalid, and assert the same local endpoint tests pass from cassette.
- Include one endpoint or background call that targets a configured excluded URL; assert replay does not fail because of it and the cassette does not contain it.

Keep the fixture focused on proving the end-to-end user workflow: Spectest sends real requests to the local server, the server makes real HTTP calls, recordings are created, and the same tests can later replay without the upstream service.

## Assumptions

- v1 supports Node-based SUT outbound HTTP only.
- Spectest must spawn the SUT for automatic instrumentation.
- Existing `snapshotFile` remains a test-result artifact; recordings use separate `recordingFile`.
- The JSON cassette is the only supported storage format for v1.
- URL exclusions mean live passthrough and never save, regardless of recording mode.
- No CLI flag is required for `recordingExcludeUrls` in v1; complex URL patterns are better expressed in `spectest.config.js`.
