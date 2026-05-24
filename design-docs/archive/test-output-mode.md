# Test Output Mode

## Summary

Add `testOutput` as a config-backed reporting mode for executed test result detail. The README documents this setting as:

- `summary`: default output mode.
- `errors`: include failed-test server logs and failure reasons in the report.

The same setting should be accepted from the CLI as `--test-output=summary` or `--test-output=errors`, with CLI values overriding `spectest.config.js`.

## Goals

- Add `testOutput?: 'summary' | 'errors'` to CLI/config handling.
- Support `--test-output=summary|errors`.
- Set the default to `summary`.
- Validate unknown values with a clear CLI error.
- Keep `verbose` separate from test result detail.
- Make `errors` preserve the current detailed failure report behavior.

## Current Behavior

The README already lists:

```md
| `testOutput` | Executed test result detail (`summary` or `errors`). Use `errors` to include failed-test server logs and failure reasons in the report. | `summary` |
```

It also documents:

```md
`testOutput` can also be set from the CLI with `--test-output=summary` or `--test-output=errors`. CLI values override `spectest.config.js`.
```

The current CLI/config implementation does not yet expose `testOutput` in `src/config.ts`, and `src/default.config.ts` does not set a default. The console reporter currently always prints failed-test server logs and failure reasons inline.

## Config Shape

```ts
export type TestOutputMode = 'summary' | 'errors';

export interface SpectestConfig {
  configFile?: string;
  baseUrl?: string;
  testDir?: string;
  filePattern?: string;
  startCmd?: string;
  buildCmd?: string;
  runningServer?: string;
  tags?: string[];
  rps?: number;
  timeout?: number;
  snapshotFile?: string;
  randomize?: boolean;
  happy?: boolean;
  filter?: string;
  verbose?: boolean;
  testOutput?: TestOutputMode;
  userAgent?: string;
  proxy?: string;
  suiteFile?: string;
  projectRoot?: string;
}
```

## CLI And Config Changes

Update `src/config.ts` to:

- Add `testOutput?: 'summary' | 'errors'` to the CLI config type.
- Parse `--test-output`.
- Accept only `summary` or `errors`.
- Fail fast on invalid values with a clear error, for example: `error: --test-output must be "summary" or "errors"`.
- Preserve existing precedence: defaults, project config, invocation config, then CLI overrides.

Update `src/default.config.ts` to:

- Add `testOutput: 'summary'`.

Update the public config types to:

- Export `TestOutputMode`.
- Add `testOutput?: TestOutputMode`.

## Reporter Behavior

In `summary` mode:

- Print suite result rows.
- Do not print server logs inline.
- Do not print expanded failure reasons inline.
- Continue printing final aggregate counts and latency summary.

In `errors` mode:

- Preserve the current detailed failure report shape.
- Print server logs for failed results with matching request IDs.
- Print failed-test reasons.
- Do not expand successful results.

If the skipped-tests result-model change from `skipped-tests-in-normal-reporting-flow.md` is also implemented, then failed-test details should be gated with both conditions:

```ts
cfg.testOutput === 'errors' && result.status === 'failed'
```

Until that result-model change lands, the equivalent gate is:

```ts
cfg.testOutput === 'errors' && result.status !== 'passed'
```

## README Impact

The README already contains the intended config-table entry and CLI usage note for `testOutput`. Implementation should keep those semantics intact and clarify, if needed, that:

- `testOutput` controls executed test result detail.
- `verbose` controls spectest runner/program output.
- `verbose` and `testOutput` are independent.

## Test Plan

- Run `npm run build`.
- Run default mode and confirm failed tests do not include expanded server logs or failure reasons inline.
- Run `--test-output=summary` and confirm it matches the default output mode.
- Run `--test-output=errors` and confirm failed tests include server logs and failure reasons.
- Confirm successful tests do not expand logs in either mode.
- Confirm invalid `--test-output` values fail fast with a clear error.
- Confirm CLI `--test-output` overrides `spectest.config.js`.

## Assumptions

- `summary` is the default because README already documents it that way.
- `errors` means the current detailed failure output, not a failed-only report.
- This change may be implemented before or after the skipped-tests result-model change.
