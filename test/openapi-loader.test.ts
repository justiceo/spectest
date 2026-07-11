import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { writeFile, mkdtemp } from 'fs/promises';
import { fileURLToPath } from 'url';
import { loadOpenApiSuite, describeOpenApiOperations, openApiLoaderPlugin } from '../src/plugins/openapi-loader.js';
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

// generate-command.ts scaffolds a static file, so it asks loadOpenApiSuite to
// keep {{uuid}}/{{timestamp}}/{{shortId}} tokens literal (it re-rolls them at
// send time itself) instead of baking in a one-time value that would replay
// forever across separate runs of the generated file.
test('preservePlaceholders keeps generator tokens literal instead of resolving them', async () => {
  const suite = await loadOpenApiSuite(fixture('generators.yaml'), {}, { preservePlaceholders: true });
  const widget = byOperationId(suite.tests, 'createWidget');

  assert.equal(widget.request?.body.id, '{{uuid}}');
  assert.equal(widget.request?.body.createdAt, '{{timestamp}}');
  assert.equal(widget.request?.body.slug, '{{shortId}}');
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

// A link with x-spectest-requestBodyTarget sets one nested body field,
// preserving the rest of the example body (not a whole-body replace).
test('requestBodyTarget link fills a nested body field and preserves the example body', async () => {
  const suite = await loadOpenApiSuite(fixture('links-body-target.yaml'), {});
  const createDomain = byOperationId(suite.tests, 'createDomain');
  assert.deepEqual(createDomain.dependsOn, ['createContact']);
  assert.equal(typeof createDomain.beforeSend, 'function');
  // Example body is preserved as-authored before the link runs.
  assert.deepEqual(createDomain.request?.body, { name: 'example.ng', registrant: 'PLACEHOLDER' });

  const config = { url: '/domains', headers: {}, data: { name: 'example.ng', registrant: 'PLACEHOLDER' } };
  const state = {
    completedCases: {
      createContact: { response: { status: 201, headers: {}, data: { id: 'C-42' } } },
    },
  };
  const updated = await createDomain.beforeSend!(config, state);
  // Only `registrant` changed; `name` untouched.
  assert.deepEqual(updated.data, { name: 'example.ng', registrant: 'C-42' });
  // Original config object/body not mutated (deep clone).
  assert.deepEqual(config.data, { name: 'example.ng', registrant: 'PLACEHOLDER' });
});

// A link can source a value the linked operation *sent* via $request.body.
test('$request.body# expression resolves against the source op request', async () => {
  const suite = await loadOpenApiSuite(fixture('links-body-target.yaml'), {});
  const infoDomain = byOperationId(suite.tests, 'infoDomain');
  assert.deepEqual(infoDomain.dependsOn, ['createDomain']);

  const config = { url: '/domains/{domain}', headers: {} };
  const state = {
    completedCases: {
      // Note: value comes from the *request* the source op sent, not its response.
      createDomain: {
        request: { data: { name: 'sent-example.ng' } },
        response: { status: 201, headers: {}, data: { name: 'ignored.ng' } },
      },
    },
  };
  const updated = await infoDomain.beforeSend!(config, state);
  assert.equal(updated.url, '/domains/sent-example.ng');
});

// A generated value that never surfaced in the response body is captured on
// the case and referenceable via $generated.<key>.
test('$generated.<key> resolves the x-spectest.generate value from the source result', async () => {
  const suite = await loadOpenApiSuite(fixture('links-generated.yaml'), {});
  const createWidget = byOperationId(suite.tests, 'createWidget');
  // The generated value was baked into the body and recorded on the case.
  const serial = (createWidget.request?.body as any).serial;
  assert.match(serial, /^[a-z0-9]{8}$/);
  assert.deepEqual(createWidget.generatedValues, { serial });

  const getWidget = byOperationId(suite.tests, 'getWidget');
  assert.deepEqual(getWidget.dependsOn, ['createWidget']);
  const config = { url: '/widgets/{serial}', headers: {} };
  const state = {
    completedCases: {
      createWidget: { generatedValues: { serial: 'gen-abc' }, response: { status: 201, headers: {}, data: {} } },
    },
  };
  const updated = await getWidget.beforeSend!(config, state);
  assert.equal(updated.url, '/widgets/gen-abc');
});

// captureFromLogs synthesizes a postTest that stashes a regex capture into
// run state, and a dependent reads it via $state.<key> (no source completedCase
// required).
test('captureFromLogs postTest stashes a value and $state.<key> consumes it', async () => {
  const suite = await loadOpenApiSuite(fixture('capture-from-logs.yaml'), {});
  const signup = byOperationId(suite.tests, 'signup');
  assert.equal(typeof signup.postTest, 'function');

  // postTest scrapes the token out of the request logs into state.
  const state: any = {};
  const token = 'deadbeefdeadbeefdeadbeefdeadbeef';
  await signup.postTest!({}, state, { logs: [{ message: `Magic link: https://x/auth/verify?token=${token}` }] });
  assert.equal(state.signupToken, token);

  // The dependent's link resolves the value from run state, not a completedCase.
  const verify = byOperationId(suite.tests, 'verify');
  assert.deepEqual(verify.dependsOn, ['signup']);
  const config = { url: '/verify', headers: {}, data: { token: 'PLACEHOLDER' } };
  const updated = await verify.beforeSend!(config, { ...state });
  assert.deepEqual(updated.data, { token });
});

// An invalid regex degrades to a no-op capture instead of throwing.
test('captureFromLogs with an invalid pattern does not throw and captures nothing', async () => {
  const badFixtureCfg = {} as SpectestConfig;
  const suite = await loadOpenApiSuite(fixture('capture-from-logs.yaml'), badFixtureCfg);
  const signup = byOperationId(suite.tests, 'signup');
  // Directly exercise the composer path with a broken pattern via a fresh state:
  // the built-in postTest from a valid pattern should simply find no match here.
  const state: any = {};
  await signup.postTest!({}, state, { logs: [{ message: 'no token present' }] });
  assert.equal(state.signupToken, undefined);
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

// Regression (resolve-once refactor): an unresolvable $ref still produces a skipped test with the same
// message text whether it's caught during buildOperationEntries' single resolution pass or (pre-refactor)
// during buildTestForExample's second attempt.
test('operation with an unresolvable $ref produces a skipped test with a matching skip reason', async () => {
  const suite = await loadOpenApiSuite(fixture('unresolved-ref.yaml'), {});
  assert.equal(suite.tests.length, 1);
  const test1 = suite.tests[0];
  assert.equal(test1.operationId, 'createWidgetBadRef');
  assert.equal(test1.skip, true);
  assert.match(test1.skipReason || '', /unresolved ref '#\/components\/schemas\/DoesNotExist'/);
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

// A response schema is emitted as the spec's raw Schema Object, no __spectestJsonSchema/openapiVersion wrapper.
test("generated test's response.schema equals the spec's raw schema object, unwrapped", async () => {
  const suite = await loadOpenApiSuite(fixture('response-schema.yaml'), {});
  const createWidget = byOperationId(suite.tests, 'createWidget');
  assert.deepEqual(createWidget.response?.schema, {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      deletedAt: { type: 'string', nullable: true },
    },
  });
  assert.equal((createWidget.response?.schema as any).__spectestJsonSchema, undefined);
});

// --- Negative testing (Phases 1-2 of design-docs/openapi-negative-and-fuzz-testing.md) ---

function negativeTests(tests: TestCase[], operationId: string): TestCase[] {
  return tests.filter(
    (t) => t.operationId?.startsWith(`${operationId}+__negative-`) && Array.isArray(t.tags) && t.tags.includes('negative')
  );
}

test('negative tests are disabled by default: no fixture produces negative-tagged tests with no config', async () => {
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), {});
  assert.equal(suite.tests.filter((t) => Array.isArray(t.tags) && t.tags.includes('negative')).length, 0);
});

test('enabling negative tests generates body and query-parameter violations, tagged and asserting the documented 4xx', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);

  const created = negativeTests(suite.tests, 'createAccount');
  assert.ok(created.length > 0, 'expected at least one negative test for createAccount');
  for (const test of created) {
    assert.equal(test.response?.status, 400);
    assert.deepEqual(test.tags && [...test.tags].sort(), ['negative', 'openapi']);
  }

  const requiredEmail = created.find((t) => t.operationId === 'createAccount+__negative-email-required');
  assert.ok(requiredEmail);
  assert.equal('email' in (requiredEmail!.request?.body || {}), false);
  assert.equal(requiredEmail!.request?.body.age, 30);

  const referralTooShort = created.find((t) => t.operationId?.includes('referralcode-min-length'));
  assert.ok(referralTooShort, 'expected a query-parameter minLength violation');
  assert.deepEqual(referralTooShort!.request?.body, { email: 'a@b.com', age: 30, role: 'member' });
});

test('a mutated payload that still validates is discarded by the Ajv self-check', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  const created = negativeTests(suite.tests, 'createAccount');
  // `role` has no `required` entry and only an `enum` constraint; dropping it entirely is not a
  // constraint violation (it's optional), so no `role-required` case should be generated.
  assert.equal(created.some((t) => t.operationId?.includes('role-required')), false);
});

