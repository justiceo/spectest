// End-to-end: the real CLI runs Arazzo documents against the stateful shop mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseResults, runCli, type CliRun } from './support/harness.js';
import { startShopServer, type ShopOptions } from './support/shop-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures', 'arazzo');

async function emptyDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'spectest-arazzo-'));
}

async function runArazzo(args: string[], shop: ShopOptions = {}, opts: { cwd?: string } = {}) {
  const server = await startShopServer(shop);
  try {
    const cwd = opts.cwd || (await emptyDir());
    const run = await runCli(['--base-url', server.url, '--test-dir', cwd, '--test-output', 'errors', ...args], { cwd });
    return { run, results: parseResults(run.stdout), requests: server.requests.map((r) => `${r.method} ${r.url}`), server };
  } finally {
    await server.close();
  }
}

function expectStatuses(results: ReturnType<typeof parseResults>, expected: Record<string, string>, run: CliRun) {
  for (const [name, status] of Object.entries(expected)) {
    assert.equal(results.get(name)?.status, status, `${name} should be ${status}\n${run.stdout}\n${run.stderr}`);
  }
}

test('control flows: polling retry, backward goto loop, end, forward goto, retry via step and via workflow, sub-workflows, failures', async () => {
  const { run, results, requests } = await runArazzo(['--arazzo', path.join(fixtures, 'flows.arazzo.yaml')], { pollsUntilSucceeded: 3 });
  expectStatuses(
    results,
    {
      'auth › login': 'passed',
      'auth › whoami': 'passed',
      'auth (workflow)': 'passed',
      'checkout › order': 'passed',
      'checkout › pay': 'passed',
      'checkout › poll': 'passed',
      'checkout › refund': 'passed',
      'checkout (workflow)': 'passed',
      'poll-loop › check': 'passed',
      'poll-loop › check (iteration 2)': 'passed',
      'poll-loop › check (iteration 3)': 'passed',
      'poll-loop › done (iteration 3)': 'passed',
      'early-end › kittens': 'passed',
      'early-end › never': 'skipped',
      'branching › pick': 'passed',
      'branching › budget': 'skipped',
      'branching › premium': 'passed',
      'refresh-retry › me': 'passed',
      'refresh-retry › refresh': 'passed',
      'refresh-retry › me (iteration 2)': 'passed',
      'retry-workflow › flaky': 'passed',
      'retry-workflow ⇢ warmup › list': 'passed',
      'retry-workflow › flaky (iteration 2)': 'passed',
      'retry-workflow › flaky (iteration 3)': 'passed',
      'retry-workflow (workflow)': 'passed',
      'subflow › buy › create': 'passed',
      'subflow › buy': 'passed',
      'subflow › confirm': 'passed',
      'place-order › create': 'skipped',
      'subflow-recovers › lookup › get': 'passed',
      'subflow-recovers › lookup': 'passed',
      'subflow-recovers › never': 'skipped',
      'subflow-recovers › fallback': 'passed',
      'endless › spin': 'passed',
      'endless › spin (iteration 2)': 'passed',
      'endless › spin (iteration 3)': 'failed',
      'endless (workflow)': 'failed-precondition',
      'broken › missing': 'failed',
      'broken › after': 'failed-precondition',
      'contract › documented': 'passed',
      'contract › undocumented': 'failed',
    },
    run
  );
  assert.equal(run.code, 1, 'the deliberately broken workflows fail the run');
  assert.equal(results.get('checkout › poll')?.attempts, 3);
  assert.match(results.get('early-end › never')!.note!, /workflow ended by onSuccess 'found-one'/);
  assert.match(results.get('refresh-retry › me')!.note!, /onFailure 'refresh-token': run step 'refresh' then retry \(1\/1\)/);
  assert.match(results.get('subflow-recovers › lookup')!.note!, /onFailure 'use-fallback': goto step 'fallback'/);
  assert.match(run.stdout, /iteration limit reached/);
  assert.match(run.stdout, /response status 418 is not documented/);
  // Unexecuted future iterations stay out of the report.
  assert.equal(results.has('checkout › order (iteration 2)'), false);
  assert.equal(results.has('poll-loop › order (iteration 2)'), false);
  // Exactly the requests the flows imply.
  const count = (pattern: RegExp) => requests.filter((r) => pattern.test(r)).length;
  assert.equal(count(/^GET \/api\/payments\/pay-\d$/), 6, 'three polls for each of the two payment flows');
  assert.equal(count(/^GET \/api\/flaky$/), 3);
  assert.equal(count(/^GET \/api\/me$/), 3, 'whoami + me (401) + me (retried)');
  assert.equal(count(/^GET \/api\/products\/2$/), 1, 'contract › documented only; branching skipped budget');
  assert.equal(count(/^GET \/api\/products\/999$/), 1);
  assert.ok(requests.includes('POST /api/payments/pay-1/refunds') || requests.includes('POST /api/payments/pay-2/refunds'));
});

