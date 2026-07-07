# Persist Full Execution Logs

## Summary

Add automatic per-run log files under `.spectest/logs/` using a human-readable timestamped filename, for example `.spectest/logs/2026-05-24_14-31-08.log`. Logs are always written for each CLI test run, without adding config or CLI options.

## Key Changes

- Create a small execution log writer owned by the CLI lifecycle:
  - Initialize near the start of `runAllTests` after config/project root is known.
  - Ensure `.spectest/logs/` exists under `cfg.projectRoot`.
  - Use a filesystem-safe, human-readable local timestamp filename: `YYYY-MM-DD_HH-mm-ss.log`.
  - Append UTF-8 log lines and close/restore in every exit path, including startup failure and interrupted runs.

- Capture all runner output:
  - Tee `process.stdout.write` and `process.stderr.write` so existing `console.log`, `console.error`, progress output, reporter output, debug output, and failure output continue to appear in the terminal and are also saved.
  - Preserve existing terminal behavior; logging must not change exit codes or reporting.

- Capture server lifecycle and child-process logs:
  - Pass the log writer into `Server` through `setConfig`.
  - Record server startup decisions, health checks, reuse/fail/kill behavior, ready state, stop, force-kill, process close, and teardown stop messages.
  - Record spawned server `stdout` and `stderr` chunks even though they are currently only stored in memory.
  - Record build command `stdout` and `stderr` chunks as well as build start, success, and failure.
  - Keep existing `server.getLogs()` behavior unchanged for reporter/test hooks.

- Keep files untracked:
  - Update `.gitignore` to ignore root `.spectest/` or at minimum `.spectest/logs/`, since the current pattern only ignores nested `*/*/.spectest/*`.
  - Do not add generated log files to the repo.

## Test Plan

- Run `npm run build`.
- Run the CLI against the existing JSONPlaceholder tests and confirm:
  - A new file appears under `.spectest/logs/`.
  - The file contains runner start, discovered files, progress/report output, summary, and final exit-path logs.
- Run a config with `startCmd` so Spectest starts a server and confirm the log file includes:
  - server startup messages,
  - server child `stdout`/`stderr`,
  - readiness/health-check logs,
  - server stop/teardown messages.
- Run a failing startup path and confirm the log file is still flushed before exit.

## Assumptions

- Persisted logs should be automatic for every run.
- No new public CLI/config API is needed.
- Timestamp filenames should be human-readable and filesystem-safe, using local time.
- Existing terminal output and in-memory server log behavior must remain compatible.
