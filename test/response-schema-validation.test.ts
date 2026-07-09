import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWithSchema } from '../src/cli.js';

// Minimal stand-in for a Zod schema — the codebase discriminates purely on
// `typeof schema.safeParse === 'function'`, so a real zod dependency isn't needed here.
function fakeZodSchema(predicate: (data: any) => boolean) {
  return {
    safeParse(data: any) {
      return predicate(data)
        ? { success: true, data }
        : { success: false, error: { issues: [{ message: 'validation failed' }] } };
    },
  };
}

test('Zod schema validates via safeParse (pass)', () => {
  const schema = fakeZodSchema((data) => typeof data?.id === 'number');
  const result = validateWithSchema({ id: 1 }, schema);
  assert.equal(result.success, true);
  assert.deepEqual(result.errors, []);
});

test('Zod schema validates via safeParse (fail)', () => {
  const schema = fakeZodSchema((data) => typeof data?.id === 'number');
  const result = validateWithSchema({ id: 'not-a-number' }, schema);
  assert.equal(result.success, false);
  assert.deepEqual(result.errors, ['validation failed']);
});

test('raw JSON Schema object validates directly, no wrapper needed', () => {
  const schema = {
    type: 'object',
    required: ['id', 'title'],
    properties: {
      id: { type: 'integer' },
      title: { type: 'string' },
    },
  };
  assert.equal(validateWithSchema({ id: 1, title: 'foo' }, schema).success, true);
  assert.equal(validateWithSchema({ id: 1 }, schema).success, false);
});

test('OpenAPI 3.0-style nullable: true validates a null field', () => {
  const schema = {
    type: 'object',
    required: ['deletedAt'],
    properties: {
      deletedAt: { type: 'string', nullable: true },
    },
  };
  assert.equal(validateWithSchema({ deletedAt: null }, schema).success, true);
  assert.equal(validateWithSchema({ deletedAt: '2024-01-01' }, schema).success, true);
  assert.equal(validateWithSchema({ deletedAt: 5 }, schema).success, false);
});

test('OpenAPI 3.0-style boolean exclusiveMinimum rejects the boundary and accepts above it', () => {
  const schema = {
    type: 'object',
    required: ['count'],
    properties: {
      count: { type: 'number', minimum: 5, exclusiveMinimum: true },
    },
  };
  assert.equal(validateWithSchema({ count: 5 }, schema).success, false);
  assert.equal(validateWithSchema({ count: 6 }, schema).success, true);
});

test('a schema that is neither Zod nor compilable JSON Schema fails gracefully, not a throw', () => {
  const result = validateWithSchema({ id: 1 }, { type: 'bogus' });
  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
});
