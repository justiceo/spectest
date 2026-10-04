import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateArazzoTests } from '../src/generate-command.js';
import { buildCoverageReport, formatCoverageReport } from '../src/coverage-report.js';
import type { TestCase, TestResult } from '../src/types.js';
import { parseResults, runCli } from './support/harness.js';
import { startShopServer } from './support/shop-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures', 'arazzo');
const shopSpec = path.join(fixtures, 'shop.openapi.yaml');

const doc = `arazzo: 1.0.1
info: { title: Generated Shop, version: '1' }
sourceDescriptions:
  - { name: shop, url: ${JSON.stringify(shopSpec)}, type: openapi }
workflows:
  - workflowId: session
    x-spectest: { phase: setup }
    steps:
      - stepId: login
        operationId: login
        requestBody: { payload: { username: ada, password: secret } }
        successCriteria: [{ condition: $statusCode == 200 }]
        outputs: { token: $response.body#/token }
    outputs: { token: $steps.login.outputs.token }
  - workflowId: browse
    steps:
      - stepId: list
        operationId: listProducts
        successCriteria: [{ condition: $statusCode == 200 }]
        outputs: { first: $response.body#/0/id }
      - stepId: show
        operationId: getProduct
        parameters: [{ name: productId, in: path, value: $steps.list.outputs.first }]
        successCriteria: [{ condition: $statusCode == 200 }]
      - stepId: me
        operationId: getMe
        parameters: [{ name: Authorization, in: header, value: 'Bearer {$workflows.session.outputs.token}' }]
        successCriteria: [{ condition: $statusCode == 200 }]
`;

test('generate arazzo-tests writes an editable suite that runs the document through spectest/arazzo', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spectest-gen-'));
  const docPath = path.join(dir, 'shop.arazzo.yaml');
  await writeFile(docPath, doc);
  const [file] = await generateArazzoTests(docPath, path.join(dir, 'generated'), {});
  assert.equal(path.basename(file), 'generated-shop.spectest.js');
  const source = await readFile(file, 'utf8');
  assert.match(source, /import \{ loadArazzoRuntime \} from 'spectest\/arazzo';/);
  assert.match(source, /loadArazzoRuntime\(new URL\("\.\.\/shop\.arazzo\.yaml", import\.meta\.url\)\)/);
  assert.match(source, /\.\.\.arazzo\.hooks\("session\/login"\),\n\s+"name": "session › login"/);
  assert.match(source, /"dependsOn": \[\n\s+"browse\/list"\n\s+\]/);
  const setup = source.slice(source.indexOf('setup: ['), source.indexOf('tests: ['));
  assert.match(setup, /session\/login/, 'setup-phase workflow lands in the setup section');

  // Run the generated suite (pointing its import at this checkout) with the document in the
  // test directory: it must run once, through the generated file, not also as a discovered document.
  await writeFile(file, source.replace("'spectest/arazzo'", JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'src', 'arazzo.ts')).toString())));
  const server = await startShopServer();
  try {
    const run = await runCli(['--base-url', server.url, '--test-dir', dir, '--test-output', 'errors'], { cwd: dir });
    const results = parseResults(run.stdout);
    for (const name of ['session › login', 'browse › list', 'browse › show', 'browse › me', 'browse (workflow)']) {
      assert.equal(results.get(name)?.status, 'passed', `${name}\n${run.stdout}\n${run.stderr}`);
    }
    assert.match(run.stdout, /Found 1 matching test files and 1 Arazzo document\(s\)/);
    assert.equal(run.code, 0);
    assert.equal(server.requests.filter((r) => r.path === '/api/auth/login').length, 1);
  } finally {
    await server.close();
  }
});

test('the OpenAPI coverage report credits operations exercised by Arazzo steps', async () => {
  const step = (id: string, operationId: string): TestCase => ({
    name: id,
    operationId: id,
    endpoint: '',
    source: { kind: 'arazzo', node: 'step', sourceLocation: path.resolve(shopSpec), sourceOperationId: operationId },
  });
  const tests = [step('flow/a', 'login'), step('flow/b', 'getMe'), step('flow/c', 'listProducts'), step('flow/d', 'search')];
  const result = (id: string, status: TestResult['status']): TestResult => ({
    status,
    latency: 0,
    testName: id,
    operationId: id,
    suiteName: 's',
    request: {},
    response: { status: 200, headers: {}, data: null },
  });
  const results = [result('flow/a', 'passed'), result('flow/b', 'failed'), result('flow/c', 'skipped')];
  const rows = await buildCoverageReport(shopSpec, tests, results, {});
  const byOp = new Map(rows.map((row) => [row.operationId, row.status]));
  assert.deepEqual(byOp.get('login'), { kind: 'covered-by-arazzo', steps: ['flow/a'], failed: false });
  assert.deepEqual(byOp.get('getMe'), { kind: 'covered-by-arazzo', steps: ['flow/b'], failed: true });
  assert.deepEqual(byOp.get('listProducts'), { kind: 'uncovered' }, 'a skipped step does not count');
  assert.deepEqual(byOp.get('search'), { kind: 'uncovered' }, 'a step that never ran does not count');
  assert.match(formatCoverageReport(rows), /POST\s+\/auth\/login\s+login\s+covered by Arazzo step flow\/a \(passed\)/);
});
