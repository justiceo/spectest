import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { THROTTLE_CONFIG_ENV_VAR, serializeThrottleRules } from '../src/throttle-config.js';

// This test imports throttle-preload.ts directly, which patches global fetch/http/XHR
// as a side effect (exactly what happens when it's loaded via --import in a spawned SUT).
// Node's test runner isolates each *.test.ts file in its own process, so this patching
// cannot leak into other test files.
test('throttle preload delays requests matching a rule and passes everything else through', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  process.env[THROTTLE_CONFIG_ENV_VAR] = serializeThrottleRules([{ match: '/throttled', rps: 5 }]);
  const { disposeThrottlePreload } = await import('../src/throttle-preload.js');

  try {
    const unthrottledStart = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`${base}/unthrottled`);
      assert.equal(res.status, 200);
    }
    const unthrottledElapsed = Date.now() - unthrottledStart;

    const throttledStart = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`${base}/throttled`);
      assert.equal(res.status, 200);
    }
    const throttledElapsed = Date.now() - throttledStart;

    assert.ok(
      unthrottledElapsed < 500,
      `expected non-matching requests to pass through fast, took ${unthrottledElapsed}ms`
    );
    assert.ok(
      throttledElapsed >= 900,
      `expected 12 requests at 5rps to span at least one refill cycle, took ${throttledElapsed}ms`
    );
    assert.ok(
      throttledElapsed < 4000,
      `expected throttling to not stall indefinitely, took ${throttledElapsed}ms`
    );
  } finally {
    disposeThrottlePreload();
    delete process.env[THROTTLE_CONFIG_ENV_VAR];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
