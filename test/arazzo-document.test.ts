import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import {
  buildArazzoDocument,
  loadArazzoDocument,
  rawGithubUrl,
  resolveLocation,
  validateArazzoDocument,
} from '../src/arazzo/document.js';
import { getWorkflow, mergeActions, mergeParameters, unwrapBraces } from '../src/arazzo/model.js';
import { startMockServer } from './support/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures', 'arazzo');
const suiteDir = path.join(fixtures, 'schema-suite');

async function loadYaml(file: string): Promise<any> {
  return parseYaml(await readFile(file, 'utf8'));
}

for (const version of ['1.0', '1.1']) {
  test(`official ${version} schema suite: every pass document validates`, async () => {
    const dir = path.join(suiteDir, `pass-${version}`);
    for (const file of await readdir(dir)) {
      const { errors } = validateArazzoDocument(await loadYaml(path.join(dir, file)));
      assert.deepEqual(errors, [], `${file} should validate`);
    }
  });

  test(`official ${version} schema suite: every fail document is rejected`, async () => {
    const dir = path.join(suiteDir, `fail-${version}`);
    for (const file of await readdir(dir)) {
      const doc = await loadYaml(path.join(dir, file));
      const rejected = !doc || typeof doc !== 'object' || Array.isArray(doc) || validateArazzoDocument(doc).errors.length > 0;
      assert.ok(rejected, `${file} should be rejected`);
    }
  });
}

test('non-Arazzo input throws; schema problems become warnings unless arazzoStrict', async () => {
  await assert.rejects(buildArazzoDocument('nope', 'x.yaml'), /must be an object/);
  await assert.rejects(buildArazzoDocument({ info: {} }, 'x.yaml'), /must declare an 'arazzo' version/);
  await assert.rejects(buildArazzoDocument({ arazzo: '1.0.1', workflows: [] }, 'x.yaml'), /at least one workflow/);

  const sloppy = { arazzo: '1.0.1', info: { title: 'T' }, sourceDescriptions: [], workflows: [{ workflowId: 'w', steps: [] }] };
  const doc = await buildArazzoDocument(sloppy, path.join(fixtures, 'x.yaml'));
  assert.ok(doc.warnings.some((w) => w.startsWith('schema:')), 'expected schema warnings');
  await assert.rejects(buildArazzoDocument(sloppy, path.join(fixtures, 'x.yaml'), { arazzoStrict: true }), /does not conform to the Arazzo 1.0 schema/);
});

test('unknown versions are interpreted as 1.1 with a warning', () => {
  const result = validateArazzoDocument({ arazzo: '2.0.0' });
  assert.equal(result.version, '1.1');
  assert.match(result.warnings[0], /unsupported Arazzo version '2.0.0'/);
});

test('location resolution: relative to the referring document, file URLs, and github blob rewriting', () => {
  assert.equal(resolveLocation('./b.yaml', '/a/doc.yaml'), '/a/b.yaml');
  assert.equal(resolveLocation('file:///tmp/x.yaml', '/a/doc.yaml'), '/tmp/x.yaml');
  assert.equal(resolveLocation('b.yaml', 'https://example.com/specs/doc.yaml'), 'https://example.com/specs/b.yaml');
  assert.equal(
    rawGithubUrl('https://github.com/swagger-api/swagger-petstore/blob/master/src/main/resources/openapi.yaml'),
    'https://raw.githubusercontent.com/swagger-api/swagger-petstore/master/src/main/resources/openapi.yaml'
  );
});

test('cyclic arazzo source descriptions load without deadlocking', async () => {
  const doc = await loadArazzoDocument(path.join(fixtures, 'docs', 'cyclic-a.arazzo.yaml'));
  const b = doc.sources.get('b')!.arazzo!;
  assert.equal(b.title, 'Cyclic B');
  assert.equal(b.sources.get('a')!.arazzo, doc);
  const flow = getWorkflow(doc, 'a-flow');
  assert.equal(flow.dependsOn[0].workflowId, 'b-flow');
  assert.equal(flow.steps[0].workflow!.doc, b);
});

