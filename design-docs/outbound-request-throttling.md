# Outbound Request Throttling for Backend Dependencies

## Summary

Some SUT endpoints fan out to rate-limited third-party backends (e.g. a domain-registration
endpoint making 4 internal calls to Openprovider per request). Spectest's existing `--rps` flag
throttles *Spectest's own requests to the SUT*; it has no visibility into what the SUT does
internally, so a burst of 10 concurrent Spectest tests can still produce 40 concurrent calls to
Openprovider and trip its rate limit. This doc proposes intercepting and throttling the SUT's
*outbound* calls to specific backends, transparently, using the same interception technique
`recording-preload.ts` already uses to capture outbound traffic for record/replay.

Two implementation patterns are evaluated:

- **Pattern A**: a new, standalone throttle preload, independent of recording.
- **Pattern B**: throttling folded into the existing recording preload/cassette pipeline.

## Background: why interception works here

`recording-preload.ts` patches `http`, `https`, `fetch`, and `XHR` inside the SUT process via a
`--import` preload module, applied before the app's own code runs (`server.ts:229-231`). Every
outbound call the app makes — regardless of library — passes through
`interceptor.on('request', ...)` (`recording-preload.ts:113`), which is awaited before the real
network call fires. Recording uses that await to fetch a replay/record decision over IPC; nothing
about the mechanism requires that specific use. The same await point can hold a request until a
local rate limiter (the existing `RateLimiter` token bucket, `rate-limiter.ts`) issues it a token,
then let the real request proceed unmodified. The app never sees a mock response, only added
latency on outbound calls to the throttled host — this is what makes it "transparent."

Both patterns share this constraint, inherited from recording: Spectest must spawn the SUT
process itself, because `--import` can only be set at process spawn (`server.ts:206-208` enforces
the equivalent rule for recording, disallowing `runningServer: 'reuse'`).

---

## Pattern A: Standalone throttle preload

A new preload, decoupled from recording, that only gates requests matching a configured pattern.

### Public API