test('payloads: form, JSON templates, replacements, selectors, XML/XPath, cookies, querystring, hooks, goto workflow with parameters', async () => {
  const { run, results, requests } = await runArazzo([
    '--arazzo',
    path.join(fixtures, 'payloads.arazzo.yaml'),
    '--config',
    path.join(fixtures, 'payloads.config.mjs'),
  ]);
  for (const workflow of ['form-token', 'json-template', 'replacements', 'xml', 'params', 'hooks', 'handoff', 'outputs-check']) {
    assert.equal(results.get(`${workflow} (workflow)`)?.status, 'passed', `${workflow} should pass\n${run.stdout}`);
  }
  expectStatuses(results, { 'handoff › skipped-by-handoff': 'skipped', 'handoff ⇢ show-product › show': 'passed' }, run);
  assert.equal(run.code, 0, run.stdout);
  assert.ok(requests.includes('POST /api/echo?tag=a&tag=b'));
  assert.ok(requests.includes('GET /api/search?term=fish&page=2'));
});

test('degraded documents never crash: unresolvable steps, sources, inputs, hooks and cycles become skips with reasons', async () => {
  const { run, results, requests } = await runArazzo(['--arazzo', path.join(fixtures, 'degraded.arazzo.yaml')]);
  expectStatuses(
    results,
    {
      'unknown-operation › ok': 'skipped',
      'unknown-operation › typo': 'skipped',
      'missing-source › call': 'skipped',
      'needs-inputs › call': 'skipped',
      'depends-on-skipped › call': 'failed-precondition',
      'missing-hook › call': 'skipped',
      'cycle-a › call': 'skipped',
      'cycle-b › call': 'skipped',
      'bad-subworkflow › call': 'skipped',
      'unresolved-path-param › call': 'failed',
      'bad-output › call': 'passed',
      'bad-output (workflow)': 'failed',
      'still-runs (workflow)': 'passed',
    },
    run
  );
  assert.match(results.get('unknown-operation › typo')!.note!, /was not found in any OpenAPI source description \(did you mean 'listProducts'\?\)/);
  assert.match(results.get('missing-source › call')!.note!, /could not load source description 'gone'/);
  assert.match(results.get('needs-inputs › call')!.note!, /must have required property 'apiKey'/);
  assert.match(results.get('missing-hook › call')!.note!, /missing openapiHooks entry 'notConfigured'/);
  assert.match(results.get('cycle-a › call')!.note!, /workflow dependency cycle: cycle-a → cycle-b → cycle-a/);
  assert.match(run.stdout, /path parameter 'productId' resolved to undefined/);
  assert.match(run.stdout, /step 'call' has no output 'nope'/);
  assert.match(run.stderr, /outputs\.broken: unsupported runtime expression/);
  assert.deepEqual(requests, ['GET /api/products', 'GET /api/products']);
});

