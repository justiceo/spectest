// The official Arazzo examples (OAI/Arazzo-Specification examples/1.0.0), run unmodified
// through the CLI against mocks that implement their OpenAPI descriptions. Where an
// example has a bug of its own, the test asserts Spectest's behaviour on the document
// as written, and a corrected copy (test/fixtures/arazzo/official-corrected) exercises
// the full flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { readFile } from 'node:fs/promises';
import { buildArazzoDocument } from '../src/arazzo/document.js';
import { compileArazzoDocument } from '../src/arazzo/compile.js';
import { parseResults, runCli, startMockServer, type MockHandler, type RecordedRequest } from './support/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const official = path.join(__dirname, 'fixtures', 'arazzo', 'official');
const corrected = path.join(__dirname, 'fixtures', 'arazzo', 'official-corrected');

async function runExample(doc: string, handler: MockHandler, cfg: Record<string, unknown> = {}) {
  const server = await startMockServer(handler);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spectest-official-'));
  try {
    const configFile = path.join(dir, 'config.mjs');
    await writeFile(configFile, `export default ${JSON.stringify(cfg, null, 2)};\n`);
    const run = await runCli(['--base-url', server.url, '--test-dir', dir, '--arazzo', doc, '--config', configFile, '--test-output', 'errors'], { cwd: dir });
    return { run, results: parseResults(run.stdout), requests: server.requests };
  } finally {
    await server.close();
  }
}

function expectAll(results: ReturnType<typeof parseResults>, run: { stdout: string; stderr: string }, expected: Record<string, string>) {
  for (const [name, status] of Object.entries(expected)) {
    assert.equal(results.get(name)?.status, status, `${name} should be ${status}\n${run.stdout}\n${run.stderr}`);
  }
}

const find = (requests: RecordedRequest[], method: string, pathname: string) => requests.filter((r) => r.method === method && r.path === pathname);

const petCouponsHandler: MockHandler = (() => {
  let orderId = 100;
  return (req) => {
    if (req.path === '/pet/findByTags') {
      const tags = req.query.getAll('tags').length ? req.query.getAll('tags') : req.query.getAll('pet_tags');
      return { json: [{ id: 10, name: 'Rex', photoUrls: [], tags: tags.map((name) => ({ name })) }] };
    }
    if (req.path === '/pet/findByStatus') return { json: [{ id: 20, name: 'Ace', photoUrls: [], status: req.query.get('status') }] };
    if (/^\/pet\/\d+\/coupons$/.test(req.path)) return { json: { couponCode: `SAVE-${req.path.split('/')[2]}` } };
    if (req.method === 'POST' && req.path === '/store/order') return { json: { id: ++orderId, ...req.json } };
    return { status: 404, json: {} };
  };
})();

test('pet-coupons (as published): the misnamed path parameter fails find-coupons, with a hint and a load warning', async () => {
  const { run, results } = await runExample(path.join(official, 'pet-coupons.arazzo.yaml'), petCouponsHandler, {
    arazzoInputs: { 'apply-coupon': { my_pet_tags: ['puppy'] } },
  });
  expectAll(results, run, {
    'apply-coupon › find-pet': 'passed',
    'apply-coupon › find-coupons': 'failed',
    'apply-coupon › place-order': 'failed-precondition',
    'buy-available-pet (workflow)': 'passed',
    'place-order (workflow)': 'passed',
  });
  assert.match(run.stdout, /path parameter 'petId' has no value; the step sets path parameter 'pet_id', which the path does not use/);
  assert.match(run.stderr, /query parameter 'pet_tags' is not declared by operation 'findPetsByTags' \(declared: tags\)/);
  assert.match(run.stderr, /path parameter 'pet_id' is not declared by operation 'getPetCoupons' \(declared: petId\)/);
});

