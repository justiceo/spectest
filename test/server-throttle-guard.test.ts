import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Server from '../src/server.js';

test('Server.start() rejects outboundThrottle combined with runningServer "reuse" against an already-running server', async () => {
  const existing = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
  const { port } = existing.address() as AddressInfo;

  const server = new Server();
  server.setConfig({
    serverUrl: `http://127.0.0.1:${port}`,
    runningServer: 'reuse',
    throttle: {
      enabled: true,
      preloadPath: '/does/not/matter.js',
      rules: [{ match: 'openprovider.eu', rps: 1 }],
    },
  });

  await assert.rejects(() => server.start(), /outboundThrottle/i);

  await new Promise<void>((resolve) => existing.close(() => resolve()));
});

test('Server.start() reuses an already-running server when outboundThrottle is not configured', async () => {
  const existing = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
  const { port } = existing.address() as AddressInfo;

  const server = new Server();
  server.setConfig({
    serverUrl: `http://127.0.0.1:${port}`,
    runningServer: 'reuse',
  });

  await assert.doesNotReject(() => server.start());

  await new Promise<void>((resolve) => existing.close(() => resolve()));
});