test('inputs from --arazzo-inputs override config and x-spectest; --workflow selects workflows plus their dependencies', async () => {
  const dir = await emptyDir();
  await writeFile(path.join(dir, 'inputs.json'), JSON.stringify({ 'needs-inputs': { apiKey: 'k' } }));
  const { run, results } = await runArazzo(
    ['--arazzo', path.join(fixtures, 'degraded.arazzo.yaml'), '--arazzo-inputs', 'inputs.json', '--workflow', 'depends-on-skipped'],
    {},
    { cwd: dir }
  );
  expectStatuses(
    results,
    { 'needs-inputs › call': 'passed', 'depends-on-skipped › call': 'passed', 'depends-on-skipped (workflow)': 'passed' },
    run
  );
  assert.equal(results.has('still-runs › call'), false, 'other workflows are filtered out');
  assert.equal(run.code, 0);
});

test('tag and name filters keep whole workflows (and their dependencies) together', async () => {
  const { run, results } = await runArazzo(['--arazzo', path.join(fixtures, 'flows.arazzo.yaml'), '--filter', 'checkout › refund'], {
    pollsUntilSucceeded: 1,
  });
  expectStatuses(results, { 'checkout › order': 'passed', 'checkout › refund': 'passed', 'auth › login': 'passed' }, run);
  assert.equal(results.has('broken › missing'), false);
  assert.equal(run.code, 0, run.stdout);
});

test('phases, discovery, external arazzo sources, and hand-written tests that depend on workflows', async () => {
  const dir = await emptyDir();
  const shopSpec = path.join(fixtures, 'shop.openapi.yaml');
  await mkdir(path.join(dir, 'fixtures'));
  // Discovered: *.arazzo.yaml under the test dir (but not under fixtures/).
  await writeFile(
    path.join(dir, 'shop.arazzo.yaml'),
    `arazzo: 1.0.1
info: { title: Discovered, version: '1' }
sourceDescriptions:
  - { name: shop, url: ${JSON.stringify(shopSpec)}, type: openapi }
  - { name: lib, url: ./lib/flows.arazzo.yaml, type: arazzo }
workflows:
  - workflowId: session
    x-spectest: { phase: setup }
    steps:
      - stepId: login
        operationId: login
        requestBody: { payload: { username: grace, password: secret } }
        successCriteria: [{ condition: $statusCode == 200 }]
        outputs: { token: $response.body#/token }
    outputs: { token: $steps.login.outputs.token }
  - workflowId: buy
    dependsOn: [$sourceDescriptions.lib.catalog]
    steps:
      - stepId: catalog
        workflowId: $sourceDescriptions.lib.catalog
        outputs: { first: $outputs.first }
      - stepId: order
        operationId: createOrder
        parameters: [{ name: Authorization, in: header, value: 'Bearer {$workflows.session.outputs.token}' }]
        requestBody: { payload: { productId: $steps.catalog.outputs.first, quantity: 1 } }
        successCriteria: [{ condition: $statusCode == 201 }]
`
  );
  await mkdir(path.join(dir, 'lib'));
  await writeFile(
    path.join(dir, 'lib', 'flows.arazzo.yaml'),
    `arazzo: 1.0.1
info: { title: Library, version: '1' }
sourceDescriptions:
  - { name: shop, url: ${JSON.stringify(shopSpec)}, type: openapi }
workflows:
  - workflowId: catalog
    steps:
      - stepId: list
        operationId: listProducts
        outputs: { first: $response.body#/0/id }
    outputs: { first: $steps.list.outputs.first }
`
  );
  await copyFile(path.join(fixtures, 'degraded.arazzo.yaml'), path.join(dir, 'fixtures', 'ignored.arazzo.yaml'));
  await writeFile(
    path.join(dir, 'after.spectest.mjs'),
    `export default {
  name: 'hand-written',
  tests: [
    {
      name: 'reads workflow outputs',
      operationId: 'readsOutputs',
      endpoint: '/api/me',
      dependsOn: ['buy'],
      beforeSend: (req, state) => ({ ...req, headers: { ...req.headers, Authorization: 'Bearer ' + state.completedCases.session.response.data.token } }),
      response: { status: 200 },
    },
  ],
};
`
  );
  const { run, results, requests } = await runArazzo([], {}, { cwd: dir });
  assert.match(run.stdout, /Found 1 matching test files and 2 Arazzo document\(s\)/);
  expectStatuses(
    results,
    {
      'session › login': 'passed',
      'session (workflow)': 'passed',
      'lib.catalog › list': 'passed',
      'buy › catalog › list': 'passed',
      'buy › catalog': 'passed',
      'buy › order': 'passed',
      'buy (workflow)': 'passed',
      'catalog › list': 'passed',
      'reads workflow outputs': 'passed',
    },
    run
  );
  assert.equal(run.code, 0, run.stdout);
  assert.equal(requests[0], 'POST /api/auth/login', 'the setup-phase workflow runs first');
  assert.equal(results.has('still-runs › call'), false, 'documents under fixtures/ are not discovered');
});

