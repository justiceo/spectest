import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { runTest, cloneStateForHook } from '../src/cli.js';
import { HttpClient } from '../src/http-client.js';
import { PluginHost } from '../src/plugin-host.js';
import RateLimiter from '../src/rate-limiter.js';
import type { TestCase } from '../src/types.js';
import { parseResults, runCli, startMockServer } from './support/harness.js';

async function harness(handler: Parameters<typeof startMockServer>[0]) {
  const server = await startMockServer(handler);
  const host = new PluginHost([]);
  await host.setup();
  const api = new HttpClient({ baseURL: server.url, timeout: 5000, pluginHost: host });
  const limiter = new RateLimiter(Infinity);
  const sut = { getLogs: () => [] } as any;
  const state = { sessionCookie: null, completedCases: {} as Record<string, any> };
  const run = (t: TestCase) => runTest(t, api, state, sut, limiter, { recording: 'off' });
  return { server, run, state, close: () => server.close() };
}

test('assert hook failures fail the test but keep the response on the result', async () => {
  const h = await harness(() => ({ status: 200, json: { ok: false } }));
  try {
    const result = await h.run({
      name: 'a',
      operationId: 'a',
      endpoint: '/x',
      assert: (res) => (res.data.ok ? [] : ['expected ok to be true']),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /expected ok to be true/);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.response.data, { ok: false });
  } finally {
    await h.close();
  }
});

test('assert hook can attach a note to a passing result, and a throwing hook is reported', async () => {
  const h = await harness(() => ({ status: 200, json: {} }));
  try {
    const noted = await h.run({ name: 'n', operationId: 'n', endpoint: '/x', assert: () => ({ note: 'tolerated' }) });
    assert.equal(noted.status, 'passed');
    assert.equal(noted.note, 'tolerated');
    const thrown = await h.run({
      name: 't',
      operationId: 't',
      endpoint: '/x',
      assert: () => {
        throw new Error('boom');
      },
    });
    assert.equal(thrown.status, 'failed');
    assert.match(thrown.error!, /assert hook threw: boom/);
  } finally {
    await h.close();
  }
});

test('retry re-sends until the test passes and records the attempt count', async () => {
  let calls = 0;
  const h = await harness(() => {
    calls += 1;
    return calls < 3 ? { status: 503, json: {} } : { status: 200, json: { done: true } };
  });
  try {
    const result = await h.run({ name: 'r', operationId: 'r', endpoint: '/x', response: { status: 200 }, retry: { limit: 5, delayMs: 5 } });
    assert.equal(result.status, 'passed');
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  } finally {
    await h.close();
  }
});

test('retry stops at the limit and reports the last failure', async () => {
  let calls = 0;
  const h = await harness(() => {
    calls += 1;
    return { status: 503, json: {} };
  });
  try {
    const result = await h.run({ name: 'r', operationId: 'r', endpoint: '/x', response: { status: 200 }, retry: { limit: 2 } });
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  } finally {
    await h.close();
  }
});

test('an assert retry hint drives retries; shouldRetry and retry:false can veto', async () => {
  let calls = 0;
  const h = await harness(() => {
    calls += 1;
    return { status: 200, json: { n: calls } };
  });
  try {
    const hinted = await h.run({
      name: 'h',
      operationId: 'h',
      endpoint: '/x',
      retry: { limit: 4 },
      assert: (res, _state, ctx) => {
        ctx.scratch.seen = (ctx.scratch.seen || 0) + 1;
        return res.data.n < 3 ? { errors: ['not yet'], retry: { delayMs: 1 } } : { note: `seen ${ctx.scratch.seen} at attempt ${ctx.attempt}` };
      },
    });
    assert.equal(hinted.status, 'passed');
    assert.equal(hinted.note, 'seen 3 at attempt 3');

    calls = 0;
    const vetoed = await h.run({
      name: 'v',
      operationId: 'v',
      endpoint: '/x',
      retry: { limit: 4 },
      assert: () => ({ errors: ['hard failure'], retry: false }),
    });
    assert.equal(vetoed.status, 'failed');
    assert.equal(vetoed.attempts, undefined);
    assert.equal(calls, 1);

    calls = 0;
    const custom = await h.run({
      name: 'c',
      operationId: 'c',
      endpoint: '/x',
      retry: { limit: 4, shouldRetry: (result) => result.response.data.n < 2 },
    });
    assert.equal(custom.status, 'passed');
    assert.equal(custom.attempts, 2);
  } finally {
    await h.close();
  }
});

