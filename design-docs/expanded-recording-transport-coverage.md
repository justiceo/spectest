# Expanded Recording Transport Coverage

## Summary

Extend Spectest recording from "Node HTTP/1 outbound calls in the spawned SUT" to a transport-layer recording runtime for Node processes, plus an explicit edge-runtime fetch adapter. Keep the cassette owned by Spectest, but replace direct child IPC with a local recording coordinator so the main server process and any auto-instrumented child Node processes can all report to the same cassette.

This will still not make arbitrary protocols semantic. `net` and `tls` replay will be byte-stream replay: useful for deterministic socket protocols, but less stable than HTTP cassette matching.

## Public API

- Add config:
  - `recordingTransports?: Array<'http' | 'http2' | 'net' | 'tls'>`
  - Default: `['http']`, where `http` preserves current `fetch`, `http`, `https`, and XHR behavior.
  - Users opt into raw socket coverage with `['http', 'http2', 'net', 'tls']`.
- Add edge helper export:
  - `createRecordingFetch(options): typeof fetch`
  - Options mirror `useHttpRecordings`: `{ file, mode, missingRecordingBehavior?, recordingExcludeUrls? }`.
  - Intended use: edge apps explicitly call `createRecordingFetch(...)` in tests and use that fetch instead of global `fetch`.
- Extend cassette schema to support typed entries:
  - `kind: 'http' | 'http2' | 'socket'`
  - HTTP entries preserve current request/response shape.
  - HTTP/2 entries store authority, scheme, method, path, headers, request body, response headers, status, response body, and trailers.
  - Socket entries store protocol (`net` or `tls`), host, port, servername for TLS, ordered client/server byte chunks, close/error metadata, and context.

## Implementation Changes

- Replace direct child IPC with a recording coordinator started by the Spectest parent:
  - Start a localhost or Unix-domain-socket coordinator when recording is enabled.
  - Pass `SPECTEST_RECORDING_COORDINATOR_URL`, auth token, recording mode defaults, and preload path through env.
  - All instrumented processes connect to the coordinator for `decide`, `record`, and `bypass` messages.
  - Keep cassette load/save in the Spectest parent only.
- Update `recording-preload.ts`:
  - Keep current MSW interceptors for `fetch`, `http`, `https`, and XHR.
  - Patch Node `http2` incoming context by wrapping `http2.Http2Server` and `http2.Http2SecureServer` request/stream handling so Spectest headers establish `AsyncLocalStorage` context.
  - Patch Node `http2` outbound client calls by wrapping `http2.connect()` and `ClientHttp2Session.request()` to serialize request pseudo-headers/body and capture response headers/body/trailers.
  - Patch `net.connect`, `net.createConnection`, `tls.connect`, and `tls.createConnection` when enabled.
  - In record mode, wrap sockets and capture client writes plus server data chunks after connection establishment.
  - In replay mode, return a Duplex-compatible fake socket that replays recorded server chunks in order and accepts expected client writes.
  - Match socket recordings by protocol, host, port, TLS servername, and client byte-stream hash.
  - Patch `child_process.spawn`, `fork`, `exec`, and `execFile`.
  - For Node child processes, inject the Spectest preload through `NODE_OPTIONS`, preserve existing `NODE_OPTIONS`, and pass coordinator env/token to every child.
  - For non-Node commands, do not inject; their traffic can only be covered by explicit proxying or external setup.
- Add edge runtime support as explicit fetch instrumentation:
  - Implement `createRecordingFetch()` without Node-only APIs.
  - Wrap a provided or global `fetch`, serialize requests/responses with the existing cassette logic, and record/replay HTTP entries.
  - Do not provide automatic per-request Spectest context in edge v1; allow optional `context` in helper options for test metadata.
  - Document that edge runtimes cannot use `NODE_OPTIONS`, Node `http2`, `net`, `tls`, or child-process auto-instrumentation.
- Update docs to make guarantees precise:
  - Framework-independent for Node servers using HTTP/1 or HTTP/2 when Spectest starts the process.
  - Raw `net`/`tls` support is byte-stream replay, opt-in, and best for deterministic protocols.
  - Child process support applies to Node child processes where preload injection is possible.
  - Edge runtime support requires explicit fetch wrapper integration.

## Tests

- Existing HTTP recording tests must continue passing unchanged.
- Add HTTP/2 fixture:
  - Local HTTP/2 SUT receives Spectest requests and makes outbound HTTP/2 calls.
  - Record once, replay with upstream unavailable, assert same response.
  - Verify per-test recording mode context propagates through HTTP/2 request handling.