test('arazzoStrict turns schema violations into a load failure', async () => {
  const dir = await emptyDir();
  await writeFile(
    path.join(dir, 'bad.arazzo.yaml'),
    `arazzo: 1.0.1
info: { title: Bad }
sourceDescriptions: []
workflows:
  - workflowId: w
    steps: []
`
  );
  const lenient = await runArazzo([], {}, { cwd: dir });
  assert.match(lenient.run.stderr, /schema: \/info must have required property 'version'/);
  const strict = await runArazzo(['--arazzo-strict'], {}, { cwd: dir });
  assert.equal(strict.run.code, 1);
  assert.match(strict.run.stderr, /does not conform to the Arazzo 1\.0 schema/);
});

test('the dogfood document (test/jsonplaceholder.arazzo.yaml) passes against a JSONPlaceholder-faithful mock', async () => {
  const { startMockServer } = await import('./support/harness.js');
  const server = await startMockServer((req) => {
    if (req.path === '/users/1') return { json: { id: 1, name: 'Leanne Graham', username: 'Bret', email: 'Sincere@april.biz' } };
    if (req.method === 'GET' && req.path === '/posts') {
      const userId = Number(req.query.get('userId'));
      return { json: Array.from({ length: 10 }, (_, i) => ({ userId, id: (userId - 1) * 10 + i + 1, title: `post ${i + 1}`, body: '...' })) };
    }
    if (req.method === 'POST' && req.path === '/posts') return { status: 201, json: { ...req.json, id: 101 } };
    if (req.method === 'GET' && req.path === '/posts/101') return { status: 404, json: {} };
    if (req.method === 'PATCH' && req.path === '/posts/1') return { json: { userId: 1, id: 1, title: req.json?.title, body: '...' } };
    if (req.method === 'DELETE' && req.path === '/posts/1') return { json: {} };
    if (req.path === '/posts/1/comments') return { json: [{ postId: 1, id: 1, email: 'Eliseo@gardner.biz' }] };
    return { status: 404, json: {} };
  });
  try {
    const dir = await emptyDir();
    const run = await runCli(['--base-url', server.url, '--test-dir', dir, '--arazzo', path.join(__dirname, 'jsonplaceholder.arazzo.yaml')], { cwd: dir });
    const results = parseResults(run.stdout);
    for (const name of ['user-posts › get-user', 'user-posts › list-posts', 'user-posts › comments', 'user-posts (workflow)', 'publish-post › create', 'publish-post › read-back', 'publish-post › update', 'publish-post › delete', 'publish-post (workflow)']) {
      assert.equal(results.get(name)?.status, 'passed', `${name}\n${run.stdout}\n${run.stderr}`);
    }
    assert.match(results.get('publish-post › read-back')!.note!, /onFailure 'not-persisted': goto step 'update'/);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, '', 'no load warnings');
    const created = server.requests.find((r) => r.method === 'POST')!.json;
    assert.equal(created.body, 'Written for Bret');
  } finally {
    await server.close();
  }
});
