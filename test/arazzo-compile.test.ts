import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArazzoDocument } from '../src/arazzo/document.js';
import { compileArazzoDocument } from '../src/arazzo/compile.js';
import { getWorkflow } from '../src/arazzo/model.js';
import { buildRequest, renderJsonTemplate, schemaDefaults, validateAgainstOperation, validateInputs } from '../src/arazzo/runtime.js';
import type { TestCase } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures', 'arazzo');

async function compile(workflows: any[], extra: Record<string, any> = {}, cfg: Record<string, any> = {}) {
  const doc = await buildArazzoDocument(
    {
      arazzo: '1.0.1',
      info: { title: 'Compile', version: '1' },
      sourceDescriptions: [{ name: 'shop', url: './shop.openapi.yaml', type: 'openapi' }],
      workflows,
      ...extra,
    },
    path.join(fixtures, 'compile.arazzo.yaml'),
    cfg
  );
  return compileArazzoDocument(doc, cfg);
}

const byId = (tests: TestCase[], id: string) => {
  const found = tests.find((t) => t.operationId === id);
  assert.ok(found, `expected node '${id}' in ${tests.map((t) => t.operationId).join(', ')}`);
  return found!;
};

test('a linear workflow becomes a dependsOn chain ending in a virtual workflow node', async () => {
  const { tests, suite } = await compile([
    {
      workflowId: 'w',
      steps: [
        { stepId: 'a', operationId: 'listProducts' },
        { stepId: 'b', operationId: 'getProduct', parameters: [{ name: 'productId', in: 'path', value: 1 }] },
      ],
    },
  ]);
  assert.deepEqual(tests.map((t) => t.operationId), ['w/a', 'w/b', 'w']);
  assert.equal(byId(tests, 'w/a').dependsOn, undefined);
  assert.deepEqual(byId(tests, 'w/b').dependsOn, ['w/a']);
  assert.deepEqual(byId(tests, 'w').dependsOn, ['w/b']);
  assert.equal(byId(tests, 'w').virtual, true);
  const a = byId(tests, 'w/a');
  assert.equal(a.name, 'w › a');
  assert.equal(a.endpoint, '/api/products', 'the OpenAPI server prefix is applied');
  assert.equal(a.request?.method, 'GET');
  assert.deepEqual(a.tags, ['arazzo', 'arazzo:w']);
  assert.equal(a.source?.sourceOperationId, 'listProducts');
  assert.equal(a.source?.group, 'w');
  assert.equal(typeof a.when, 'function');
  assert.equal(typeof a.beforeSend, 'function');
  assert.equal(typeof a.assert, 'function');
  assert.equal(suite.name, 'Compile');
  assert.equal(suite.tests.length, 3);
});

test('backward jumps unroll iterations; later iterations and blocks are quiet', async () => {
  const { tests } = await compile(
    [
      {
        workflowId: 'loop',
        'x-spectest': { maxIterations: 3 },
        steps: [
          { stepId: 'a', operationId: 'listProducts' },
          { stepId: 'b', operationId: 'listProducts', onSuccess: [{ name: 'back', type: 'goto', stepId: 'a' }] },
        ],
      },
      {
        workflowId: 'handoff',
        steps: [{ stepId: 'x', operationId: 'listProducts', onSuccess: [{ name: 'go', type: 'goto', workflowId: 'target' }] }],
      },
      { workflowId: 'target', steps: [{ stepId: 't', operationId: 'listProducts' }] },
    ],
    {},
    { arazzoMaxIterations: 7 }
  );
  const loop = tests.filter((t) => t.source?.group === 'loop').map((t) => t.operationId);
  assert.deepEqual(loop, ['loop/a', 'loop/b', 'loop/a#2', 'loop/b#2', 'loop/a#3', 'loop/b#3', 'loop']);
  assert.equal(byId(tests, 'loop/a').quiet, undefined);
  assert.equal(byId(tests, 'loop/a#2').quiet, true);
  assert.equal(byId(tests, 'loop/b#3').name, 'loop › b (iteration 3)');
  const handoff = tests.filter((t) => t.source?.group === 'handoff').map((t) => t.operationId);
  assert.deepEqual(handoff, ['handoff/x', 'handoff!1-go/t', 'handoff!1-go', 'handoff'], 'no backward jump, so one iteration plus the goto block');
  assert.equal(byId(tests, 'handoff!1-go/t').quiet, true);
  assert.equal(byId(tests, 'handoff!1-go').virtual, true);
});

test('workflow steps inline the child workflow before a join node; plain retries get a retry budget', async () => {
  const { tests } = await compile([
    {
      workflowId: 'parent',
      steps: [
        { stepId: 'call', workflowId: 'child', parameters: [{ name: 'id', value: 2 }] },
        {
          stepId: 'poll',
          operationId: 'getFlaky',
          onFailure: [
            { name: 'r1', type: 'retry', retryLimit: 2, criteria: [{ condition: '$statusCode == 503' }] },
            { name: 'r2', type: 'retry' },
          ],
        },
      ],
    },
    { workflowId: 'child', steps: [{ stepId: 'get', operationId: 'getProduct', parameters: [{ name: 'productId', in: 'path', value: '$inputs.id' }] }] },
  ]);
  const parent = tests.filter((t) => t.source?.group === 'parent').map((t) => t.operationId);
  assert.deepEqual(parent, ['parent/call/get', 'parent/call', 'parent/poll', 'parent']);
  assert.equal(byId(tests, 'parent/call/get').quiet, true);
  assert.equal(byId(tests, 'parent/call').virtual, true);
  assert.equal(byId(tests, 'parent/call').source?.calls, 'child');
  assert.equal(byId(tests, 'parent/poll').retry?.limit, 3);
});