- Add socket fixtures:
  - Deterministic `net` echo-style upstream records and replays byte streams.
  - Deterministic `tls` upstream records decrypted application bytes and replays them.
  - Replay mismatch fails clearly when client byte stream differs.
- Add child-process fixture:
  - SUT spawns a Node child that performs `fetch`.
  - Child request is recorded/replayed through the shared coordinator cassette.
  - Non-Node child process is not instrumented and emits a clear debug message.
- Add edge helper tests:
  - `createRecordingFetch()` records and replays with mocked/global fetch.
  - Exclusions and missing-recording behavior match Node helper behavior.

## Assumptions

- Prioritize Node transports first: HTTP/2, raw `net`/`tls`, and Node child-process propagation.
- Raw socket replay is byte-stream based, not protocol-aware.
- Edge support is an explicit fetch wrapper, not automatic runtime patching.
- `net`/`tls` recording is opt-in because it may capture database/cache/protocol traffic and can be brittle.


## Independent Analysis Findings

  1. Line:16 defines createRecordingFetch(options): typeof fetch, but that API is not workable as written. Existing cassette loading/saving is async
     and file-backed via Node APIs in src/recording-cassette.ts:199 and src/recordings.ts:70. A true edge-runtime helper cannot take only { file, mode } and synchronously return fetch unless it
     either cannot persist recordings or secretly depends on Node. The design needs a storage model: async factory, injected cassette data, save callback, KV/R2-style adapter, or “Node test harness
     only” scope.
  2. Line:19 under-specifies cassette migration. Current entries have no kind and schemaVersion is fixed at 1 in src/recording-cassette.ts:77. Adding
     typed entries needs a new schema version, backward compatibility rules where old entries imply kind: 'http', and validation/error behavior for mixed or unknown entries.
  3. Line:36 has a likely double-recording problem. If net/tls interception is enabled alongside http, HTTP/HTTPS/fetch traffic can also appear as raw
     socket bytes underneath the existing MSW HTTP interceptors in src/recording-preload.ts:104. The design needs precedence rules or suppression markers so HTTP traffic is not recorded once
     semantically and once as byte stream.
  4. Line:38 oversimplifies tls.connect() replay. Returning a fake Duplex is not enough for code that expects TLSSocket behavior: secureConnect,
     authorized, authorizationError, ALPN, SNI, cert APIs, timeout/error ordering, half-close semantics, and stream backpressure can matter. Matching by client byte-stream hash is also awkward
     because the hash is only known after writes occur, while the fake socket must be returned immediately.
  5. Line:34 does not cover HTTP/2 multiplexing and session lifecycle. ClientHttp2Session.request() can run concurrent streams over one session,
     trailers arrive separately, :status lives in headers, and http2.connect() may involve TLS/ALPN. The plan should explicitly model per-stream request/response state and make clear whether session-
     level events/errors are recorded.
  6. Line:11 adds recordingTransports but omits the implementation surface needed in this repo: CliConfig/types/default config validation, optional CLI
     flag semantics, README docs, and probably package export updates. Current config only accepts recording, recordingFile, missingRecordingBehavior, and recordingExcludeUrls in src/config.ts:27.
  7. Line:27 says to replace direct child IPC with a coordinator, which is directionally correct because current IPC only reaches the directly spawned
     server process in src/server.ts:60. But the coordinator protocol is too thin: it needs lifecycle, bind address strategy, auth failure behavior, request timeouts, concurrent request handling,
     shutdown cleanup, and behavior when the coordinator is unavailable.
  8. Line:40 says to patch spawn, fork, exec, and execFile, but does not define Node-child detection. This is important for npm, pnpm, tsx, shell
     commands, explicit env overrides, inherited NODE_OPTIONS, and avoiding duplicate --import injection. Current top-level server injection is a simple NODE_OPTIONS append in src/server.ts:210.
  9. Line:23 notes raw socket capture may include sensitive protocol traffic, but the public API only has URL-based exclusions. recordingExcludeUrls
     cannot express raw net/tls exclusions. The design needs transport-specific exclude/redaction controls for host/port/servername and probably a stronger warning about credentials in byte streams.
  10. Line:54 test coverage is missing several high-risk cases: schema v1 cassette replay after migration, config validation/defaults, coordinator
     timeout/auth/cleanup, HTTP plus raw socket double-interception, concurrent HTTP/2 streams, NODE_OPTIONS preservation/deduplication, child processes with overridden env, edge helper bundling
     without Node imports, and transport-specific exclusions.