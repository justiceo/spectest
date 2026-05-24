# Ctrl+C Cancellation Summary

## Summary

Add first-class execution-phase interrupt handling so the first Ctrl+C cancels the active setup/main run, stops new setup/main test scheduling, aborts framework-owned waits and requests, still attempts teardown cleanup, cleans up server/recording/rate-limiter resources, prints the normal summary, and exits with code `130` using a new `cancelled` result status.

## Key Changes

- Extend public result typing:
  - Add `cancelled` to `TestResultStatus`.
  - Ensure reporters and result consumers receive cancelled tests through normal `onTestEnd` events and the existing `TestRunResult.results` array.
- Add cancellation state in `src/cli.ts`:
  - Register a `SIGINT` handler after tests are prepared and before execution starts.
  - First Ctrl+C sets `interrupted = true`, aborts the setup/main run `AbortController`, stops scheduling new setup/main tests, and allows teardown/cleanup/reporting to run.
  - A second Ctrl+C exits immediately with code `130`, even if teardown, reporting, or cleanup is incomplete.
  - Remove the signal handler in final cleanup.
- Make execution cancellation-aware:
  - Track tests as `not started`, `running`, `completed`, `skipped`, or `cancelled`.
  - Pass the run cancellation signal into setup/main `runTest` calls.
  - Make test delays, rate-limiter waits, and HTTP requests abortable.
  - Check cancellation before starting a test, before invoking `runTest`, and before scheduling ready dependents.
  - When interrupted, create exactly one `cancelled` `TestResult` for every running or never-started runnable setup/main test.
  - Preserve completed results as `passed` or `failed`.
  - Keep explicit `skip: true` tests as `skipped`, not `cancelled`.
  - Do not synthesize `failed-precondition` for unfinished runnable setup/main tests after Ctrl+C; unfinished runnable tests become `cancelled`.
  - Emit `onTestEnd` for synthetic cancelled results so plugins and reporters observe the normal per-test lifecycle.
  - Still run teardown tests after the first Ctrl+C using a fresh/non-aborted teardown path so user-defined cleanup such as logout can complete.
- Make cancellation errors distinct from failures:
  - A timeout abort remains a failed result with timeout metadata.
  - A run-signal abort becomes `cancelled`, not a failed timeout result.
  - `runTest` should not both return a failed result for cancellation and allow the scheduler to synthesize a cancelled result for the same test.
  - User hooks are best effort: check cancellation before and after `beforeSend`/`postTest`, but do not try to forcibly abort arbitrary hook code or change hook signatures.
- Define cancelled result details:
  - Running tests report latency from test start until cancellation.
  - Never-started cancelled tests report `0ms`.
  - Final results, including synthetic cancelled and skipped entries, are sorted by the original prepared test order.
- Update `HttpClient` and `RateLimiter`:
  - `HttpClient.request` accepts an optional external `AbortSignal` and combines it with its timeout controller.
  - `HttpClient.request` preserves whether an abort came from timeout or external cancellation.
  - `RateLimiter.acquire` accepts an optional `AbortSignal` so queued tests can unblock immediately when interrupted.
- Update console reporting:
  - Add a cancelled icon/count.
  - Include cancelled tests in suite output and final aggregate line.
  - Progress should count `passed`, `failed`, and `cancelled` as completed outcomes.
  - Final interrupted run should still call `dispatchRunEnd` and print latency stats for available results.

## Test Plan

- Run `npm run build`.
- Add scripted integration coverage that spawns the CLI, sends `SIGINT`, and asserts output plus exit code.
- Cover interrupted execution scenarios:
  - Ctrl+C during test delay cancels promptly.
  - Ctrl+C while waiting in `RateLimiter.acquire` unblocks queued tests.
  - Ctrl+C during an in-flight HTTP request reports `cancelled`, not timeout/failure.
  - Completed tests keep their real `passed` or `failed` status.
  - Running and never-started runnable setup/main tests appear as `cancelled`.
  - Explicit `skip: true` tests remain `skipped`.
  - Teardown runs after the first Ctrl+C.
  - A second Ctrl+C exits immediately with code `130`.
  - Process exits with code `130` after an interrupted summary.
- Verify non-interrupted runs still report existing `passed`, `failed`, `skipped`, and `failed-precondition` behavior unchanged.

## Assumptions

- Scope is execution only: Ctrl+C during suite loading, preparation, or server startup keeps existing/default behavior.
- First Ctrl+C should abort runnable setup/main work immediately rather than drain active tests.
- Explicit user-declared skips retain their semantic status even when the run is interrupted.
- On interrupted runs, every runnable setup/main test without a completed result is reported as `cancelled`. Teardown tests are attempted after interruption and only unexecuted teardown tests are reported as `cancelled`.
- Interrupted runs exit with code `130`, regardless of completed pass/fail state, because the user explicitly cancelled execution.
