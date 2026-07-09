# Reliable Server Startup Wait

## Summary

When Spectest spawns the SUT itself (`runningServer` not `'reuse'`, or no server already
listening), `Server.start()` (`src/server.ts:211-328`) does not poll for readiness. It spawns the
process, sleeps a hardcoded 3000ms, then performs exactly one `HEAD` health check
(`isRunning()`). If that single check doesn't land in a 200-499 response, `start()` rejects
outright — tests never run. If the check does land, tests fire immediately, whether or not the
app has finished initializing. This doc proposes replacing the fixed-delay-then-single-check with
a configurable poll loop, fast failure on early process exit, and diagnostic logging that
surfaces *why* readiness failed instead of a generic error.

## Current behavior (the bug)

```ts
// src/server.ts:293-308
// Wait for server to be ready
setTimeout(async () => {
  try {
    if (await this.isRunning()) {
      console.log('✅ Server is ready');
      resolve();
    } else {
      await this.stop();
      reject(new Error('Server health check failed'));
    }
  } catch (error: any) {
    console.error('Server startup error:', error.message);
    await this.stop();
    reject(new Error(`Server startup failed: ${error.message}`));
  }
}, 3000);
```

```ts
// src/server.ts:194-209
async isRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(this.serverUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}
```

Both the 3000ms startup delay and the 3000ms health-check-request timeout are hardcoded magic
numbers with no config knob (`RunningServerMode` in `src/types.d.ts:76` only covers
`'reuse' | 'fail' | 'kill'` — how to handle an *existing* server, not how long to wait for a *new*
one).

## Problems this causes

1. **False negative (slow-booting apps)**: a server that binds its port at, say, 4s (migrations,
   DI container wiring, etc.) causes `start()` to reject entirely — the whole run fails before any
   test executes, even though the server would have been healthy shortly after.