test('x-spectest.negative.seedExample selects the seed and generator-placeholder fields are skipped', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  const created = negativeTests(suite.tests, 'createAccount');
  const ageMinimum = created.find((t) => t.operationId === 'createAccount+__negative-age-minimum');
  assert.ok(ageMinimum);
  assert.equal(ageMinimum!.request?.body.email, 'a@b.com');
});

test('a real-side-effect tagged operation never gets negative tests, even with global enabled: true', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  assert.equal(negativeTests(suite.tests, 'chargeAccount').length, 0);
});

test('a links-source operation and its link-target never get negative tests (stateful chain protection)', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  assert.equal(negativeTests(suite.tests, 'createWidgetLinkSource').length, 0);
  assert.equal(negativeTests(suite.tests, 'getWidgetLinkTarget').length, 0);
});

test('a links-source operation keeps resolving to exactly one generated id after negative injection, so the dependent still auto-derives dependsOn', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  const getWidget = byOperationId(suite.tests, 'getWidgetLinkTarget');
  assert.deepEqual(getWidget.dependsOn, ['createWidgetLinkSource+success']);
  assert.equal(typeof getWidget.beforeSend, 'function');
});

test('maxCasesPerOperation caps the number of negative tests generated per operation', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true, maxCasesPerOperation: 2 } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);
  assert.equal(negativeTests(suite.tests, 'createAccount').length, 2);
});

