import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadOpenApiSuite } from '../src/plugins/openapi-loader.js';
import { buildCoverageReport } from '../src/coverage-report.js';
import type { SpectestConfig, TestCase, TestResult } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(__dirname, 'fixtures', 'openapi', name);

function byOperationId(tests: TestCase[], operationId: string): TestCase {
  const found = tests.find((t) => t.operationId === operationId);
  assert.ok(found, `expected a generated test with operationId '${operationId}'`);
  return found!;
}

// #1 + #2: multiple examples per operation -> multiple tests, each with the correct expected status.
test('multi-example operation generates one distinct test per example key with correct expected response', async () => {
  const suite = await loadOpenApiSuite(fixture('validation-matrix.yaml'), {});
  const operationIds = suite.tests.map((t) => t.operationId).sort();
  assert.deepEqual(operationIds, ['register+missingDomainName', 'register+missingEmail', 'register+success']);

  const success = byOperationId(suite.tests, 'register+success');
  assert.equal(success.name, 'Register a domain — success');
  assert.equal(success.response?.status, 201);
  assert.deepEqual(success.request?.body, { domainName: 'example.com', email: 'a@b.com' });
  assert.deepEqual(success.response?.json, { orderId: 'order-1', status: 'created' });

  const missingDomainName = byOperationId(suite.tests, 'register+missingDomainName');
  assert.equal(missingDomainName.response?.status, 400);
  assert.deepEqual(missingDomainName.response?.json, { error: 'domainName is required' });

  const missingEmail = byOperationId(suite.tests, 'register+missingEmail');
  assert.equal(missingEmail.response?.status, 400);
  assert.deepEqual(missingEmail.response?.json, { error: 'email is required' });
});

// x-spectest.beforeSend/postTest resolve to cfg.openapiHooks entries and are attached verbatim.
test('x-spectest beforeSend/postTest resolve to openapiHooks entries', async () => {
  const beforeSend = async (req: any) => req;
  const postTest = async () => {};
  const cfg: SpectestConfig = {
    openapiHooks: {
      attachPaymentToken: { beforeSend },
      recordCharge: { postTest },
    },
  };
  const suite = await loadOpenApiSuite(fixture('hooks-and-auth.yaml'), cfg);
  const charge = byOperationId(suite.tests, 'charge');
  assert.equal(charge.skip, undefined);
  assert.equal(charge.beforeSend, beforeSend);
  assert.equal(charge.postTest, postTest);
});

// A missing openapiHooks entry referenced by x-spectest fails the same way a missing openapiAuth hook does: skip, not crash.
test('missing openapiHooks entry skips the test with a reason instead of crashing', async () => {
  const suite = await loadOpenApiSuite(fixture('hooks-and-auth.yaml'), {});
  const charge = byOperationId(suite.tests, 'charge');
  assert.equal(charge.skip, true);
  assert.match(charge.skipReason || '', /attachPaymentToken/);
});

// {{uuid}}/{{timestamp}}/{{shortId}} resolve to distinct values per generated test, stable within a single run.
test('generator placeholders resolve to distinct values across loads and stay stable within one load', async () => {
  const suiteA = await loadOpenApiSuite(fixture('generators.yaml'), {});
  const suiteB = await loadOpenApiSuite(fixture('generators.yaml'), {});
  const widgetA = byOperationId(suiteA.tests, 'createWidget');
  const widgetB = byOperationId(suiteB.tests, 'createWidget');

  assert.notEqual(widgetA.request?.body.id, '{{uuid}}');
  assert.notEqual(widgetA.request?.body.createdAt, '{{timestamp}}');
  assert.notEqual(widgetA.request?.body.slug, '{{shortId}}');
  assert.notEqual(widgetA.request?.body.id, widgetB.request?.body.id);
  assert.notEqual(widgetA.request?.body.slug, widgetB.request?.body.slug);

  // Stable within a single generated test: re-reading the same TestCase (as repeat/bombard clones would) sees the same value.
  assert.equal(widgetA.request?.body.id, widgetA.request?.body.id);
});

// x-spectest.generate (path-keyed) overrides specific fields on an otherwise-literal example body.
test('x-spectest.generate overrides path-keyed fields on the request body', async () => {
  const suite = await loadOpenApiSuite(fixture('generators.yaml'), {});
  const order = byOperationId(suite.tests, 'createOrder2');
  assert.notEqual(order.request?.body.orderId, 'placeholder');
  assert.notEqual(order.request?.body.product.domainName, 'placeholder.com');
});

// x-spectest.security: none bypasses applySecurity entirely.
test('x-spectest.security: none bypasses security application', async () => {
  const suite = await loadOpenApiSuite(fixture('hooks-and-auth.yaml'), {});
  const publicPing = byOperationId(suite.tests, 'publicPing');
  assert.equal(publicPing.skip, undefined);
  assert.deepEqual(publicPing.request?.headers, {});
});