2. **False positive (port bound, app not ready)**: if something responds to `HEAD /` within 3s
   (the port is open, a framework's default 404 handler answers) but the app hasn't finished
   initializing (e.g. a DB connection pool still connecting), the single check still passes and
   tests fire against a half-ready app — this is the flakiness the user observed.
3. **Slow, opaque failure on crash**: if the start command fails immediately (syntax error, missing
   env var, port already in use by something else), Spectest still blocks for the full 3000ms
   doing nothing useful, then reports the generic `Server health check failed` with no indication
   the process actually exited nonzero. The real cause (stderr) is only visible later, via the
   unrelated `close` handler (`server.ts:289-291`) dumping full JSON logs — easy to miss and not
   part of the rejection error itself.
4. **Not configurable**: 3000ms is arbitrary. It's too long for a fast-booting SUT during
   iterative local runs (always pays the full delay even when ready in 200ms) and too short for
   anything with real startup work.

## Goals

- Poll for readiness at a short interval, up to a configurable timeout, instead of one fixed delay
  plus one check.
- Detect the server process exiting before it becomes ready and fail immediately with the exit
  code/signal and captured output, instead of waiting out the rest of the timeout.
- Make timeout and poll interval configurable (config file + CLI flag), with defaults that don't
  regress the common fast-boot case.
- On any failure path, produce one diagnostic error message containing: elapsed time, attempt
  count, the last health-check failure reason, and a tail of captured stdout/stderr — not just
  `Server health check failed`.
- Non-goal: changing what counts as "ready" (still a `HEAD` request to `serverUrl` returning
  200-499). That's a separate, orthogonal improvement — see Alternatives.

## Design

### 1. Poll loop replacing the fixed `setTimeout`

```ts
private async waitUntilReady(timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempts = 0;
  let lastFailureReason = 'no health check attempted yet';

  let exitedEarly: { code: number | null; signal: string | null } | null = null;
  const onExit = (code: number | null, signal: string | null) => {
    exitedEarly = { code, signal };
  };
  this.serverProcess!.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (exitedEarly) {
        throw this.startupError(
          `Server process exited (code ${exitedEarly.code}, signal ${exitedEarly.signal}) ` +
          `before becoming ready, after ${Date.now() - startedAt}ms and ${attempts} health check attempt(s).`
        );
      }
      attempts++;
      try {
        if (await this.isRunning()) return; // ready
        lastFailureReason = 'health check returned a non-2xx-4xx status or no response';
      } catch (err: any) {
        lastFailureReason = err.message;
      }
      await sleep(intervalMs);
    }
    throw this.startupError(
      `Server did not become ready within ${timeoutMs}ms (${attempts} health check attempt(s); ` +
      `last failure: ${lastFailureReason}).`
    );
  } finally {
    this.serverProcess!.off('exit', onExit);
  }
}
```

`startupError(message)` (new private helper) appends a formatted tail of `this.serverLogs` (see
§4) to `message` and returns the `Error`. `start()`'s `setTimeout(...)` block is replaced by
`await this.waitUntilReady(this.startupTimeoutMs, this.healthCheckIntervalMs)` inside the existing
`try { resolve() } catch { await this.stop(); reject(...) }` shape — `stop()` is already safe to
call on a still-running or already-dead process.

### 2. Config surface

New `SpectestConfig` fields (`src/types.d.ts`):

```ts
serverStartupTimeout?: number;      // ms to wait for readiness; default 30000
serverHealthCheckInterval?: number; // ms between health check attempts; default 250
```

CLI flags, mirroring the existing `--running-server`/`--rps` pattern in `src/config.ts`:
`--server-startup-timeout <ms>` and `--server-health-check-interval <ms>`, each with a
`parsePositiveInt`-style validator (reject non-numeric or <= 0) and a matching
`validateConfigured*` for the config-file path, following the two-validator pattern already used
for every other enum/shape option in `config.ts`. Defaults land in `default.config.ts`. README
gets two new rows in the options table (`src/config.ts` help text + `README.md`).

**Naming alternative considered**: reuse the existing `timeout` option (already in
`default.config.ts`, default 60000). Rejected — `timeout` is documented as the per-test HTTP
request timeout, a different axis (one test's request vs. the SUT's one-time boot). Overloading it
would make suites that raise `timeout` for a slow endpoint unintentionally also raise server-boot
patience, and vice versa.

### 3. Early-process-exit fast fail

The `once('exit', ...)` listener in `waitUntilReady` (§1) means a server that crashes on startup
(bad `start` command, uncaught exception before the HTTP listener binds) is detected on the very
next loop iteration — bounded by `intervalMs` (default 250ms), not the full timeout. This is the
main lever on problem #3: today a crash-on-boot always costs the full 3000ms before reporting
anything.

### 4. Failure diagnostics format

Every thrown/rejected error from this path goes through `startupError()`, which appends the last
N (e.g. 20) entries of `this.serverLogs` — already collected via the existing `stdout`/`stderr`
listeners (`server.ts:279-287`) — formatted with their `type` prefix:

```
Server process exited (code 1, signal null) before becoming ready, after 340ms and 1 health check attempt(s).
Recent server output:
[stderr] Error: connect ECONNREFUSED 127.0.0.1:5432
[stderr]     at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)
```

or

```
Server did not become ready within 30000ms (118 health check attempt(s); last failure: fetch failed).
Recent server output:
[stdout] Listening on port 8080
[stdout] Connecting to database...
```

This message is both the rejection `Error`'s `.message` (so it surfaces wherever `cli.ts` reports
a startup failure today) and printed via `console.error` at the point of failure, so it's visible
immediately rather than only reachable via `getLogs()` after the fact. The existing `close` handler
console dump (full JSON of every log line) is left as-is for post-mortem debugging but is no
longer the only place the failure reason is visible.

### 5. Verbose gating for per-attempt logs

`debug()` (`server.ts:29-33`) currently logs unconditionally (`// todo: only output when verbose
output is enabled`, never wired up) — fine for a single check, but a poll loop calling it every
`intervalMs` would spam stdout on any run where the server takes more than a second or two. This
doc proposes finally wiring the existing `verbose` config field through to `Server` (it's already
in `SpectestConfig`/`CliConfig` but never passed to `server.setConfig()`), so `debug()` is a no-op
unless `--verbose` is set. In its place, `waitUntilReady` prints one non-verbose progress line
(e.g. `⏳ Still waiting for server... (5.2s elapsed)`) on a coarser cadence (every ~5s), so a
slow-but-healthy boot isn't silent but also isn't one line per 250ms.