test('pet-coupons (corrected): sub-workflow steps, $outputs, reusable parameters with value overrides', async () => {
  const { run, results, requests } = await runExample(path.join(corrected, 'pet-coupons.arazzo.yaml'), petCouponsHandler, {
    arazzoInputs: { 'apply-coupon': { my_pet_tags: ['puppy', 'dalmatian'] } },
  });
  expectAll(results, run, {
    'apply-coupon › find-pet': 'passed',
    'apply-coupon › find-coupons': 'passed',
    'apply-coupon › place-order › place-order': 'passed',
    'apply-coupon › place-order': 'passed',
    'apply-coupon (workflow)': 'passed',
    'buy-available-pet › find-pet': 'passed',
    'buy-available-pet › place-order › place-order': 'passed',
    'buy-available-pet › place-order': 'passed',
    'buy-available-pet (workflow)': 'passed',
    'place-order › place-order': 'passed',
    'place-order (workflow)': 'passed',
  });
  assert.equal(run.code, 0);
  assert.deepEqual(find(requests, 'GET', '/pet/findByTags')[0].query.getAll('tags'), ['puppy', 'dalmatian']);
  const byStatus = find(requests, 'GET', '/pet/findByStatus')[0].query;
  assert.deepEqual([byStatus.get('status'), byStatus.get('page'), byStatus.get('pageSize')], ['available', '1', '10'], 'component parameter values are overridden');
  const orders = find(requests, 'POST', '/store/order').map((r) => r.json);
  assert.ok(orders.some((o) => o.petId === 10 && o.couponCode === 'SAVE-10' && o.status === 'placed' && o.complete === false));
  assert.ok(orders.some((o) => o.petId === 20 && !('couponCode' in o)));
});

test('oauth: nested authorization-code flow feeds the refresh flow; form payloads; JSONPath criteria', async () => {
  const { run, results, requests } = await runExample(
    path.join(official, 'oauth.arazzo.yaml'),
    (req) => {
      if (req.path === '/authorize') return { json: { code: `code-for-${req.query.get('client_id')}`, access_token: 'implicit' } };
      if (req.method === 'POST' && req.path === '/oauth/token') {
        const form = new URLSearchParams(req.body);
        const grant = form.get('grant_type');
        if (grant === 'authorization_code') return { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } };
        if (grant === 'refresh_token' && form.get('refresh_token') === 'rt-1') return { json: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } };
        if (grant === 'client_credentials') return { json: { access_token: 'cc-1' } };
        return { status: 400, json: { error: 'invalid_grant' } };
      }
      return { status: 404, json: {} };
    },
    {
      arazzoInputs: {
        'refresh-token-flow': { my_client_id: 'app', my_client_secret: 's3cret', my_redirect_uri: 'https://app.example/cb' },
        'client-credentials-flow': { client_id: 'app', client_secret: 's3cret' },
        'authorization-code-flow': { client_id: 'solo', client_secret: 'x', redirect_uri: 'https://solo.example/cb' },
      },
    }
  );
  expectAll(results, run, {
    'refresh-token-flow › do-the-auth-flow › browser-authorize': 'passed',
    'refresh-token-flow › do-the-auth-flow › get-access-token': 'passed',
    'refresh-token-flow › do-the-auth-flow': 'passed',
    'refresh-token-flow › do-the-refresh': 'passed',
    'refresh-token-flow (workflow)': 'passed',
    'client-credentials-flow › get-client-creds-token': 'passed',
    'authorization-code-flow › browser-authorize': 'passed',
    'authorization-code-flow › get-access-token': 'passed',
  });
  assert.equal(run.code, 0);
  const tokenRequests = find(requests, 'POST', '/oauth/token').map((r) => new URLSearchParams(r.body));
  const refresh = tokenRequests.find((f) => f.get('grant_type') === 'refresh_token')!;
  assert.equal(refresh.get('refresh_token'), 'rt-1', 'the nested workflow output reached the refresh step');
  const exchange = tokenRequests.find((f) => f.get('grant_type') === 'authorization_code' && f.get('client_id') === 'app')!;
  assert.equal(exchange.get('code'), 'code-for-app');
  assert.equal(exchange.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(find(requests, 'GET', '/authorize').find((r) => r.query.get('client_id') === 'app')!.query.get('state'), '12345');
});

const bnplInputs = {
  ApplyForLoanAtCheckout: {
    customer: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1990-12-10T00:00:00Z', postalCode: 'N1 9GU' },
    products: [{ productCode: 'LAPTOP', purchaseAmount: { currency: 'GBP', amount: 1200 } }],
  },
};