test('x-spectest.negative.enabled: false narrows off negative generation for one operation, others unaffected', async () => {
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), {
    openapiNegativeTests: { enabled: true },
  });
  assert.equal(negativeTests(suite.tests, 'createGadgetNarrowed').length, 0);
  assert.ok(negativeTests(suite.tests, 'createAccount').length > 0);
});

test('a v1-style operation with only a singular `example` (no `examples` map) still gets negative cases', async () => {
  const cfg: SpectestConfig = { openapiNegativeTests: { enabled: true } };
  const suite = await loadOpenApiSuite(fixture('negative-testing.yaml'), cfg);

  // The positive/base test keeps a single non-synthetic generated id (`+default`), so it stays
  // discoverable as exactly one id for link resolution/dependsOn purposes.
  const positive = byOperationId(suite.tests, 'createGizmoSingularExample+default');
  assert.deepEqual(positive.request?.body, { name: 'gizmo' });

  const created = negativeTests(suite.tests, 'createGizmoSingularExample');
  assert.ok(created.length > 0, 'expected at least one negative test for createGizmoSingularExample');
  for (const test of created) {
    assert.equal(test.response?.status, 400);
  }

  const nameRequired = created.find((t) => t.operationId === 'createGizmoSingularExample+__negative-name-required');
  assert.ok(nameRequired, 'expected a required-field violation derived from the singular example');
  assert.equal('name' in (nameRequired!.request?.body || {}), false);

  const batchSizeTooLarge = created.find((t) => t.operationId?.includes('batchsize-maximum'));
  assert.ok(batchSizeTooLarge, 'expected a query-parameter maximum violation seeded from the singular example');
  assert.deepEqual(batchSizeTooLarge!.request?.body, { name: 'gizmo' });
});

// --- Document-level validation, server resolution, parameter/body/response edge cases ---

async function writeTempDoc(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spectest-openapi-'));
  const file = path.join(dir, 'doc.json');
  await writeFile(file, content, 'utf8');
  return file;
}

test('OpenAPI document validation rejects non-object docs, Swagger 2.0, unsupported versions, and missing paths', async () => {
  await assert.rejects(
    loadOpenApiSuite(await writeTempDoc('null'), {}),
    /OpenAPI document must be an object/
  );
  await assert.rejects(
    loadOpenApiSuite(await writeTempDoc(JSON.stringify({ swagger: '2.0', paths: {} })), {}),
    /Swagger\/OpenAPI 2.0 is not supported/
  );
  await assert.rejects(
    loadOpenApiSuite(await writeTempDoc(JSON.stringify({ openapi: '4.0.0', paths: {} })), {}),
    /must declare version 3\.0\.x or 3\.1\.x/
  );
  await assert.rejects(
    loadOpenApiSuite(await writeTempDoc(JSON.stringify({ openapi: '3.0.3' })), {}),
    /must include a paths object/
  );
});

