export type Violation = {
  /** Suffix appended to the operationId/example key, e.g. `__negative-email-required` */
  key: string;
  value: any;
  violatedConstraint: string;
  fieldPath: string;
};

const GENERATOR_PLACEHOLDER = /\{\{(uuid|timestamp|shortId)\}\}/;

const FORMAT_BAD_VALUES: Record<string, string> = {
  email: 'not-an-email',
  date: 'not-a-date',
  'date-time': 'not-a-date-time',
  uri: '::not a uri::',
  uuid: 'not-a-uuid',
  ipv4: '999.999.999.999',
  ipv6: 'not-an-ipv6',
};

function slug(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function hasPlaceholder(value: any): boolean {
  return typeof value === 'string' && GENERATOR_PLACEHOLDER.test(value);
}

function violationsForFieldSchema(fieldPath: string, fieldSchema: any, seedValue: any): Violation[] {
  if (!fieldSchema || typeof fieldSchema !== 'object' || hasPlaceholder(seedValue)) {
    return [];
  }
  const violations: Violation[] = [];
  const pathSlug = slug(fieldPath);
  const type = fieldSchema.type;

  if (typeof fieldSchema.minLength === 'number' && fieldSchema.minLength > 0 && (type === 'string' || typeof seedValue === 'string')) {
    violations.push({
      key: `__negative-${pathSlug}-min-length`,
      value: 'x'.repeat(Math.max(0, fieldSchema.minLength - 1)),
      violatedConstraint: 'minLength',
      fieldPath,
    });
  }
  if (typeof fieldSchema.maxLength === 'number' && (type === 'string' || typeof seedValue === 'string')) {
    violations.push({
      key: `__negative-${pathSlug}-max-length`,
      value: 'x'.repeat(fieldSchema.maxLength + 1),
      violatedConstraint: 'maxLength',
      fieldPath,
    });
  }
  if (typeof fieldSchema.minimum === 'number' && (type === 'number' || type === 'integer' || typeof seedValue === 'number')) {
    violations.push({
      key: `__negative-${pathSlug}-minimum`,
      value: fieldSchema.minimum - 1,
      violatedConstraint: 'minimum',
      fieldPath,
    });
  }
  if (typeof fieldSchema.maximum === 'number' && (type === 'number' || type === 'integer' || typeof seedValue === 'number')) {
    violations.push({
      key: `__negative-${pathSlug}-maximum`,
      value: fieldSchema.maximum + 1,
      violatedConstraint: 'maximum',
      fieldPath,
    });
  }
  if (Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
    violations.push({
      key: `__negative-${pathSlug}-enum`,
      value: '__not-a-valid-enum-member__',
      violatedConstraint: 'enum',
      fieldPath,
    });
  }
  if (typeof fieldSchema.pattern === 'string') {
    violations.push({
      key: `__negative-${pathSlug}-pattern`,
      value: '__pattern-violation__',
      violatedConstraint: 'pattern',
      fieldPath,
    });
  }
  if (typeof fieldSchema.format === 'string' && FORMAT_BAD_VALUES[fieldSchema.format] !== undefined) {
    violations.push({
      key: `__negative-${pathSlug}-format`,
      value: FORMAT_BAD_VALUES[fieldSchema.format],
      violatedConstraint: 'format',
      fieldPath,
    });
  }
  if (type && type !== 'null') {
    const wrongTypeValue = type === 'string' ? 12345 : type === 'array' ? { not: 'an-array' } : 'not-the-right-type';
    violations.push({
      key: `__negative-${pathSlug}-type`,
      value: wrongTypeValue,
      violatedConstraint: 'type',
      fieldPath,
    });
  }
  if (type === 'array') {
    if (typeof fieldSchema.minItems === 'number' && fieldSchema.minItems > 0) {
      violations.push({
        key: `__negative-${pathSlug}-min-items`,
        value: Array.isArray(seedValue) ? seedValue.slice(0, Math.max(0, fieldSchema.minItems - 1)) : [],
        violatedConstraint: 'minItems',
        fieldPath,
      });
    }
    if (typeof fieldSchema.maxItems === 'number') {
      const base = Array.isArray(seedValue) && seedValue.length > 0 ? seedValue[0] : {};
      violations.push({
        key: `__negative-${pathSlug}-max-items`,
        value: Array.from({ length: fieldSchema.maxItems + 1 }, () => base),
        violatedConstraint: 'maxItems',
        fieldPath,
      });
    }
  }

  return violations;
}

/**
 * Walks an object schema's top-level `properties`, one violation per constraint per field,
 * seeded from a known-valid `seed` object. `opts.fields` restricts mutation to an allowlist
 * of top-level property names (default: all required + constrained properties).
 */
export function mutateObjectSchema(
  schema: any,
  seed: Record<string, any>,
  opts: { fields?: string[] } = {}
): Violation[] {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties) {
    return [];
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const properties: Record<string, any> = schema.properties;
  const allowlist = opts.fields;

  const violations: Violation[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (allowlist && !allowlist.includes(fieldName)) continue;
    const seedValue = seed?.[fieldName];

    if (required.includes(fieldName) && !hasPlaceholder(seedValue)) {
      const withoutField = { ...seed };
      delete withoutField[fieldName];
      violations.push({
        key: `__negative-${slug(fieldName)}-required`,
        value: withoutField,
        violatedConstraint: 'required',
        fieldPath: fieldName,
      });
    }

    violations.push(...violationsForFieldSchema(fieldName, fieldSchema, seedValue).map((v) => ({
      ...v,
      value: { ...seed, [fieldName]: v.value },
    })));
  }

  if (schema.additionalProperties === false) {
    violations.push({
      key: '__negative-additional-properties',
      value: { ...seed, __spectestUnexpectedProperty: 'unexpected' },
      violatedConstraint: 'additionalProperties',
      fieldPath: '(root)',
    });
  }

  return violations;
}

/**
 * Mutates a single parameter's value against its schema, producing standalone violated values
 * (not merged into an object) for use against query/cookie parameters.
 */
export function mutateValueForParam(schema: any, seed: any, required: boolean, paramName: string): Violation[] {
  if (hasPlaceholder(seed)) return [];
  const violations = violationsForFieldSchema(paramName, schema, seed);
  if (required) {
    violations.push({
      key: `__negative-${slug(paramName)}-required`,
      value: undefined,
      violatedConstraint: 'required',
      fieldPath: paramName,
    });
  }
  return violations;
}