function bnplHandler(eligibility: { existingCustomerNotEligible: boolean }): MockHandler {
  return (req) => {
    const route = req.path.replace(/^\/bnpl\/v1/, '');
    if (req.method === 'POST' && route === '/products') {
      return { json: { ...eligibility, eligibilityCheckRequired: true, products: req.json?.products ?? [], totalAmount: { currency: 'GBP', amount: 1200 } } };
    }
    if (route === '/terms-and-conditions') return { json: { termsAndConditions: 'Be nice.' } };
    if (req.method === 'POST' && route === '/customers') return { status: 201, json: { links: { self: 'https://bnpl.example/customers/c-1' } } };
    if (req.method === 'POST' && route === '/loan-transactions') {
      return { status: 202, json: { loanTransactionId: 'loan-1', redirectAuthToken: 'rat-1', links: { self: 'https://bnpl.example/loan-transactions/loan-1' } } };
    }
    if (route === '/auth') return { status: 302, headers: { Location: 'https://bnpl.example/consent?token=' + req.query.get('AuthorizationToken') }, text: '' };
    if (route === '/loan-transactions/loan-1') return { json: { loanTransactionId: 'loan-1', status: 'approved', instalments: 3 } };
    if (req.method === 'PATCH' && route === '/loan-transactions/loan-1/status') return { status: 204 };
    return { status: 404, json: {} };
  };
}

test('bnpl (as published): the first success action ends the workflow; a JSON text template keeps object types', async () => {
  const { run, results, requests } = await runExample(path.join(official, 'bnpl-arazzo.yaml'), bnplHandler({ existingCustomerNotEligible: false }), {
    arazzoInputs: bnplInputs,
    arazzoSources: { BnplApi: path.join(official, 'bnpl-openapi.yaml') },
  });
  expectAll(results, run, {
    'ApplyForLoanAtCheckout › checkLoanCanBeProvided': 'passed',
    'ApplyForLoanAtCheckout › getCustomerTermsAndConditions': 'skipped',
    'ApplyForLoanAtCheckout › updateOrderStatus': 'skipped',
  });
  assert.match(results.get('ApplyForLoanAtCheckout › checkLoanCanBeProvided')!.note!, /onSuccess 'existingCustomerNotEligible': end workflow/);
  // The workflow output expression is malformed in the published example (no `.outputs.`).
  assert.equal(results.get('ApplyForLoanAtCheckout (workflow)')?.status, 'failed');
  assert.match(run.stdout, /expected \$steps\.<stepId>\.outputs\.<name>/);
  const sent = find(requests, 'POST', '/bnpl/v1/products')[0].json;
  assert.deepEqual(sent.customer, bnplInputs.ApplyForLoanAtCheckout.customer, '"{$inputs.customer}" is sent as an object');
  assert.equal(requests.length, 1);
});

