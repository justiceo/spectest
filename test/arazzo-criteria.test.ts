import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCriterion, evaluateSimpleCondition, looseEquals, parseCondition, type ExpressionResolver } from '../src/arazzo/criteria.js';
import { queryJsonPath, replaceJsonPath, replaceXPath, selectValue, xpathTruthy } from '../src/arazzo/selectors.js';
import { evaluateExchangeExpression, isExchangeExpression, parseTemplate, renderTemplate, type RuntimeExpression } from '../src/runtime-expression.js';

function resolver(response: { status: number; body?: any; headers?: Record<string, string> }, inputs: Record<string, any> = {}): ExpressionResolver {
  const exchange = { response: { status: response.status, body: response.body, headers: response.headers || {} } };
  const evaluate = (expression: RuntimeExpression): unknown => {
    if (isExchangeExpression(expression)) return evaluateExchangeExpression(expression, exchange);
    if (expression.root === 'inputs') return inputs[expression.name];
    throw new Error(`unsupported in test: ${expression.raw}`);
  };
  return {
    evaluate,
    interpolate: (template) => {
      const segments = parseTemplate(template);
      return segments ? renderTemplate(segments, evaluate) : template;
    },
  };
}

const ok = (condition: string, r: ExpressionResolver) => evaluateSimpleCondition(condition, r).pass;

test('simple conditions: comparisons, logic, grouping, literals', () => {
  const r = resolver({ status: 200, body: { count: 3, status: 'Succeeded', items: [{ id: 7 }], flag: false, token: null } }, { threshold: '2' });
  assert.equal(ok('$statusCode == 200', r), true);
  assert.equal(ok('$statusCode != 200', r), false);
  assert.equal(ok('$statusCode == 200 || $statusCode == 201', r), true);
  assert.equal(ok('$statusCode >= 200 && $statusCode < 300', r), true);
  assert.equal(ok('!($statusCode == 404)', r), true);
  assert.equal(ok('$response.body.count > $inputs.threshold', r), true, 'numeric strings coerce');
  assert.equal(ok("$response.body#/status == 'succeeded'", r), true, 'string comparison is case-insensitive');
  assert.equal(ok('$response.body#/items/0/id == 7', r), true);
  assert.equal(ok('$response.body.items[0].id == 7', r), true, 'index and property dereference');
  assert.equal(ok('$response.body#/flag == false', r), true);
  assert.equal(ok('$response.body#/token == null', r), true);
  assert.equal(ok('$response.body#/missing == null', r), true, 'missing values equal null');
  assert.equal(ok('$response.body#/missing != null', r), false);
  assert.equal(ok('$response.body#/count == null', r), false, 'null only equals null');
  assert.equal(ok("'it''s' == 'IT''S'", r), true, "'' escapes a quote");
  assert.equal(ok('{$statusCode == 200}', r), true, 'a condition wrapped in braces is unwrapped');
  assert.equal(ok('$response.body#/token', r), false, 'a null result fails');
});

test('simple conditions: syntax errors and evaluation errors fail with a message', () => {
  const r = resolver({ status: 500 });
  const failed = evaluateSimpleCondition('$statusCode == 200', r);
  assert.equal(failed.pass, false);
  assert.equal(failed.message, '$statusCode == 200 ($statusCode = 500)');
  const bad = evaluateSimpleCondition('$statusCode == ', r);
  assert.match(bad.message!, /invalid condition/);
  const bare = evaluateSimpleCondition('$statusCode == ok', r);
  assert.match(bare.message!, /strings need single quotes/);
  const unknown = evaluateSimpleCondition('$steps.x.outputs.y == 1', r);
  assert.match(unknown.message!, /could not evaluate/);
});

test('operator precedence: && binds tighter than ||, comparisons tighter than &&', () => {
  const tree: any = parseCondition('$inputs.a == 1 || $inputs.b == 2 && $inputs.c == 3');
  assert.equal(tree.op, '||');
  assert.equal(tree.right.op, '&&');
});

test('looseEquals semantics', () => {
  assert.equal(looseEquals('200', 200), true);
  assert.equal(looseEquals('TRUE', true), true);
  assert.equal(looseEquals(null, undefined), true);
  assert.equal(looseEquals(0, null), false);
  assert.equal(looseEquals({ a: 1 }, { a: 1 }), true);
});

test('regex criteria', async () => {
  const r = resolver({ status: 201, body: { status: 'paid' } }, { pattern: 'paid|settled' });
  assert.equal((await evaluateCriterion({ context: '$statusCode', condition: '^2\\d{2}$', type: 'regex' }, r)).pass, true);
  assert.equal((await evaluateCriterion({ context: '$response.body#/status', condition: '^({$inputs.pattern})$', type: 'regex' }, r)).pass, true);
  const miss = await evaluateCriterion({ context: '$response.body#/missing', condition: '.*', type: 'regex' }, r);
  assert.equal(miss.pass, false);
  assert.match(miss.message!, /context is undefined/);
  const invalid = await evaluateCriterion({ context: '$statusCode', condition: '([', type: 'regex' }, r);
  assert.match(invalid.message!, /could not evaluate/);
  const noContext = await evaluateCriterion({ condition: '.*', type: 'regex' }, r);
  assert.match(noContext.message!, /needs a context/);
});

