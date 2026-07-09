import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadConfigFromCliOpts } from '../src/config.js';

function withStubbedExit<T>(fn: () => Promise<T>): Promise<{ exitCode?: number; result?: T; threw: boolean }> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  (process as any).exit = (code?: number) => {
    exitCode = code;
    throw new Error('process.exit called');
  };
  return fn()
    .then((result) => ({ exitCode, result, threw: false }))
    .catch(() => ({ exitCode, threw: true }))
    .finally(() => {
      process.exit = originalExit;
    }) as any;
}

test('serverStartupTimeout and serverHealthCheckInterval default when not configured', async () => {
  const cfg = await loadConfigFromCliOpts({});
  assert.equal(cfg.serverStartupTimeout, 30000);
  assert.equal(cfg.serverHealthCheckInterval, 250);
});

test('a valid --server-startup-timeout flag is parsed through to the resolved config', async () => {
  const cfg = await loadConfig(['node', 'cli.js', '--server-startup-timeout', '5000', '--server-health-check-interval', '50']);
  assert.equal(cfg.serverStartupTimeout, 5000);
  assert.equal(cfg.serverHealthCheckInterval, 50);
});

test('--server-startup-timeout rejects a non-positive value at CLI-parse time', async () => {
  const { exitCode, threw } = await withStubbedExit(() =>
    loadConfig(['node', 'cli.js', '--server-startup-timeout', '-5'])
  );
  assert.ok(threw);
  assert.equal(exitCode, 1);
});

test('--server-startup-timeout rejects a non-numeric value at CLI-parse time', async () => {
  const { exitCode, threw } = await withStubbedExit(() =>
    loadConfig(['node', 'cli.js', '--server-startup-timeout', 'soon'])
  );
  assert.ok(threw);
  assert.equal(exitCode, 1);
});

test('a config-file-provided negative serverHealthCheckInterval fails validation', async () => {
  const { exitCode, threw } = await withStubbedExit(() =>
    loadConfigFromCliOpts({ serverHealthCheckInterval: -50 } as any)
  );
  assert.ok(threw);
  assert.equal(exitCode, 1);
});