test('bnpl (corrected): goto chains through eligibility, enrolment, a 302 authorization redirect and status update', async () => {
  const { run, results, requests } = await runExample(path.join(corrected, 'bnpl.arazzo.yaml'), bnplHandler({ existingCustomerNotEligible: false }), {
    arazzoInputs: bnplInputs,
  });
  expectAll(results, run, {
    'ApplyForLoanAtCheckout › checkLoanCanBeProvided': 'passed',
    'ApplyForLoanAtCheckout › getCustomerTermsAndConditions': 'passed',
    'ApplyForLoanAtCheckout › createCustomer': 'passed',
    'ApplyForLoanAtCheckout › initiateBnplTransaction': 'passed',
    'ApplyForLoanAtCheckout › authenticateCustomerAndAuthorizeLoan': 'passed',
    'ApplyForLoanAtCheckout › retrieveFinalizedPaymentPlan': 'passed',
    'ApplyForLoanAtCheckout › updateOrderStatus': 'passed',
    'ApplyForLoanAtCheckout (workflow)': 'passed',
  });
  assert.equal(run.code, 0);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path.replace('/bnpl/v1', '')}`),
    ['POST /products', 'GET /terms-and-conditions', 'POST /customers', 'POST /loan-transactions', 'GET /auth', 'GET /loan-transactions/loan-1', 'PATCH /loan-transactions/loan-1/status']
  );
  assert.equal(find(requests, 'GET', '/bnpl/v1/auth')[0].query.get('AuthorizationToken'), 'rat-1');
  const customer = find(requests, 'POST', '/bnpl/v1/customers')[0].json;
  assert.deepEqual(customer, { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1990-12-10T00:00:00Z', postalCode: 'N1 9GU', termsAndConditionsAccepted: true });
  const loan = find(requests, 'POST', '/bnpl/v1/loan-transactions')[0].json;
  assert.equal(loan.newCustomer, 'https://bnpl.example/customers/c-1');
  assert.equal(loan.enrolledCustomer, null);
  assert.deepEqual(loan.products, bnplInputs.ApplyForLoanAtCheckout.products);

  // A customer who is not eligible ends the corrected workflow right after the first step.
  const ineligible = await runExample(path.join(corrected, 'bnpl.arazzo.yaml'), bnplHandler({ existingCustomerNotEligible: true }), { arazzoInputs: bnplInputs });
  expectAll(ineligible.results, ineligible.run, {
    'ApplyForLoanAtCheckout › checkLoanCanBeProvided': 'passed',
    'ApplyForLoanAtCheckout › createCustomer': 'skipped',
    'ApplyForLoanAtCheckout (workflow)': 'passed',
  });
});

const fapiInputs = {
  'OIDC-PAR-AuthzCode': {
    client_id: 'tpp-1',
    client_assertion: { iss: 'tpp-1', sub: 'tpp-1', aud: 'https://as.example', exp: '9999999999', iat: '0', jti: 'j1' },
    redirect_uri: 'https://tpp.example/cb',
    code_verifier: 'verifier-123',
    PARrequestBody: { response_type: 'code', client_id: 'tpp-1', scope: 'openid accounts', state: 's1', redirect_uri: 'https://tpp.example/cb' },
    TokenRequestBody: { grant_type: 'authorization_code', code: 'placeholder', redirect_uri: 'https://tpp.example/cb', code_verifier: 'verifier-123' },
  },
};

const fapiHandler: MockHandler = (req) => {
  if (req.method === 'POST' && req.path === '/as/par.oauth2') return { json: { request_uri: 'urn:example:par:1', expires_in: 90 } };
  if (req.path === '/as/authorize.oauth2') {
    return req.query.get('request_uri') === 'urn:example:par:1'
      ? { status: 302, headers: { Location: 'https://tpp.example/cb?code=authz-1' }, json: { code: 'authz-1' } }
      : { status: 400, json: { error: 'invalid_request_uri' } };
  }
  if (req.method === 'POST' && req.path === '/as/token.oauth2') {
    return req.json?.code === 'authz-1' ? { json: { access_token: 'at-fapi', token_type: 'Bearer', expires_in: 300 } } : { status: 400, json: { error: 'invalid_grant' } };
  }
  return { status: 404, json: {} };
};

test('FAPI-PAR (as published): the case-mismatched operationId skips the workflow with a hint', async () => {
  const { run, results, requests } = await runExample(path.join(official, 'FAPI-PAR.arazzo.yaml'), fapiHandler, { arazzoInputs: fapiInputs });
  expectAll(results, run, { 'OIDC-PAR-AuthzCode › PARStep': 'skipped', 'OIDC-PAR-AuthzCode (workflow)': 'skipped' });
  assert.match(results.get('OIDC-PAR-AuthzCode › PARStep')!.note!, /operationId 'PAR' was not found in source description 'auth-api' \(did you mean 'Par'\?\)/);
  assert.equal(requests.length, 0);
});

test('FAPI-PAR (corrected): pushed authorization request, 302 authorization, token exchange', async () => {
  const { run, results, requests } = await runExample(path.join(corrected, 'FAPI-PAR.arazzo.yaml'), fapiHandler, { arazzoInputs: fapiInputs });
  expectAll(results, run, {
    'OIDC-PAR-AuthzCode › PARStep': 'passed',
    'OIDC-PAR-AuthzCode › AuthzCodeStep': 'passed',
    'OIDC-PAR-AuthzCode › TokenStep': 'passed',
    'OIDC-PAR-AuthzCode (workflow)': 'passed',
  });
  assert.equal(run.code, 0);
  const par = find(requests, 'POST', '/as/par.oauth2')[0];
  assert.equal(par.query.get('client_assertion_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.deepEqual(JSON.parse(par.query.get('client_assertion')!), fapiInputs['OIDC-PAR-AuthzCode'].client_assertion);
  assert.deepEqual(par.json, fapiInputs['OIDC-PAR-AuthzCode'].PARrequestBody);
  assert.match(String(par.headers['content-type']), /application\/json/, 'content type taken from the OpenAPI operation');
  assert.deepEqual(find(requests, 'POST', '/as/token.oauth2')[0].json, {
    grant_type: 'authorization_code',
    code: 'authz-1',
    redirect_uri: 'https://tpp.example/cb',
    code_verifier: 'verifier-123',
  });
});

test('LoginAndRetrievePets: Swagger Petstore source, header outputs, operationPath to a single-operation path item', async () => {
  const { run, results, requests } = await runExample(
    path.join(official, 'LoginAndRetrievePets.arazzo.yaml'),
    (req) => {
      if (req.path === '/user/login') {
        return req.query.get('password') === 'hunter2'
          ? { headers: { 'X-Expires-After': '2030-01-01T00:00:00Z', 'X-Rate-Limit': '5000' }, json: 'session-abc' }
          : { status: 400, json: 'Invalid username/password supplied' };
      }
      if (req.path === '/pet/findByStatus') {
        return req.headers.authorization === 'session-abc'
          ? { json: [{ id: 1, name: 'doggie', photoUrls: [], status: 'available' }] }
          : { status: 401, json: { error: 'unauthorized' } };
      }
      return { status: 404, json: {} };
    },
    {
      arazzoInputs: { loginUserRetrievePet: { username: 'user1', password: 'hunter2' } },
      arazzoSources: { petStoreDescription: path.join(official, 'petstore.openapi.yaml') },
    }
  );
  expectAll(results, run, {
    'loginUserRetrievePet › loginStep': 'passed',
    'loginUserRetrievePet › getPetStep': 'passed',
    'loginUserRetrievePet (workflow)': 'passed',
  });
  assert.equal(run.code, 0);
  assert.equal(find(requests, 'GET', '/pet/findByStatus')[0].query.get('status'), 'available');
});

test('ExtendedParametersExample: workflow-level cookie/header parameters merge with step parameters', async () => {
  const handler: MockHandler = (req) => {
    if (req.method === 'POST' && req.path === '/animals') return { status: 201, json: { created: true } };
    if (req.path === '/animals/random') return { json: { name: 'okapi' } };
    return { status: 404, json: {} };
  };
  const published = await runExample(path.join(official, 'ExtendedParametersExample.arazzo.yaml'), handler);
  expectAll(published.results, published.run, { 'animal-workflow › post-step': 'skipped' });
  assert.match(published.results.get('animal-workflow › post-step')!.note!, /could not load source description 'animals'/);

  const { run, results, requests } = await runExample(path.join(official, 'ExtendedParametersExample.arazzo.yaml'), handler, {
    arazzoSources: { animals: path.join(corrected, 'animals.openapi.yaml') },
  });
  expectAll(results, run, { 'animal-workflow › post-step': 'passed', 'animal-workflow › get-step': 'passed', 'animal-workflow (workflow)': 'passed' });
  const post = find(requests, 'POST', '/animals')[0];
  assert.equal(post.headers.cookie, 'workflowLevelParamOne=someValue; authentication=SUPER_SECRET');
  assert.equal(post.headers.workflowlevelparamtwo, 'someValue');
  assert.equal(find(requests, 'GET', '/animals/random')[0].headers.cookie, 'workflowLevelParamOne=someValue');
});

test('every document in the official schema suite compiles without throwing', async () => {
  const suiteDir = path.join(__dirname, 'fixtures', 'arazzo', 'schema-suite');
  for (const folder of ['pass-1.0', 'pass-1.1']) {
    for (const file of await readdir(path.join(suiteDir, folder))) {
      const location = path.join(suiteDir, folder, file);
      const raw = parseYaml(await readFile(location, 'utf8'));
      const doc = await buildArazzoDocument(raw, location, {});
      const { tests } = await compileArazzoDocument(doc, {});
      assert.ok(tests.length > 0, `${folder}/${file} produced no tests`);
      for (const t of tests) assert.ok(t.operationId && t.name, `${folder}/${file}: every node has an id and a name`);
    }
  }
});
