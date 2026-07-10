import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv2020);

export function normalizeOpenApiSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeOpenApiSchema(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === 'nullable' ||
      key === 'example' ||
      key === 'examples' ||
      key === 'discriminator' ||
      key === 'xml' ||
      key === 'externalDocs' ||
      key === 'deprecated' ||
      key === 'readOnly' ||
      key === 'writeOnly'
    ) {
      continue;
    }
    result[key] = normalizeOpenApiSchema(value);
  }

  if (schema.nullable === true) {
    const type = result.type;
    if (Array.isArray(type)) {
      result.type = [...new Set([...type, 'null'])];
    } else if (typeof type === 'string') {
      result.type = [type, 'null'];
    } else {
      const nonNullSchema = { ...result };
      result.anyOf = [...(Array.isArray(nonNullSchema.anyOf) ? nonNullSchema.anyOf : [nonNullSchema]), { type: 'null' }];
      delete result.type;
    }
  }

  if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') {
    result.exclusiveMinimum = schema.minimum;
    delete result.minimum;
  } else if (schema.exclusiveMinimum === false) {
    delete result.exclusiveMinimum;
  }

  if (schema.exclusiveMaximum === true && typeof schema.maximum === 'number') {
    result.exclusiveMaximum = schema.maximum;
    delete result.maximum;
  } else if (schema.exclusiveMaximum === false) {
    delete result.exclusiveMaximum;
  }

  return result;
}

export function validateAgainstSchema(data: any, schema: any): { success: boolean; errors: string[] } {
  try {
    const validate = ajv2020.compile(normalizeOpenApiSchema(schema));
    const success = validate(data);
    return {
      success: Boolean(success),
      errors: success
        ? []
        : (validate.errors || []).map((error) => {
            const path = error.instancePath || '/';
            return `${path} ${error.message || 'failed validation'}`;
          }),
    };
  } catch (error) {
    return { success: false, errors: [error.message || 'invalid JSON schema'] };
  }
}