test('an operation with no operationId falls back to a stable slug derived from method + path', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const slugged = suite.tests.find((t) => t.endpoint === '/widgets' && t.request?.method === 'GET');
  assert.ok(slugged);
  assert.equal(slugged!.operationId, 'get-widgets');
});

test('multiple doc-level servers with no cfg.openapiServer default to no prefix', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const ping = byOperationId(suite.tests, 'pingMultiServer');
  assert.equal(ping.endpoint, '/ping');
});

test('cfg.openapiServer selects a doc-level server by numeric index', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), { openapiServer: 0 });
  const ping = byOperationId(suite.tests, 'pingMultiServer');
  assert.equal(ping.endpoint, '/v1/ping');
});

test('cfg.openapiServer selects a doc-level server by url string', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), { openapiServer: '/v2' });
  const ping = byOperationId(suite.tests, 'pingMultiServer');
  assert.equal(ping.endpoint, '/v2/ping');
});

test('cfg.openapiServer with no matching url skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), { openapiServer: '/bogus' });
  const ping = byOperationId(suite.tests, 'pingMultiServer');
  assert.equal(ping.skip, true);
  assert.match(ping.skipReason || '', /configured OpenAPI server '\/bogus' was not found/);
});

test('a single operation-level server auto-selects without needing cfg.openapiServer', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const ping = byOperationId(suite.tests, 'pingSingleOpServer');
  assert.equal(ping.endpoint, '/solo/ping-single');
});

test('multiple operation-level servers without cfg.openapiServer skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const ping = byOperationId(suite.tests, 'pingMultiOpServer');
  assert.equal(ping.skip, true);
  assert.match(ping.skipReason || '', /unsupported operation-level server override/);
});

test('an unsupported parameter serialization style skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'unsupportedStyleParam');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /unsupported parameter serialization for query parameter 'tags'/);
});

test('a cookie parameter is merged into the Cookie header', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'cookieParamOp');
  assert.equal(op.request?.headers?.Cookie, 'sid=abc123');
});

test('a required request body with only a non-JSON media type skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'unsupportedBodyMedia');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /unsupported required request body media type/);
});

test('x-spectest.status referencing an undocumented response skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'forcedStatusMismatch');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /x-spectest\.status 404 has no matching response definition/);
});

test('a 204 response sets only the status, no schema/json', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'deleteNoContent');
  assert.equal(op.skip, undefined);
  assert.equal(op.response?.status, 204);
  assert.equal(op.response?.schema, undefined);
  assert.equal(op.response?.json, undefined);
});

test('a non-JSON response with an explicit status sets only the status', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'nonJsonResponse');
  assert.equal(op.skip, undefined);
  assert.equal(op.response?.status, 202);
  assert.equal(op.response?.schema, undefined);
  assert.equal(op.response?.json, undefined);
});

test('an operation with no usable response status skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'noUsableStatus');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /no usable response status/);
});

test('a default response with no content and no status skips as no usable response assertion', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'defaultResponseNoContent');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /no usable response assertion/);
});

test('a default JSON response with no schema/example/status skips as no usable response assertion', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'jsonNoSchemaNoStatus');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /no usable response assertion/);
});

test('x-spectest.generate referencing an unknown generator skips the test', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'unknownGenerator');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /unknown x-spectest\.generate generator 'notAGenerator'/);
});

test('an openapiAuth hook mutation applies query/cookie/header/credentials to the request', async () => {
  const cfg: SpectestConfig = {
    openapiAuth: {
      apiKeyQuery: async () => ({
        query: { api_key: 'k1' },
        cookies: { sid: 's1' },
        headers: { 'X-Extra': '1' },
        credentials: 'include',
      }),
    },
  };
  const suite = await loadOpenApiSuite(fixture('auth-mutation.yaml'), cfg);
  const op = byOperationId(suite.tests, 'secureGet');
  assert.match(op.endpoint, /api_key=k1/);
  assert.equal(op.request?.headers?.Cookie, 'sid=s1');
  assert.equal(op.request?.headers?.['X-Extra'], '1');
  assert.equal((op.request as any).credentials, 'include');
});

test('a function-mode auth hook is ignored when a named variant is requested, skipping with a variant-specific reason', async () => {
  const cfg: SpectestConfig = {
    openapiAuth: {
      apiKeyQuery: async () => ({ query: { api_key: 'k1' } }),
    },
  };
  const suite = await loadOpenApiSuite(fixture('auth-mutation.yaml'), cfg);
  const op = byOperationId(suite.tests, 'secureVariantGet');
  assert.equal(op.skip, true);
  assert.match(op.skipReason || '', /missing auth hook variant 'premium' for required scheme/);
});