## Backward compatibility

- **Faster in the common case**: today, even a server that's ready in 200ms still blocks the full
  3000ms (the check only runs once, after the sleep). With polling at a 250ms interval, a
  fast-booting server is detected on the first or second attempt — `start()` resolves sooner, not
  later, for the typical case.
- **More forgiving in the slow case**: default timeout goes from a hard 3000ms cliff to 30000ms,
  which only helps — nothing currently relies on the 3000ms rejection as a feature.
- **No change to `isRunning()` semantics** — only how often and how long the caller retries it.
- The project's own dogfood run (`npm test`) passes `--base-url=https://jsonplaceholder.typicode.com`
  with `runningServer` defaulting to `'reuse'`; `isRunning()` succeeds against the live remote
  server on the very first check, so `start()` returns via the existing "Using existing server"
  branch (`server.ts:226-230`) and never reaches the poll loop at all — this change has no effect
  on `npm test`. It's only exercised when Spectest actually spawns a process, which today has no
  test coverage (per the earlier investigation) and will gain dedicated fixtures (see Tests).

## Tests

New `test/server-startup-wait.test.ts` (unit, `node --test`, real child processes via small fixture
scripts under `test/fixtures/servers/`):

- **Slow-but-healthy fixture**: a tiny HTTP server that starts listening after a deliberate delay
  (e.g. 1500ms). Assert `start()` resolves once it becomes healthy, and does so close to the actual
  delay (not pinned to the old 3000ms), using a short configured `serverHealthCheckInterval`.
- **Never-ready fixture**: listens but always 500s (or never listens at all). Assert `start()`
  rejects once `serverStartupTimeout` elapses, and the rejection message contains the attempt count
  and elapsed time.
- **Crash-on-boot fixture**: exits immediately with a nonzero code and a distinctive stderr line.
  Assert `start()` rejects well before the configured timeout (bounded by one interval), and the
  error message contains the exit code and the fixture's stderr line.
- **Config validation**: `config.ts` rejects non-numeric / <= 0 `serverStartupTimeout` and
  `serverHealthCheckInterval`, both from CLI flags and from a config file, mirroring existing tests
  for `outboundThrottle`/`recordingExcludeUrls` validation.
- **Regression**: `test/server-throttle-guard.test.ts`'s `reuse`/`fail`/`kill` guard checks are
  unaffected, since those branches short-circuit before `waitUntilReady` is ever called.

## Alternatives considered

- **Exponential backoff instead of a fixed poll interval**: rejected for v1. Timeout windows here
  are seconds-to-tens-of-seconds, not minutes, and each poll is one cheap `HEAD` request — a fixed
  short interval (250ms default) is simpler to reason about, simpler to test deterministically, and
  the added complexity of backoff buys little at this timescale.
- **Configurable/custom readiness check** (a user-supplied predicate, or a distinct health-check
  path instead of `serverUrl` itself): valuable, but changes *what* counts as ready rather than
  *how long* to wait for it — orthogonal to this doc's scope. Noted as good follow-on work,
  especially for apps whose root path isn't a meaningful readiness signal (e.g. requires auth).
- **Just raising the fixed delay** (e.g. 3000ms → 10000ms) without polling: rejected — doesn't fix
  the false-positive/false-negative shape of the problem, just moves the cliff and still wastes
  time on fast-booting servers.

## Assumptions

- `isRunning()`'s current readiness bar (`HEAD` to `serverUrl`, status 200-499) remains the
  definition of "ready" for this doc; only retry/timeout/failure-reporting mechanics change.
- Default `serverStartupTimeout: 30000` / `serverHealthCheckInterval: 250` are reasonable starting
  points; may warrant a README callout for SUTs with unusually long boot times (e.g. heavy
  migration steps) to raise the timeout explicitly.
- `stop()` remains safe to call against a process that already exited or is mid-poll (true today —
  `stop()` no-ops if `serverProcess` is null and otherwise checks `exitCode`/`signalCode` before
  attempting `SIGTERM`).