test('workflow dependencies wire first nodes to dependency terminals; phases partition the suite', async () => {
  const { tests, suite, program } = await compile([
    { workflowId: 'login', 'x-spectest': { phase: 'setup' }, steps: [{ stepId: 's', operationId: 'listProducts' }], outputs: { t: '$steps.s.outputs.x' } },
    { workflowId: 'a', steps: [{ stepId: 's', operationId: 'listProducts', parameters: [{ name: 'Authorization', in: 'header', value: '$workflows.login.outputs.t' }] }] },
    { workflowId: 'b', dependsOn: ['a'], steps: [{ stepId: 's', operationId: 'listProducts' }] },
    { workflowId: 'cleanup', 'x-spectest': { phase: 'teardown' }, steps: [{ stepId: 's', operationId: 'listProducts' }] },
    { workflowId: 'early', dependsOn: ['cleanup'], steps: [{ stepId: 's', operationId: 'listProducts' }] },
  ]);
  assert.deepEqual(byId(tests, 'b/s').dependsOn, ['a']);
  assert.equal(byId(tests, 'a/s').dependsOn, undefined, 'cross-phase edge to the setup workflow is dropped');
  assert.deepEqual(suite.setup.map((t) => t.operationId), ['login/s', 'login']);
  assert.deepEqual(suite.teardown.map((t) => t.operationId), ['cleanup/s', 'cleanup']);
  assert.ok(program.warnings.some((w) => /'early' \(main\) depends on 'cleanup', which runs later \(teardown\)/.test(w)));
});

test('statically broken workflows emit skipped nodes under the same ids; idPrefix namespaces ids', async () => {
  const { tests } = await compile(
    [
      { workflowId: 'bad', steps: [{ stepId: 'a', operationId: 'listProducts' }, { stepId: 'b', operationId: 'nope' }] },
      { workflowId: 'skipped', 'x-spectest': { skip: true, skipReason: 'manual only' }, steps: [{ stepId: 'a', operationId: 'listProducts' }] },
    ],
    { 'x-spectest': { idPrefix: 'shop:' } }
  );
  assert.deepEqual(tests.map((t) => t.operationId), ['shop:bad/a', 'shop:bad/b', 'shop:bad', 'shop:skipped/a', 'shop:skipped']);
  assert.equal(byId(tests, 'shop:bad/a').skip, true);
  assert.match(byId(tests, 'shop:bad/a').skipReason!, /step 'b': operationId 'nope' was not found/);
  assert.match(byId(tests, 'shop:bad/b').skipReason!, /operationId 'nope' was not found/);
  assert.equal(byId(tests, 'shop:skipped/a').skipReason, 'manual only');
});

test('source overrides: baseUrl makes endpoints absolute, server picks the path prefix', async () => {
  const doc = await buildArazzoDocument(
    {
      arazzo: '1.0.1',
      info: { title: 'Override', version: '1' },
      sourceDescriptions: [{ name: 'shop', url: './shop.openapi.yaml', type: 'openapi' }],
      workflows: [{ workflowId: 'w', steps: [{ stepId: 'a', operationId: 'listProducts' }] }],
    },
    path.join(fixtures, 'o.arazzo.yaml'),
    { arazzoSources: { shop: { baseUrl: 'http://payments.test/' } } }
  );
  const { tests } = await compileArazzoDocument(doc, { arazzoSources: { shop: { baseUrl: 'http://payments.test/' } } });
  assert.equal(byId(tests, 'w/a').endpoint, 'http://payments.test/api/products');
});

test('renderJsonTemplate keeps the type of quoted single expressions and escapes embedded ones', () => {
  const values: Record<string, unknown> = { '$inputs.obj': { a: 1 }, '$inputs.n': 5, '$inputs.s': 'say "hi"', '$inputs.missing': undefined };
  const out = renderJsonTemplate('{"o": "{$inputs.obj}", "n": "{$inputs.n}", "raw": {$inputs.n}, "s": "x {$inputs.s}", "m": "{$inputs.missing}"}', (source) => values[source]);
  assert.deepEqual(JSON.parse(out), { o: { a: 1 }, n: 5, raw: 5, s: 'x say "hi"', m: null });
  assert.equal(renderJsonTemplate('{"esc": "a \\" {$inputs.n}"}', (source) => values[source]), '{"esc": "a \\" 5"}');
});