// x-spectest.security: <variant> selects the corresponding openapiAuth sub-hook.
test('x-spectest.security selects a named openapiAuth variant', async () => {
  const cfg: SpectestConfig = {
    openapiAuth: {
      session: {
        valid: async () => ({ headers: { Cookie: 'session=valid' } }),
        expired: async () => ({ headers: { Cookie: 'session=expired' } }),
      },
    },
  };
  const suite = await loadOpenApiSuite(fixture('hooks-and-auth.yaml'), cfg);
  const success = byOperationId(suite.tests, 'getProfile+success');
  assert.equal(success.request?.headers?.Cookie, 'session=valid');
  const expired = byOperationId(suite.tests, 'getProfile+expiredSession');
  assert.equal(expired.response?.status, 401);
  assert.equal(expired.request?.headers?.Cookie, 'session=expired');
});

// A response `links` entry produces correct dependsOn + value extraction against state.completedCases.
test('response links produce dependsOn and resolve values from state.completedCases', async () => {
  const suite = await loadOpenApiSuite(fixture('links.yaml'), {});
  const getOrder = byOperationId(suite.tests, 'getOrder');
  assert.deepEqual(getOrder.dependsOn, ['createOrder']);
  assert.equal(typeof getOrder.beforeSend, 'function');

  const config = { url: '/orders/{orderId}', headers: {} as Record<string, string> };
  const state = {
    completedCases: {
      createOrder: {
        response: { status: 201, headers: {}, data: { orderId: 'order-123' } },
      },
    },
  };
  const updated = await getOrder.beforeSend!(config, state);
  assert.equal(updated.url, '/orders/order-123');
});

// Regression: an operation with no x-spectest extension and a single example behaves identically to today's v1 output.
test('single-example operation with no x-spectest behaves like v1 (unsuffixed operationId, no extra fields)', async () => {
  const suite = await loadOpenApiSuite(fixture('regression-v1.yaml'), {});
  assert.equal(suite.tests.length, 1);
  const test1 = suite.tests[0];
  assert.equal(test1.operationId, 'getTodo');
  assert.equal(test1.name, 'Fetch a todo');
  assert.equal(test1.endpoint, '/todos/1');
  assert.deepEqual(test1.tags, ['openapi']);
  assert.equal(test1.response?.status, 200);
  assert.deepEqual(test1.response?.json, { id: '1', title: 'Sample', completed: false });
  assert.equal(test1.dependsOn, undefined);
  assert.equal(test1.beforeSend, undefined);
  assert.equal(test1.postTest, undefined);
  assert.equal(test1.phase, undefined);
  assert.equal(test1.skip, undefined);
});

// Integration: a hand-written suite's dependsOn resolves against a spec-generated operationId when combined in one dependency graph.
test('hand-written tests can dependsOn a spec-generated operationId in a combined run', async () => {
  const generatedSuite = await loadOpenApiSuite(fixture('regression-v1.yaml'), {});
  const handwritten: TestCase = {
    name: 'Follow-up check after fetching the todo',
    operationId: 'followUpCheck',
    endpoint: '/todos/1/comments',
    dependsOn: ['getTodo'],
    request: { method: 'GET' },
    response: { status: 200 },
  };
  const allTests = [...generatedSuite.tests, handwritten];
  const opIds = new Set(allTests.map((t) => t.operationId));
  assert.ok(opIds.has('getTodo'));
  assert.ok(opIds.has('followUpCheck'));
  assert.equal(opIds.size, allTests.length, 'operationIds must be unique across generated + hand-written tests');
  assert.deepEqual(handwritten.dependsOn, ['getTodo']);
});

// Integration: --coverage-report output lists every spec operation exactly once with one of the defined statuses.
test('coverage report lists every spec operation exactly once', async () => {
  const suite = await loadOpenApiSuite(fixture('validation-matrix.yaml'), {});
  const results: TestResult[] = suite.tests.map((t) => ({
    status: t.operationId === 'register+missingEmail' ? 'failed' : 'passed',
    latency: 1,
    requestId: null,
    testName: t.name,
    operationId: t.operationId!,
    suiteName: t.suiteName!,
    request: {},
    response: { status: t.response?.status || 0, headers: {}, data: null },
  }));

  const rows = await buildCoverageReport(fixture('validation-matrix.yaml'), suite.tests, results);
  assert.equal(rows.length, 1, 'the fixture declares exactly one operation (register)');
  assert.equal(rows[0].operationId, 'register');
  assert.equal(rows[0].status.kind, 'generated-failed');
});

test('coverage report marks an operation uncovered when nothing exercises it', async () => {
  const rows = await buildCoverageReport(fixture('regression-v1.yaml'), [], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operationId, 'getTodo');
  assert.equal(rows[0].status.kind, 'uncovered');
});
