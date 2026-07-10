import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutateObjectSchema, mutateValueForParam } from '../src/plugins/openapi-schema-mutator.js';
import { validateAgainstSchema } from '../src/openapi-schema-validate.js';

const schema = {
  type: 'object',
  required: ['email', 'age'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', minLength: 3, maxLength: 50, pattern: '^.+@.+$' },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    role: { type: 'string', enum: ['admin', 'member'] },
    tags: { type: 'array', minItems: 1, maxItems: 3 },
  },
};

const seed = { email: 'a@b.com', age: 30, role: 'admin', tags: ['x'] };

function byConstraint(violations: ReturnType<typeof mutateObjectSchema>, fieldPath: string, constraint: string) {
  return violations.find((v) => v.fieldPath === fieldPath && v.violatedConstraint === constraint);
}

test('mutator produces one violation per constraint kind exercised by the schema', () => {
  const violations = mutateObjectSchema(schema, seed);

  assert.ok(byConstraint(violations, 'email', 'required'));
  assert.ok(byConstraint(violations, 'age', 'required'));
  assert.ok(byConstraint(violations, 'email', 'minLength'));
  assert.ok(byConstraint(violations, 'email', 'maxLength'));
  assert.ok(byConstraint(violations, 'email', 'pattern'));
  assert.ok(byConstraint(violations, 'email', 'format'));
  assert.ok(byConstraint(violations, 'email', 'type'));
  assert.ok(byConstraint(violations, 'age', 'minimum'));
  assert.ok(byConstraint(violations, 'age', 'maximum'));
  assert.ok(byConstraint(violations, 'age', 'type'));
  assert.ok(byConstraint(violations, 'role', 'enum'));
  assert.ok(byConstraint(violations, 'tags', 'minItems'));
  assert.ok(byConstraint(violations, 'tags', 'maxItems'));
  assert.ok(violations.some((v) => v.violatedConstraint === 'additionalProperties'));
});

test('every mutated payload fails Ajv validation against the request schema', () => {
  const violations = mutateObjectSchema(schema, seed);
  for (const violation of violations) {
    const { success } = validateAgainstSchema(violation.value, schema);
    assert.equal(success, false, `expected ${violation.key} to violate the schema`);
  }
});

test('a field whose seed value contains a generator placeholder is not mutated', () => {
  const violations = mutateObjectSchema(schema, { ...seed, email: '{{uuid}}@example.com' });
  assert.equal(byConstraint(violations, 'email', 'required'), undefined);
  assert.equal(byConstraint(violations, 'email', 'minLength'), undefined);
  assert.equal(byConstraint(violations, 'email', 'format'), undefined);
  // Other fields are still mutated.
  assert.ok(byConstraint(violations, 'age', 'required'));
});

test('opts.fields restricts mutation to an allowlist of top-level properties', () => {
  const violations = mutateObjectSchema(schema, seed, { fields: ['age'] });
  assert.ok(violations.some((v) => v.fieldPath === 'age'));
  assert.ok(!violations.some((v) => v.fieldPath === 'email'));
  assert.ok(!violations.some((v) => v.fieldPath === 'role'));
});

test('mutateValueForParam produces a required violation for a required query parameter', () => {
  const violations = mutateValueForParam({ type: 'string', minLength: 2 }, 'ab', true, 'search');
  assert.ok(violations.some((v) => v.violatedConstraint === 'required' && v.value === undefined));
  assert.ok(violations.some((v) => v.violatedConstraint === 'minLength'));
});