test('JSONPath criteria (RFC 9535 by default, Goessner on request), with the official examples', async () => {
  const pets = resolver({ status: 200, body: [{ pets: [1] }, { pets: [] }] });
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: '$[?count(@.pets) > 0]', type: 'jsonpath' }, pets)).pass, true);
  const token = resolver({ status: 200, body: { access_token: 'x' } });
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: '$[?@.access_token != null]', type: 'jsonpath' }, token)).pass, true);
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: '$.nothing', type: 'jsonpath' }, token)).pass, false);
  const goessner = await evaluateCriterion(
    { context: '$response.body', condition: '$..pets[?(@ > 0)]', type: 'jsonpath', version: 'draft-goessner-dispatch-jsonpath-00' },
    pets
  );
  assert.equal(goessner.pass, true);
  const embedded = resolver({ status: 200, body: { items: [{ status: 'ready' }] } }, { expected: 'ready' });
  assert.equal(
    (await evaluateCriterion({ context: '$response.body', condition: '$.items[?(@.status == "{$inputs.expected}")]', type: 'jsonpath' }, embedded)).pass,
    true
  );
  const badVersion = await evaluateCriterion({ context: '$response.body', condition: '$', type: 'jsonpath', version: 'jsonpath-2' }, token);
  assert.match(badVersion.message!, /unsupported JSONPath version/);
  const notJson = await evaluateCriterion({ context: '$response.body', condition: '$', type: 'jsonpath' }, resolver({ status: 200, body: '<xml/>' }));
  assert.match(notJson.message!, /not JSON/);
});

test('XPath criteria (3.1 default via fontoxpath, 1.0 via xpath)', async () => {
  const xml = '<root><pets><pet>a</pet><pet>b</pet></pets><total>0</total></root>';
  const r = resolver({ status: 200, body: xml });
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: 'count(/root/pets/*) > 0', type: 'xpath' }, r)).pass, true);
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: '/root/pets', type: 'xpath' }, r)).pass, true);
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: '/root/nothing', type: 'xpath' }, r)).pass, false);
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: 'number(/root/total)', type: 'xpath', version: 'xpath-10' }, r)).pass, false);
  assert.equal((await evaluateCriterion({ context: '$response.body', condition: 'string(/root/pets/pet[1])', type: 'xpath', version: 'xpath-10' }, r)).pass, true);
  const broken = await evaluateCriterion({ context: '$response.body', condition: '/root[', type: 'xpath' }, r);
  assert.match(broken.message!, /could not evaluate/);
  const notXml = await evaluateCriterion({ context: '$response.body', condition: '/a', type: 'xpath' }, resolver({ status: 200, body: { a: 1 } }));
  assert.match(notXml.message!, /not an XML string/);
  assert.equal(await xpathTruthy(xml, 'count(//pet) = 2', 'xpath-30'), true);
});

test('selectors and replacements', async () => {
  assert.deepEqual(queryJsonPath({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b'), [1, 2]);
  assert.equal(await selectValue({ user: { email: 'x@y' } }, '$.user.email', 'jsonpath'), 'x@y');
  assert.deepEqual(await selectValue({ a: [1, 2] }, '$.a[*]', 'jsonpath'), [1, 2]);
  assert.equal(await selectValue({ a: { b: 3 } }, '/a/b', 'jsonpointer'), 3);
  assert.equal(await selectValue('<Invoice><Header><Number>42</Number></Header></Invoice>', '/Invoice/Header/Number', 'xpath', 'xpath-30'), '42');
  assert.equal(await selectValue('<a><b>1</b></a>', '/a/b', 'xpath', 'xpath-10'), '1');

  const body = { items: [{ sku: 'ABC123', quantity: 1 }, { sku: 'X', quantity: 5 }] };
  assert.equal(replaceJsonPath(body, "$.items[?(@.sku=='ABC123')].quantity", 9), 1);
  assert.deepEqual(body.items.map((i) => i.quantity), [9, 5]);
  const goessner = { items: [{ q: 1 }] };
  replaceJsonPath(goessner, '$.items[0].q', 4, 'draft-goessner-dispatch-jsonpath-00');
  assert.equal(goessner.items[0].q, 4);

  const replaced = await replaceXPath('<Envelope><Header><CustomerId/></Header><a id="1"/></Envelope>', '/Envelope/Header/CustomerId', 'C-9');
  assert.match(replaced.xml, /<CustomerId>C-9<\/CustomerId>/);
  const attr = await replaceXPath('<a id="1"/>', '/a/@id', 7, 'xpath-10');
  assert.match(attr.xml, /id="7"/);
});