test('virtual tests send no request and take their data from assert', async () => {
  const h = await harness(() => ({ status: 200, json: {} }));
  try {
    const result = await h.run({
      name: 'v',
      operationId: 'v',
      endpoint: '',
      virtual: true,
      assert: () => ({ data: { summary: 1 } }),
    });
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.response.data, { summary: 1 });
    assert.equal(h.server.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('cloneStateForHook turns stored Headers into plain objects', () => {
  const cloned = cloneStateForHook({ completedCases: { a: { response: { headers: new Headers({ 'X-Token': 'abc' }) } } } });
  assert.deepEqual(cloned.completedCases.a.response.headers, { 'x-token': 'abc' });
});

test('HttpClient keeps an explicit content type and passes URLSearchParams bodies through', async () => {
  const h = await harness(() => ({ status: 200, json: {} }));
  try {
    await h.run({
      name: 'json',
      operationId: 'json',
      endpoint: '/patch',
      request: { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: { a: 1 } },
    });
    await h.run({
      name: 'form',
      operationId: 'form',
      endpoint: '/form',
      request: { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials' }) },
    });
    const [patch, form] = h.server.requests;
    assert.equal(patch.headers['content-type'], 'application/merge-patch+json');
    assert.equal(patch.body, '{"a":1}');
    assert.equal(form.body, 'grant_type=client_credentials');
    assert.match(String(form.headers['content-type']), /application\/x-www-form-urlencoded/);
  } finally {
    await h.close();
  }
});

test('scheduler: a when() skip releases dependents, a failure cascades, and quiet tests stay hidden unless run', async () => {
  const server = await startMockServer((req) => (req.path === '/fail' ? { status: 500, json: {} } : { status: 200, json: { path: req.path } }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spectest-core-'));
  await writeFile(
    path.join(dir, 'flow.spectest.mjs'),
    `export default {
  name: 'flow',
  tests: [
    { name: 'gate', operationId: 'gate', endpoint: '/gate', when: () => ({ skip: 'feature off' }) },
    { name: 'after gate', operationId: 'afterGate', endpoint: '/after', dependsOn: ['gate'], response: { status: 200 } },
    { name: 'hidden skip', operationId: 'hiddenSkip', endpoint: '/hidden', quiet: true, when: () => false },
    { name: 'hidden run', operationId: 'hiddenRun', endpoint: '/hidden-run', quiet: true, dependsOn: ['hiddenSkip'], response: { status: 200 } },
    { name: 'breaks', operationId: 'breaks', endpoint: '/fail', response: { status: 200 } },
    { name: 'after break', operationId: 'afterBreak', endpoint: '/never', dependsOn: ['breaks'] },
    { name: 'quiet after break', operationId: 'quietAfterBreak', endpoint: '/never', quiet: true, dependsOn: ['breaks'] },
  ],
};
`
  );
  try {
    const run = await runCli(['--base-url', server.url, '--test-dir', dir]);
    const results = parseResults(run.stdout);
    assert.equal(results.get('gate')?.status, 'skipped');
    assert.equal(results.get('gate')?.note, 'feature off');
    assert.equal(results.get('after gate')?.status, 'passed');
    assert.equal(results.has('hidden skip'), false);
    assert.equal(results.get('hidden run')?.status, 'passed');
    assert.equal(results.get('breaks')?.status, 'failed');
    assert.equal(results.get('after break')?.status, 'failed-precondition');
    assert.equal(results.has('quiet after break'), false);
    assert.equal(run.code, 1);
    assert.equal(server.requests.some((r) => r.path === '/gate' || r.path === '/hidden' || r.path === '/never'), false);
  } finally {
    await server.close();
  }
});