test('remote sources are fetched; unreachable and AsyncAPI sources become per-source errors', async () => {
  const shop = await readFile(path.join(fixtures, 'shop.openapi.yaml'), 'utf8');
  const server = await startMockServer((req) => (req.path === '/shop.yaml' ? { text: shop } : { status: 404, text: 'missing' }));
  try {
    const doc = await buildArazzoDocument(
      {
        arazzo: '1.1.0',
        info: { title: 'Remote', version: '1' },
        sourceDescriptions: [
          { name: 'shop', url: `${server.url}/shop.yaml`, type: 'openapi' },
          { name: 'gone', url: `${server.url}/gone.yaml`, type: 'openapi' },
          { name: 'events', url: './events.yaml', type: 'asyncapi' },
        ],
        workflows: [
          {
            workflowId: 'w',
            steps: [
              { stepId: 'a', operationId: '$sourceDescriptions.shop.listProducts' },
              { stepId: 'b', operationId: '$sourceDescriptions.gone.listProducts' },
            ],
          },
        ],
      },
      path.join(fixtures, 'remote.arazzo.yaml')
    );
    assert.equal(doc.sources.get('shop')!.openapi!.byOperationId.has('listProducts'), true);
    assert.match(doc.sources.get('gone')!.error!, /HTTP 404/);
    assert.match(doc.sources.get('events')!.error!, /AsyncAPI/);
    const workflow = getWorkflow(doc, 'w');
    assert.equal(workflow.steps[0].error, undefined);
    assert.match(workflow.steps[1].error!, /HTTP 404/);
  } finally {
    await server.close();
  }
});

test('arazzoSources overrides replace a source location (string or object form)', async () => {
  const raw = {
    arazzo: '1.0.1',
    info: { title: 'Override', version: '1' },
    sourceDescriptions: [{ name: 'shop', url: 'https://example.invalid/shop.yaml', type: 'openapi' }],
    workflows: [{ workflowId: 'w', steps: [{ stepId: 'a', operationId: 'listProducts' }] }],
  };
  const projectRoot = fixtures;
  const viaString = await buildArazzoDocument(raw, path.join(fixtures, 'o.yaml'), { projectRoot, arazzoSources: { shop: 'shop.openapi.yaml' } });
  assert.equal(viaString.sources.get('shop')!.error, undefined);
  const viaObject = await buildArazzoDocument(raw, path.join(fixtures, 'o.yaml'), {
    projectRoot,
    arazzoSources: { shop: { url: 'shop.openapi.yaml', baseUrl: 'http://other.test' } },
  });
  assert.equal(viaObject.sources.get('shop')!.override!.baseUrl, 'http://other.test');
  assert.equal(viaObject.sources.get('shop')!.error, undefined);
});

async function shopDoc(workflows: any[], extra: Record<string, any> = {}) {
  return buildArazzoDocument(
    {
      arazzo: '1.0.1',
      info: { title: 'Shop flows', version: '1' },
      sourceDescriptions: [{ name: 'shop', url: './shop.openapi.yaml', type: 'openapi' }],
      workflows,
      ...extra,
    },
    path.join(fixtures, 'inline.arazzo.yaml')
  );
}

test('operation references: operationId (plain and qualified), operationPath (operation and single-op path item)', async () => {
  const doc = await shopDoc([
    {
      workflowId: 'w',
      steps: [
        { stepId: 'plain', operationId: 'getProduct' },
        { stepId: 'qualified', operationId: '$sourceDescriptions.shop.createOrder' },
        { stepId: 'braced', operationId: '{$sourceDescriptions.shop.getMe}' },
        { stepId: 'path', operationPath: '{$sourceDescriptions.shop.url}#/paths/~1orders~1{orderId}/delete' },
        { stepId: 'pathItem', operationPath: '{$sourceDescriptions.shop.url}#/paths/~1search' },
        { stepId: 'ambiguousItem', operationPath: '{$sourceDescriptions.shop.url}#/paths/~1orders~1{orderId}' },
        { stepId: 'caseTypo', operationId: 'GetProduct' },
        { stepId: 'nope', operationId: 'doesNotExist' },
      ],
    },
  ]);
  const steps = getWorkflow(doc, 'w').steps;
  const op = (i: number) => `${steps[i].operation?.entry.method} ${steps[i].operation?.entry.pathKey}`;
  assert.equal(op(0), 'get /products/{productId}');
  assert.equal(op(1), 'post /orders');
  assert.equal(op(2), 'get /me');
  assert.equal(op(3), 'delete /orders/{orderId}');
  assert.equal(op(4), 'get /search');
  assert.match(steps[5].error!, /several operations/);
  assert.match(steps[6].error!, /did you mean 'getProduct'/);
  assert.match(steps[7].error!, /was not found in any OpenAPI source description/);
  // path-item parameters are merged into the resolved operation
  assert.deepEqual(steps[0].operation!.parameters.map((p: any) => p.name), ['productId']);
});

