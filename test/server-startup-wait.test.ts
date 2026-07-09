import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Server from '../src/server.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/servers/${name}`, import.meta.url));
const serverUrl = 'http://127.0.0.1:8080';

test('Server.start() resolves once a slow-booting server becomes healthy, without waiting the full timeout', async () => {
  const server = new Server();
  server.setConfig({
    startCommand: `node ${fixture('slow-healthy.js')}`,
    serverUrl,
    runningServer: 'kill',
    serverStartupTimeout: 10000,
    serverHealthCheckInterval: 100,
  });

  const startedAt = Date.now();
  await server.start();
  const elapsed = Date.now() - startedAt;

  // Fixture becomes ready after ~1500ms; assert we resolved close to that,
  // not pinned to (or blocked until) the old fixed 3000ms delay.
  assert.ok(elapsed >= 1400, `expected to wait at least ~1500ms, waited ${elapsed}ms`);
  assert.ok(elapsed < 3000, `expected to resolve well before 3000ms, took ${elapsed}ms`);

  await server.stop();
});

test('Server.start() rejects with attempt count and elapsed time once serverStartupTimeout elapses', async () => {
  const server = new Server();
  server.setConfig({
    startCommand: `node ${fixture('never-ready.js')}`,
    serverUrl,
    runningServer: 'kill',
    serverStartupTimeout: 1000,
    serverHealthCheckInterval: 100,
  });

  await assert.rejects(
    () => server.start(),
    (error: Error) => {
      assert.match(error.message, /did not become ready within 1000ms/);
      assert.match(error.message, /health check attempt\(s\)/);
      // The fixture always answers 500, so the diagnostic should say so
      // specifically rather than a generic "no response" fallback.
      assert.match(error.message, /last failure: received status 500/);
      return true;
    }
  );
});

test('Server.start() fails fast (before the timeout) when the process crashes on boot, and surfaces stderr', async () => {
  const server = new Server();
  server.setConfig({
    startCommand: `node ${fixture('crash-on-boot.js')}`,
    serverUrl,
    runningServer: 'kill',
    serverStartupTimeout: 10000,
    serverHealthCheckInterval: 100,
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => server.start(),
    (error: Error) => {
      assert.match(error.message, /Server process exited \(code 1/);
      assert.match(error.message, /missing DATABASE_URL/);
      return true;
    }
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `expected fast failure well under the 10000ms timeout, took ${elapsed}ms`);
});

test('Server.start() reports a signal-based early exit distinctly from an exit code', async () => {
  const server = new Server();
  server.setConfig({
    startCommand: `node ${fixture('crash-on-signal.js')}`,
    serverUrl,
    runningServer: 'kill',
    serverStartupTimeout: 10000,
    serverHealthCheckInterval: 100,
  });

  await assert.rejects(
    () => server.start(),
    (error: Error) => {
      assert.match(error.message, /Server process exited \(code null, signal SIGTERM\)/);
      assert.match(error.message, /fixture self-signal crash/);
      return true;
    }
  );
});

test('debug logging is silent by default and emitted once verbose is enabled', () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: any[]) => { logs.push(args.join(' ')); };

  try {
    const quiet = new Server();
    quiet.setConfig({ serverUrl });
    assert.ok(
      !logs.some((line) => line.includes('[spectest:server]')),
      'expected no [spectest:server] debug output without verbose'
    );

    logs.length = 0;
    const loud = new Server();
    loud.setConfig({ serverUrl, verbose: true });
    assert.ok(
      logs.some((line) => line.includes('[spectest:server]') && line.includes('configured')),
      'expected [spectest:server] debug output with verbose enabled'
    );
  } finally {
    console.log = originalLog;
  }
});
