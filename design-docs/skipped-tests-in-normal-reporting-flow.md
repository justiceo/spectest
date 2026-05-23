# Skipped Tests In Normal Reporting Flow

## Summary

Merge skipped tests into the normal execution result and reporting flow. Today, executed tests are emitted through `TestRunResult.results`, while explicit and runtime skips are collected separately in `TestRunResult.skippedTests`. This split forces reporters to render a second skipped-tests section and makes summary counts depend on two different collections.

After this change, every test outcome is represented by a `TestResult` entry in `TestRunResult.results`. `TestRunResult.skippedTests` is removed, and `TestResult.status` contains the outcome enum:

```ts
type TestResultStatus = 'passed' | 'failed' | 'skipped' | 'failed-precondition';
```

## Goals

- Represent executed, explicitly skipped, and runtime-skipped tests in one ordered result list.
- Remove `skippedTests` from the public run-result payload.
- Make reporter counts derive only from `TestRunResult.results`.
- Distinguish an explicit skip from a dependency/setup-derived runtime skip.
- Preserve current process-exit behavior: only real test failures should make the CLI exit nonzero.


## Current Behavior

In `src/cli.ts`, the runner currently:

- Pushes only executed test results into `results`.
- Tracks dependency/setup skips in a separate `runtimeSkipped` set.
- Builds an explicit skipped list from `tests.filter((t) => t.skip)`.
- Calls `dispatchRunEnd` with both `results` and `skippedTests`.
- Uses boolean pass/fail result state for dependency flow and exit-code decisions.

In `src/plugins/console-reporter.ts`, the reporter currently:

- Renders `results` as the main suite report.
- Renders `skippedTests` in a separate skipped-tests section.
- Counts passed tests from the boolean pass/fail result state.
- Counts skipped tests from `skippedTests.length`.

## Proposed Result Model

```ts
export type RuntimeTestCase = TestCase & {
  dependents: RuntimeTestCase[];
  unresolvedDependencies: number;
  failedPrecondition: boolean;
};

export type TestResultStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'failed-precondition';

export interface TestResult {
  status: TestResultStatus;
  error?: string;
  latency: number;
  requestId?: string | null;
  testName: string;
  operationId: string;
  suiteName: string;
  timedOut?: boolean;
  request: any;
  response: {
    status: number;
    headers: any;
    data: any;
  };
}

export interface TestRunResult {
  results: TestResult[];
  serverLogs: ServerLog[];
}
```

The field name is `status` to reflect that the result can be passed, failed, skipped, or blocked by a failed precondition.

## Status Semantics

- `passed`: the test executed and completed successfully.
- `failed`: the test executed and failed, including timeout failures.
- `skipped`: the test was explicitly marked with `skip: true`.
- `failed-precondition`: the test did not run because a dependency, setup condition, or referenced dependency failed.

## CLI Changes

Update `src/cli.ts` to:

- Return executed test results as `status: 'passed'` or `status: 'failed'`.
- Create synthetic `TestResult` records for explicit skips before `dispatchRunEnd`.
- Create synthetic `TestResult` records for runtime skips before `dispatchRunEnd`.
- Use `status: 'skipped'` for explicit skips.
- Use `status: 'failed-precondition'` for runtime skips.
- Check `result.status === 'passed'` for dependency/setup flow instead of boolean truthiness.
- Treat only `result.status === 'failed'` as process-failing for exit code.
- Dispatch run end with `{ results, serverLogs }` only.

Synthetic skip results should include the normal identity fields (`testName`, `operationId`, and `suiteName`) and neutral request/response placeholders. Their latency should be `0`.

## Reporter Changes

Update `src/plugins/console-reporter.ts` to:

- Render one suite report from `runResult.results`.
- Remove all grouping/rendering paths that depend on `skippedTests`.
- Calculate summary counts from `result.status` values.
- Show explicit skips inline with the rest of the suite.
- Show failed-precondition entries inline with the rest of the suite.
- Keep latency display for executed tests and omit or show `0ms` consistently for skipped statuses.

Recommended icons:

- `passed`: green pass icon.
- `failed`: red fail icon, or timeout icon when `timedOut` is true.
- `skipped`: yellow/colored skip icon.
- `failed-precondition`: gray failed-precondition icon.

## README Impact

The README test-case reference already documents `skip`. After this change, reporting examples and any result-shape documentation should treat skipped tests as normal result rows instead of a separate skipped-tests section.

## Test Plan

- Run `npm run build`.
- Run a suite with only passing and failing tests and confirm behavior is unchanged except for enum result values.
- Run a suite with `skip: true` and confirm the skipped test appears inline in the suite report.
- Run a dependency failure and confirm dependent tests appear inline as `failed-precondition`.
- Confirm summary counts derive from statuses in `results`.
- Confirm `dispatchRunEnd` payload no longer contains `skippedTests`.
- Confirm process exit is nonzero only when at least one result has `status: 'failed'`.

## Assumptions

- `skippedTests` is fully removed rather than kept as a deprecated alias.
- `failed-precondition` is used for runtime skips, including dependency-derived skips.
- Explicit skips and failed preconditions should not be considered failures for process exit.
