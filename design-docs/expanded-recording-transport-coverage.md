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