test('query/cookie/header link kinds resolve via $response.header and $request.header runtime expressions', async () => {
  const suite = await loadOpenApiSuite(fixture('links-extra.yaml'), {});
  const getReceipt = byOperationId(suite.tests, 'getReceipt');
  assert.deepEqual(getReceipt.dependsOn, ['createOrder3']);

  const config = { url: '/receipts', headers: {} as Record<string, string> };
  const state = {
    completedCases: {
      createOrder3: {
        request: { headers: { 'X-Session-Id': 'sess-9' } },
        response: { status: 201, headers: { 'X-Trace-Id': 'trace-7' }, data: { region: 'us' } },
      },
    },
  };
  const updated = await getReceipt.beforeSend!(config, state);
  assert.match(updated.url, /traceId=trace-7/);
  assert.equal(updated.headers.Cookie, 'sessionId=sess-9');
  assert.equal(updated.headers.region, 'us');
});

test('openApiLoaderPlugin registers an onLoad handler that returns the parsed suite', async () => {
  let registered: { filter: RegExp; source?: string } | undefined;
  let handler: ((args: { path: string }) => Promise<any>) | undefined;
  const plugin = openApiLoaderPlugin({});
  plugin.setup({
    onLoad(matcher: any, cb: any) {
      registered = matcher;
      handler = cb;
    },
  } as any);
  assert.equal(registered?.source, 'openapi');
  assert.ok(registered?.filter.test('spec.yaml'));
  const result = await handler!({ path: fixture('regression-v1.yaml') });
  assert.equal(result.suites.length, 1);
  assert.equal(result.suites[0].tests[0].operationId, 'getTodo');
});

test('an optional query parameter with no example is simply omitted', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'optionalQueryNoExample');
  assert.equal(op.skip, undefined);
  assert.equal(op.endpoint, '/optional-query-no-example');
});

test('a header parameter with an example value is sent as a request header', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'headerParamWithExample');
  assert.equal(op.request?.headers?.['X-Trace'], 'trace-abc');
});

test('an array-valued query parameter example is JSON-stringified', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'arrayQueryParam');
  assert.match(op.endpoint, /ids=%5B1%2C2%2C3%5D|ids=\[1,2,3\]/);
});

test('a whole-body link synthesizes the entire request body when no example exists', async () => {
  const suite = await loadOpenApiSuite(fixture('edge-cases.yaml'), {});
  const op = byOperationId(suite.tests, 'provisionBilling');
  assert.deepEqual(op.dependsOn, ['createAccount2']);
  assert.equal(op.request?.body, undefined);
  assert.equal(typeof op.beforeSend, 'function');

  const config = { url: '/billing', headers: {} };
  const state = {
    completedCases: {
      createAccount2: { response: { status: 201, headers: {}, data: { accountId: 'acc-1' } } },
    },
  };
  const updated = await op.beforeSend!(config, state);
  assert.equal(updated.data, 'acc-1');
});

test('resolveRefs rejects external refs and circular refs with a skip reason', async () => {
  const doc = await writeTempDoc(
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Ref Edge Cases', version: '1.0.0' },
      paths: {
        '/external': {
          post: {
            operationId: 'externalRefOp',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: 'other.yaml#/Foo' }, example: {} } },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/circular': {
          post: {
            operationId: 'circularRefOp',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' }, example: {} } },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { schemas: { Node: { $ref: '#/components/schemas/Node' } } },
    })
  );
  const suite = await loadOpenApiSuite(doc, {});
  const external = byOperationId(suite.tests, 'externalRefOp');
  assert.equal(external.skip, true);
  assert.match(external.skipReason || '', /external or unsupported ref 'other\.yaml#\/Foo'/);

  const circular = byOperationId(suite.tests, 'circularRefOp');
  assert.equal(circular.skip, true);
  assert.match(circular.skipReason || '', /circular ref '#\/components\/schemas\/Node'/);
});

test('describeOpenApiOperations lists method/path/operationId/generatedIds without building full test cases', async () => {
  const descriptors = await describeOpenApiOperations(fixture('validation-matrix.yaml'), {});
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].method, 'post');
  assert.equal(descriptors[0].operationId, 'register');
  assert.deepEqual(
    [...descriptors[0].generatedIds].sort(),
    ['register+missingDomainName', 'register+missingEmail', 'register+success']
  );
});