test('reusable components, parameter/action merging and validation of step shapes', async () => {
  const doc = await shopDoc(
    [
      {
        workflowId: 'w',
        parameters: [
          { name: 'Authorization', in: 'header', value: 'Bearer wf' },
          { reference: '$components.parameters.page' },
        ],
        successActions: [{ name: 'done', type: 'end' }],
        failureActions: [{ reference: '$components.failureActions.retry503' }, { name: 'bail', type: 'end' }],
        steps: [
          {
            stepId: 's1',
            operationId: 'listProducts',
            parameters: [
              { name: 'Authorization', in: 'header', value: 'Bearer step' },
              { reference: '$components.parameters.page', value: 3 },
              { name: 'tag', value: 'inferred-location' },
            ],
            onFailure: [{ name: 'bail', type: 'goto', stepId: 's2' }],
          },
          { stepId: 's2', operationId: 'listProducts', successCriteria: [{ condition: '{$statusCode == 200}' }] },
          { stepId: 's3', workflowId: 'other', requestBody: { payload: {} } },
          { stepId: 's4', operationId: 'listProducts', operationPath: '{$sourceDescriptions.shop.url}#/paths/~1products/get' },
          { stepId: 's5', channelPath: '{$sourceDescriptions.shop.url}#/channels/x', action: 'send' },
          { stepId: 's6', operationId: 'listProducts', onSuccess: [{ name: 'jump', type: 'goto', stepId: 'missing' }] },
          { stepId: 's7', operationId: 'listProducts', onSuccess: [{ name: 'x', type: 'retry' }] },
        ],
      },
      { workflowId: 'other', steps: [{ stepId: 'o', operationId: 'listProducts' }] },
    ],
    {
      components: {
        parameters: { page: { name: 'page', in: 'query', value: 1 } },
        failureActions: { retry503: { name: 'retry503', type: 'retry', retryAfter: 0.5, criteria: [{ condition: '$statusCode == 503' }] } },
      },
    }
  );
  const steps = getWorkflow(doc, 'w').steps;
  assert.deepEqual(
    steps[0].parameters.map((p) => [p.name, p.in, p.value]),
    [
      ['Authorization', 'header', 'Bearer step'],
      ['page', 'query', 3],
      ['tag', 'query', 'inferred-location'],
    ]
  );
  assert.deepEqual(steps[1].parameters.map((p) => p.value), ['Bearer wf', 1]);
  // step-level 'bail' (goto) overrides the workflow-level 'bail' (end); the component retry action keeps its limit default of 1
  assert.deepEqual(steps[0].onFailure.map((a) => `${a.name}:${a.type}`), ['bail:goto', 'retry503:retry']);
  assert.equal(steps[0].onFailure[1].retryLimit, 1);
  assert.equal(steps[0].onFailure[1].retryAfter, 0.5);
  assert.deepEqual(steps[0].onSuccess.map((a) => a.name), ['done']);
  assert.equal(steps[1].successCriteria[0].condition, '{$statusCode == 200}');
  assert.match(steps[2].error!, /cannot have a requestBody/);
  assert.match(steps[3].error!, /exactly one of/);
  assert.match(steps[4].error!, /AsyncAPI/);
  assert.match(steps[5].error!, /targets unknown step 'missing'/);
  assert.match(steps[6].error!, /unsupported type 'retry'/);
});

test('inputs schemas resolve $refs into components.inputs; malformed expressions surface as warnings', async () => {
  const doc = await shopDoc(
    [
      {
        workflowId: 'w',
        inputs: { $ref: '#/components/inputs/creds' },
        steps: [{ stepId: 's', operationId: 'listProducts', outputs: { bad: '$steps.s.nope' } }],
        outputs: { alsoBad: '$inputs' },
      },
    ],
    { components: { inputs: { creds: { type: 'object', properties: { user: { $ref: '#/components/inputs/user' } } }, user: { type: 'string' } } } }
  );
  const workflow = getWorkflow(doc, 'w');
  assert.deepEqual(workflow.inputsSchema, { type: 'object', properties: { user: { type: 'string' } } });
  assert.equal(workflow.warnings.length, 2);
  assert.match(workflow.warnings[0], /step 's' outputs\.bad/);
});

test('helpers: unwrapBraces, mergeParameters, mergeActions', () => {
  assert.equal(unwrapBraces('{$statusCode == 401}'), '$statusCode == 401');
  assert.equal(unwrapBraces('{$a} and {$b}'), '{$a} and {$b}');
  assert.deepEqual(
    mergeParameters([{ name: 'a', in: 'query', value: 1 }, { name: 'b', in: 'query', value: 2 }], [{ name: 'a', in: 'query', value: 9 }]).map((p) => p.value),
    [9, 2]
  );
  const action = (name: string) => ({ key: name, name, kind: 'success' as const, type: 'end' as const, parameters: [], criteria: [] });
  assert.deepEqual(mergeActions([action('x')], [action('y'), action('x')]).map((a) => a.name), ['x', 'y']);
});