- New config: `outboundThrottle?: Array<{ match: string | RegExp | ((url: URL) => boolean); rps: number }>`
  - Reuses the `RecordingUrlExclusion`-style match shape (`types.d.ts`'s `RecordingUrlExclusion`)
    for consistency with `recordingExcludeUrls`.
  - Each entry gets its own independent token bucket keyed by array index (or an optional `name`
    field for clearer logs).
- CLI flag: none in v1 (pattern + numeric rps doesn't map cleanly to a single flag); config-file only.
- No change to `TestCase` — this throttles the SUT's outbound calls, not Spectest's requests to
  the SUT, so it's a run-level config, not a per-test one.

### Implementation changes

- New file `src/throttle-preload.ts`:
  - `BatchInterceptor` with the same three interceptors as `recording-preload.ts`
    (`ClientRequestInterceptor`, `XMLHttpRequestInterceptor`, `FetchInterceptor`).
  - Reads `SPECTEST_THROTTLE_CONFIG` (JSON-serialized `outboundThrottle`, since the preload runs
    in a separate process before any IPC channel exists) from `process.env`.
  - Builds one `RateLimiter` per config entry at module load.
  - `interceptor.on('request', ...)`: match `request.url` against each entry's `match`; on first
    match, `await limiter.acquire()`, then return (no `respondWith`/`errorWith` — passthrough).
    Non-matching requests return immediately.
  - No `response` handler, no IPC, no `process.send`/`process.on('message')` — fully self-contained
    in the child process.
- `server.ts`: extend the `nodeOptions` construction (currently only branches on
  `this.recording.enabled`, line 229) to also append `--import <throttlePreloadPath>` when
  `outboundThrottle` is configured, independent of the recording branch. Both preloads can be
  present in `NODE_OPTIONS` simultaneously if both features are enabled.
  - Does *not* need `stdio: [...,'ipc']` — only recording needs the IPC channel back to the parent.
- `config.ts`: add `outboundThrottle` parsing/validation (array shape, `match` type, `rps > 0`),
  mirroring `validateConfiguredRecordingExcludeUrls`.
- Optionally exported standalone (like `recordings.ts` exports `useHttpRecordings`) as
  `spectest/throttle` for use in plain Node test harnesses outside Spectest.

### Tests

- Unit: preload module in isolation — matching entries delay `fetch`/`http` calls to respect
  configured rps; non-matching calls pass through with no added latency.
- Integration: SUT fixture that calls a local mock "Openprovider" endpoint N times per request;
  assert peak concurrent/per-second call rate to the mock never exceeds configured rps under
  concurrent Spectest test load.
- Config validation: reject malformed `outboundThrottle` entries (bad `match` type, `rps <= 0`).
- Verify recording and throttling can be enabled together without one breaking the other
  (two preloads, one process).

### Pros

- Clean separation of concerns: zero coupling to the cassette/replay state machine, no risk of
  regressing recording.
- Simpler runtime path per request (no IPC round-trip, no `AsyncLocalStorage` context needed) —
  lower latency overhead and fewer failure modes.
- Usable without recording enabled at all, and exportable as a standalone helper
  (`spectest/throttle`) for non-Spectest Node test harnesses, matching the precedent set by
  `recordings.ts`.
- Smaller, independently reviewable/testable surface; safer to ship first and iterate.

### Cons

- A second preload file and a second `--import` injection path to maintain and keep in sync with
  `server.ts`'s process-spawn logic (env, `NODE_OPTIONS` composition, cleanup).
- Two interceptor stacks (`BatchInterceptor` instances) attached in the same process — needs a
  smoke test confirming `@mswjs/interceptors` tolerates multiple independent `BatchInterceptor`
  registrations cleanly (recording's interceptor also patches `http`/`https`/`fetch` globally;
  behavior when two separate interceptors both patch the same globals should be verified, even
  though each instance wraps the previous handler rather than replacing it).
- Config surface duplicates the "match a URL" shape (`match` vs. `recordingExcludeUrls`) instead
  of having one unified place to reason about outbound-URL handling.

---

## Pattern B: Folded into the recording preload/cassette pipeline

Add throttling as a capability of the existing recording system rather than a separate feature.

### Public API

- Extend recording config: `recording` stays as-is, but add `throttle?: Array<{ match: ...; rps: number }>`
  alongside `recordingFile`, `missingRecordingBehavior`, `recordingExcludeUrls` — i.e. throttling
  becomes a sibling option under the same "recording" umbrella, available whenever recording
  infrastructure is active.
- Same match-pattern shape as Pattern A.

### Implementation changes

- `recording-preload.ts`: in the existing `interceptor.on('request', ...)` handler
  (`recording-preload.ts:113`), before or after `requestToSerialized`, check the request URL
  against configured throttle patterns and `await limiter.acquire()` prior to resolving the
  replay/record/fail decision.
- `RecordingContext`/IPC messages (`recording-cassette.ts`) gain no new fields — throttling is
  local to the child process, but the *config* (throttle patterns/rps) must now travel through
  whatever channel already delivers recording config to the preload. Today that's via
  `this.recording.*` fields on `Server` and the `recordingPreload`/`recording.enabled` wiring in
  `server.ts:47-57` — would need to extend that object and however it reaches the preload
  (currently the preload has no config injection at all; recording behavior is driven entirely by
  per-request headers like `x-spectest-recording-mode`, not preload-level config). This is a gap:
  throttle rps/patterns aren't per-request, so they can't ride the existing header-based context
  mechanism and need a new env-var injection path anyway — largely duplicating what Pattern A
  does, just inside the same file.
- `server.ts`: `nodeOptions` branch (line 229) now also triggers preload injection when
  `outboundThrottle` is set but recording is *not* enabled — meaning the "recording" preload must
  be loadable/useful independent of recording being on, which muddies its name and its
  `runningServer: 'reuse'` guard (`server.ts:206-208` currently reads
  `this.recording.enabled && this.runningServer === 'reuse'`; would need a parallel check for
  throttle-only runs).
- `config.ts`: extend recording config validation to also validate `throttle` entries.

### Tests

- Same throttling-behavior tests as Pattern A, but run against `recording-preload.ts`.
- Additional matrix: throttle + recording both enabled, throttle enabled with recording off,
  recording enabled with throttle off — verify no cross-interference (e.g. a throttled request
  still gets recorded/replayed correctly, and vice versa).
- Regression suite for existing recording tests must stay green — this is the main risk surface.

### Pros

- One preload, one `--import` injection path, one place in `server.ts` to reason about "what
  patches this process."
- Natural fit if throttling and recording are usually turned on together in practice (e.g. someone
  recording Openprovider traffic for replay *and* wanting to avoid hammering it during that
  recording run) — shares the request-interception plumbing instead of running two interceptor
  stacks.
- Reuses `RecordingUrlExclusion`-shaped matching already validated in `config.ts` for
  `recordingExcludeUrls`, so pattern semantics are already familiar/tested.

### Cons

- Coordinates two independent concerns (record/replay correctness and rate limiting) in one
  request handler and one config namespace — a bug in throttle logic risks destabilizing
  recording, and vice versa; the "Independent Analysis Findings" pattern seen in this repo's other
  design docs (e.g. `expanded-recording-transport-coverage.md`) suggests reviewers will likely flag
  this coupling.
- Forces "recording" to stop meaning only record/replay — `runningServer: 'reuse'` guard,
  preload-enable conditions, and naming (`recording-preload.ts`, `this.recording.enabled`) all need
  to account for a throttle-only mode that has nothing to do with cassettes. Effectively becomes
  "the generic SUT-outbound-interception preload" wearing a recording-specific name.
  file/class rename to something like `sut-interceptor.ts` — non-trivial churn on a currently
  working, dogfooded feature.
- Config validation and docs need care to make clear `throttle` works without `recording` enabled,
  which is a confusing story for an option nested under recording config.
- Higher blast radius: any change here touches the same file backing a feature the project already
  depends on for its own dogfood run (`npm test`), raising the cost of a regression.

---

## Comparison

| | Pattern A: Standalone preload | Pattern B: Folded into recording |
|---|---|---|
| Coupling to recording | None | Tight — shares file, config namespace, spawn conditions |
| Risk to existing recording feature | None | Non-trivial — same request handler, same guard conditions |
| Works without recording enabled | Yes, natively | Yes, but requires loosening recording-specific guards/naming |
| Runtime overhead per request | One extra interceptor stack in the process | None extra (same stack as recording) |
| Config surface | New sibling option | Nested under `recording` — confusing if recording is off |
| Reuse of existing matching/validation code | Duplicates `RecordingUrlExclusion` shape | Reuses it directly |
| Effort to ship | Smaller, isolated | Larger — touches naming/guards on a load-bearing file |
| Best fit if... | Throttling and recording are used independently/rarely together | Throttling and recording are almost always used together |

## Recommendation

Pattern A. Given `recording-preload.ts` is explicitly called out in `CLAUDE.md` as core,
dogfooded infrastructure (`npm test` runs the built CLI against a live SUT), and throttling an
API like Openprovider is a use case independent of whether anyone is recording/replaying that
traffic, the isolation of a standalone preload outweighs the minor duplication in matching logic
and the cost of a second `--import` entry. It also composes cleanly with recording (both preloads
can run in the same process) without either feature needing to know about the other.

## Assumptions

- The SUT process is spawned by Spectest (`runningServer` is not `'reuse'`) whenever throttling is
  configured; this doc doesn't address throttling calls made from a process Spectest didn't start
  (e.g. a separate queue-consumer service also calling Openprovider).
- Throttling is proactive (a configured rps cap), not adaptive to the backend's actual rate-limit
  responses (e.g. `429`/`Retry-After`) — that would be a separate, follow-on feature.
- `match` patterns are evaluated per-request with no caching/memoization needs beyond what
  `RecordingUrlExclusion` matching already does for exclusions.
- Multiple `@mswjs/interceptors` `BatchInterceptor` instances coexisting in one process (Pattern A)
  is assumed safe but should be explicitly smoke-tested before relying on it, since this repo has
  no existing precedent for two active interceptor stacks at once.