test('buildRequest serializes path, query, header, cookie and querystring parameters', async () => {
  const doc = await buildArazzoDocument(
    {
      arazzo: '1.1.0',
      info: { title: 'Req', version: '1' },
      sourceDescriptions: [{ name: 'shop', url: './shop.openapi.yaml', type: 'openapi' }],
      workflows: [
        {
          workflowId: 'w',
          steps: [
            {
              stepId: 'a',
              operationId: 'getProduct',
              parameters: [
                { name: 'productId', in: 'path', value: [1, 2] },
                { name: 'tag', in: 'query', value: ['x', 'y'] },
                { name: 'page', in: 'query', value: 3 },
                { name: 'Skip', in: 'query', value: '$inputs.absent' },
                { name: 'X-Obj', in: 'header', value: { k: 'v' } },
                { name: 'sid', in: 'cookie', value: 'abc' },
              ],
            },
            { stepId: 'b', operationId: 'search', parameters: [{ name: 'qs', in: 'querystring', value: { a: 1, b: 'two words' } }] },
            { stepId: 'c', operationId: 'getProduct' },
          ],
        },
      ],
    },
    path.join(fixtures, 'req.arazzo.yaml')
  );
  const { program } = await compileArazzoDocument(doc, {});
  const scope = program.topScopes.values().next().value!;
  const workflow = getWorkflow(doc, 'w');
  const ctx = { scope, state: { completedCases: {} } };
  const staticRequest = (template: string) => ({ method: 'GET', urlTemplate: template, headers: { 'X-Static': '1' }, query: new URLSearchParams() });
  const a = await buildRequest(scope, workflow.steps[0], staticRequest('/api/products/{productId}'), ctx);
  assert.equal(a.url, '/api/products/1%2C2?tag=x&tag=y&page=3');
  assert.deepEqual(a.headers, { 'X-Static': '1', 'X-Obj': '{"k":"v"}', Cookie: 'sid=abc' });
  assert.deepEqual(a.spectestMeta.pathParams, { productId: [1, 2] });
  const b = await buildRequest(scope, workflow.steps[1], staticRequest('/api/search'), ctx);
  assert.equal(b.url, '/api/search?a=1&b=two+words');
  await assert.rejects(buildRequest(scope, workflow.steps[2], staticRequest('/api/products/{productId}'), ctx), /path parameter 'productId' has no value/);
});

test('inputs helpers and the OpenAPI contract check', async () => {
  assert.deepEqual(schemaDefaults({ properties: { a: { default: 1 }, b: { type: 'string' } } }), { a: 1 });
  assert.deepEqual(validateInputs({ n: 1 }, { type: 'object', properties: { n: { type: 'integer', format: 'int64' } } }), []);
  assert.match(validateInputs({}, { type: 'object', required: ['x'] })[0], /must have required property 'x'/);

  const doc = await buildArazzoDocument(
    {
      arazzo: '1.0.1',
      info: { title: 'Contract', version: '1' },
      sourceDescriptions: [{ name: 'shop', url: './shop.openapi.yaml', type: 'openapi' }],
      workflows: [{ workflowId: 'w', steps: [{ stepId: 'a', operationId: 'getProduct' }] }],
    },
    path.join(fixtures, 'c.arazzo.yaml')
  );
  const step = getWorkflow(doc, 'w').steps[0];
  const json = new Headers({ 'content-type': 'application/json' });
  assert.deepEqual(validateAgainstOperation(step, 200, json, { id: 1, name: 'x', price: 1 }), []);
  assert.match(validateAgainstOperation(step, 200, json, { id: 'one' })[0], /does not match the OpenAPI schema for 200/);
  assert.deepEqual(validateAgainstOperation(step, 404, json, { error: 'nope' }), []);
  assert.match(validateAgainstOperation(step, 500, json, {})[0], /response status 500 is not documented .* \(documented: 200, 404\)/);
});

test('x-spectest.security applies openapiAuth hooks (default and named variants); a missing hook skips the workflow', async () => {
  const cfg = {
    openapiAuth: {
      bearer: {
        valid: () => ({ headers: { Authorization: 'Bearer good' } }),
        expired: () => ({ headers: { Authorization: 'Bearer old' } }),
      },
    },
  };
  const { tests } = await compile(
    [
      { workflowId: 'a', 'x-spectest': { security: true }, steps: [{ stepId: 'me', operationId: 'getMe' }] },
      { workflowId: 'b', steps: [{ stepId: 'me', operationId: 'getMe', 'x-spectest': { security: 'expired' } }] },
      { workflowId: 'c', steps: [{ stepId: 'me', operationId: 'getMe' }] },
      { workflowId: 'd', steps: [{ stepId: 'me', operationId: 'getMe', 'x-spectest': { security: 'revoked' } }] },
    ],
    {},
    cfg
  );
  assert.deepEqual(byId(tests, 'a/me').request?.headers, { Authorization: 'Bearer good' });
  assert.deepEqual(byId(tests, 'b/me').request?.headers, { Authorization: 'Bearer old' });
  assert.deepEqual(byId(tests, 'c/me').request?.headers, {}, 'auth hooks are opt-in for Arazzo steps');
  assert.equal(byId(tests, 'd/me').skip, true);
  assert.match(byId(tests, 'd/me').skipReason!, /missing auth hook variant 'revoked'/);
});
