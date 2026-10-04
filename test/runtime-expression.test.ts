import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPointer,
  embedValue,
  evaluateExchangeExpression,
  exchangeFromResult,
  looksLikeRuntimeExpression,
  parseRuntimeExpression,
  parseTemplate,
  renderTemplate,
} from '../src/runtime-expression.js';

test('parses every Arazzo 1.0/1.1 expression root', () => {
  assert.deepEqual(parseRuntimeExpression('$url'), { root: 'url', path: [], raw: '$url' });
  assert.deepEqual(parseRuntimeExpression('$statusCode'), { root: 'statusCode', path: [], raw: '$statusCode' });
  assert.deepEqual(parseRuntimeExpression('$request.header.X-Api-Key'), {
    root: 'request',
    part: 'header',
    name: 'X-Api-Key',
    path: [],
    raw: '$request.header.X-Api-Key',
  });
  assert.deepEqual(parseRuntimeExpression('$request.path.id'), { root: 'request', part: 'path', name: 'id', path: [], raw: '$request.path.id' });
  assert.deepEqual(parseRuntimeExpression('$response.body#/items/0/id'), {
    root: 'response',
    part: 'body',
    pointer: '/items/0/id',
    path: [],
    raw: '$response.body#/items/0/id',
  });
  assert.deepEqual(parseRuntimeExpression('$response.body.count').root, 'response');
  assert.deepEqual((parseRuntimeExpression('$response.body.count') as any).path, ['count']);
  assert.deepEqual(parseRuntimeExpression('$inputs.x-api-key'), { root: 'inputs', name: 'x-api-key', pointer: undefined, raw: '$inputs.x-api-key' });
  assert.deepEqual(parseRuntimeExpression('$inputs.customer#/firstName'), {
    root: 'inputs',
    name: 'customer',
    pointer: '/firstName',
    raw: '$inputs.customer#/firstName',
  });
  assert.deepEqual(parseRuntimeExpression('$steps.find-pet.outputs.my_pet_id'), {
    root: 'steps',
    stepId: 'find-pet',
    name: 'my_pet_id',
    pointer: undefined,
    raw: '$steps.find-pet.outputs.my_pet_id',
  });
  assert.deepEqual(parseRuntimeExpression('$steps.s.outputs.pets#/0/id'), {
    root: 'steps',
    stepId: 's',
    name: 'pets',
    pointer: '/0/id',
    raw: '$steps.s.outputs.pets#/0/id',
  });
  assert.deepEqual(parseRuntimeExpression('$workflows.login.outputs.token'), {
    root: 'workflows',
    workflowId: 'login',
    field: 'outputs',
    name: 'token',
    pointer: undefined,
    raw: '$workflows.login.outputs.token',
  });
  assert.deepEqual(parseRuntimeExpression('$sourceDescriptions.petstore.url'), {
    root: 'sourceDescriptions',
    sourceName: 'petstore',
    reference: 'url',
    raw: '$sourceDescriptions.petstore.url',
  });
  assert.deepEqual(parseRuntimeExpression('$components.parameters.page'), {
    root: 'components',
    componentType: 'parameters',
    name: 'page',
    raw: '$components.parameters.page',
  });
  assert.equal(parseRuntimeExpression('$self').root, 'self');
  assert.equal(parseRuntimeExpression('$state.token').root, 'state');
});

test('rejects malformed expressions with a descriptive error', () => {
  assert.throws(() => parseRuntimeExpression('$steps.retrieveFinalizedPaymentPlan.finalizedPaymentPlan'), /expected \$steps\.<stepId>\.outputs\.<name>/);
  assert.throws(() => parseRuntimeExpression('$request.cookie.a'), /unsupported runtime expression/);
  assert.throws(() => parseRuntimeExpression('$nope'), /unsupported runtime expression/);
  assert.throws(() => parseRuntimeExpression('statusCode'), /must start with/);
});

test('looksLikeRuntimeExpression only matches known roots', () => {
  assert.equal(looksLikeRuntimeExpression('$inputs.a'), true);
  assert.equal(looksLikeRuntimeExpression('$5 off'), false);
  assert.equal(looksLikeRuntimeExpression('available'), false);
  assert.equal(looksLikeRuntimeExpression(42), false);
});

test('templates split embedded expressions and embed values per the 1.1 conversion rules', () => {
  const segments = parseTemplate('https://{$inputs.host}/api/{$steps.create.outputs.id}/status')!;
  assert.equal(segments.length, 5);
  const values: Record<string, unknown> = { '$inputs.host': 'example.com', '$steps.create.outputs.id': 42 };
  assert.equal(renderTemplate(segments, (e) => values[e.raw]), 'https://example.com/api/42/status');
  assert.equal(parseTemplate('no expressions here'), null);
  assert.equal(parseTemplate('{not an expression}'), null);
  assert.equal(embedValue({ a: 1 }), '{"a":1}');
  assert.equal(embedValue(undefined), '');
  assert.equal(embedValue(null), 'null');
  assert.equal(embedValue(true), 'true');
});

test('applyPointer handles nested values, escapes, and JSON strings', () => {
  assert.equal(applyPointer({ a: { 'b/c': [1, 2] } }, '/a/b~1c/1'), 2);
  assert.equal(applyPointer('{"x":{"y":3}}', '/x/y'), 3);
  assert.equal(applyPointer({ a: 1 }, '/missing/deeper'), undefined);
  assert.deepEqual(applyPointer({ a: 1 }, ''), { a: 1 });
});

test('exchange expressions read the stored request config and response', () => {
  const result = {
    request: {
      url: '/pets/7?status=available&tag=a&tag=b',
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
      data: { name: 'Rex' },
      spectestMeta: { pathParams: { petId: 7 } },
    },
    response: { status: 200, headers: new Headers({ 'X-Rate-Limit': '10' }), data: { id: 7, tags: ['a'] } },
  };
  const exchange = exchangeFromResult(result, 'http://api.test');
  const evaluate = (raw: string) => evaluateExchangeExpression(parseRuntimeExpression(raw), exchange);
  assert.equal(evaluate('$url'), 'http://api.test/pets/7?status=available&tag=a&tag=b');
  assert.equal(evaluate('$method'), 'GET');
  assert.equal(evaluate('$statusCode'), 200);
  assert.equal(evaluate('$request.header.authorization'), 'Bearer t');
  assert.equal(evaluate('$request.query.status'), 'available');
  assert.deepEqual(evaluate('$request.query.tag'), ['a', 'b']);
  assert.equal(evaluate('$request.path.petId'), 7);
  assert.equal(evaluate('$request.body#/name'), 'Rex');
  assert.equal(evaluate('$response.header.x-rate-limit'), '10');
  assert.equal(evaluate('$response.body#/tags/0'), 'a');
  assert.deepEqual(evaluate('$response.body'), { id: 7, tags: ['a'] });
});
