import { readFile } from 'fs/promises';
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import type { Plugin } from '../plugin-api.js';
import type { OpenApiRequestMutation, SpectestConfig, Suite, TestCase } from '../types.js';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const DEFAULT_PARAM_STYLE: Record<string, { style: string; explode: boolean }> = {
  path: { style: 'simple', explode: false },
  query: { style: 'form', explode: true },
  header: { style: 'simple', explode: false },
  cookie: { style: 'form', explode: true },
};

class OpenApiSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiSkip';
  }
}

function parseDocument(raw: string, filePath: string): any {
  if (filePath.endsWith('.json')) {
    return JSON.parse(raw);
  }
  return parseYaml(raw);
}

function assertOpenApiDocument(doc: any): void {
  if (!doc || typeof doc !== 'object') {
    throw new Error('OpenAPI document must be an object');
  }
  if (typeof doc.swagger === 'string' || String(doc.openapi || '').startsWith('2.')) {
    throw new Error('Swagger/OpenAPI 2.0 is not supported');
  }
  if (!/^3\.(0|1)\.\d+/.test(String(doc.openapi || ''))) {
    throw new Error('OpenAPI document must declare version 3.0.x or 3.1.x');
  }
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error('OpenAPI document must include a paths object');
  }
}

function decodePointerPart(part: string): string {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(root: any, pointer: string): any {
  if (!pointer.startsWith('#/')) {
    throw new OpenApiSkip(`external or unsupported ref '${pointer}'`);
  }
  const parts = pointer.slice(2).split('/').map(decodePointerPart);
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new OpenApiSkip(`unresolved ref '${pointer}'`);
    }
    current = current[part];
  }
  return current;
}

function resolveRefs<T>(value: T, root: any, stack: string[] = []): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, root, stack)) as T;
  }
  const obj = value as any;
  if (typeof obj.$ref === 'string') {
    if (stack.includes(obj.$ref)) {
      throw new OpenApiSkip(`circular ref '${obj.$ref}'`);
    }
    const resolved = resolvePointer(root, obj.$ref);
    const { $ref, ...siblings } = obj;
    return resolveRefs({ ...resolved, ...siblings }, root, [...stack, obj.$ref]) as T;
  }
  const result: any = {};
  for (const [key, nested] of Object.entries(obj)) {
    result[key] = resolveRefs(nested, root, stack);
  }
  return result;
}

function stableSlug(text: string): string {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'openapi-operation';
}

function firstExample(examples: any): any {
  if (!examples || typeof examples !== 'object') return undefined;
  const first = Object.values(examples)[0] as any;
  if (!first || typeof first !== 'object') return undefined;
  if ('value' in first) return first.value;
  return first;
}

function exampleValue(source: any): any {
  if (!source || typeof source !== 'object') return undefined;
  if ('example' in source) return source.example;
  const examplesValue = firstExample(source.examples);
  if (examplesValue !== undefined) return examplesValue;
  if (source.schema && typeof source.schema === 'object') {
    if ('example' in source.schema) return source.schema.example;
    if ('default' in source.schema) return source.schema.default;
  }
  return undefined;
}

function valueToString(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function hasDefaultSerialization(param: any): boolean {
  const location = param.in;
  const defaults = DEFAULT_PARAM_STYLE[location];
  if (!defaults) return false;
  const style = param.style || defaults.style;
  const explode = typeof param.explode === 'boolean' ? param.explode : defaults.explode;
  return style === defaults.style && explode === defaults.explode;
}

function buildParameters(pathTemplate: string, parameters: any[]): {
  endpointPath: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  cookies: Record<string, string>;
} {
  let endpointPath = pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  for (const param of parameters) {
    if (!param || typeof param !== 'object' || !param.in || !param.name) continue;
    if (!hasDefaultSerialization(param)) {
      throw new OpenApiSkip(`unsupported parameter serialization for ${param.in} parameter '${param.name}'`);
    }

    const value = exampleValue(param);
    if (value === undefined) {
      if (param.required || param.in === 'path') {
        throw new OpenApiSkip(`missing required ${param.in} parameter '${param.name}' example/default`);
      }
      continue;
    }

    if (param.in === 'path') {
      endpointPath = endpointPath.replace(new RegExp(`\\{${param.name}\\}`, 'g'), encodeURIComponent(valueToString(value)));
    } else if (param.in === 'query') {
      query.set(param.name, valueToString(value));
    } else if (param.in === 'header') {
      headers[param.name] = valueToString(value);
    } else if (param.in === 'cookie') {
      cookies[param.name] = valueToString(value);
    }
  }

  const unresolvedPathParam = endpointPath.match(/\{[^}]+\}/);
  if (unresolvedPathParam) {
    throw new OpenApiSkip(`missing required path parameter ${unresolvedPathParam[0]} example/default`);
  }

  return { endpointPath, query, headers, cookies };
}

function chooseJsonContent(content: any): any {
  if (!content || typeof content !== 'object') return undefined;
  return content['application/json'];
}

function buildRequestBody(operation: any): any {
  const requestBody = operation.requestBody;
  if (!requestBody) return undefined;
  const jsonContent = chooseJsonContent(requestBody.content);
  if (!jsonContent) {
    if (requestBody.required) {
      throw new OpenApiSkip('unsupported required request body media type');
    }
    return undefined;
  }
  const value = exampleValue(jsonContent);
  if (value === undefined && requestBody.required) {
    throw new OpenApiSkip('missing required request body example/default');
  }
  return value;
}

function responseStatusCode(status: string): number | undefined {
  if (/^\d+$/.test(status)) return Number(status);
  return undefined;
}

function chooseResponse(operation: any): { status?: number; schema?: any; example?: any; weakDefaultStatus?: boolean } {
  const responses = operation.responses || {};
  const successStatus = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .map(Number)
    .sort((a, b) => a - b)[0];
  const responseKey = successStatus !== undefined ? String(successStatus) : responses.default ? 'default' : undefined;
  if (!responseKey) {
    throw new OpenApiSkip('no usable response status');
  }

  const response = responses[responseKey] || {};
  const status = responseStatusCode(responseKey);
  if (status === 204 || status === 304) {
    return { status };
  }

  const jsonContent = chooseJsonContent(response.content);
  if (!jsonContent) {
    if (status !== undefined) {
      return { status };
    }
    throw new OpenApiSkip('no usable response assertion');
  }

  const schema = jsonContent.schema;
  const example = exampleValue(jsonContent);
  if (!schema && example === undefined && status === undefined) {
    throw new OpenApiSkip('no usable response assertion');
  }

  return {
    status,
    schema,
    example,
    weakDefaultStatus: status === undefined,
  };
}

function effectiveServerPrefix(doc: any, operation: any, cfg: SpectestConfig): string {
  const servers = Array.isArray(operation.servers) ? operation.servers : doc.servers;
  if (!Array.isArray(servers) || servers.length === 0) return '';

  let selected: any;
  if (cfg.openapiServer !== undefined) {
    if (typeof cfg.openapiServer === 'number') {
      selected = servers[cfg.openapiServer];
    } else {
      selected = servers.find((server: any) => server?.url === cfg.openapiServer);
    }
    if (!selected) {
      throw new OpenApiSkip(`configured OpenAPI server '${cfg.openapiServer}' was not found`);
    }
  } else if (servers.length === 1) {
    selected = servers[0];
  } else if (operation.servers) {
    throw new OpenApiSkip('unsupported operation-level server override');
  } else {
    return '';
  }

  const serverUrl = String(selected?.url || '');
  if (!serverUrl || /^https?:\/\//i.test(serverUrl)) {
    return '';
  }
  return serverUrl.replace(/\/$/, '');
}

function mergeCookieHeader(headers: Record<string, string>, cookies: Record<string, string>): void {
  const cookieEntries = Object.entries(cookies);
  if (cookieEntries.length === 0) return;
  const cookieValue = cookieEntries.map(([key, value]) => `${key}=${value}`).join('; ');
  headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${cookieValue}` : cookieValue;
}

function applyMutation(
  headers: Record<string, string>,
  query: URLSearchParams,
  mutation?: OpenApiRequestMutation | void
): void {
  if (!mutation) return;
  if (mutation.headers) {
    for (const [key, value] of Object.entries(mutation.headers as Record<string, string>)) {
      headers[key] = String(value);
    }
  }
  if (mutation.query) {
    for (const [key, value] of Object.entries(mutation.query)) {
      query.set(key, value);
    }
  }
  if (mutation.cookies) {
    mergeCookieHeader(headers, mutation.cookies);
  }
}

async function applySecurity(
  cfg: SpectestConfig,
  doc: any,
  operation: any,
  method: string,
  pathKey: string,
  headers: Record<string, string>,
  query: URLSearchParams
): Promise<void> {
  const security = operation.security ?? doc.security;
  if (!Array.isArray(security) || security.length === 0) return;
  const schemes = doc.components?.securitySchemes || {};

  for (const requirement of security) {
    const entries = Object.keys(requirement || {});
    if (entries.length === 0) return;
    const hooks = cfg.openapiAuth || {};
    const hasAllHooks = entries.every((schemeName) => typeof hooks[schemeName] === 'function');
    if (!hasAllHooks) continue;

    for (const schemeName of entries) {
      const mutation = await hooks[schemeName]({
        schemeName,
        scheme: schemes[schemeName],
        operation,
        method: method.toUpperCase(),
        path: pathKey,
      });
      applyMutation(headers, query, mutation);
    }
    return;
  }

  throw new OpenApiSkip('missing auth hook');
}

function appendQuery(endpoint: string, query: URLSearchParams): string {
  const queryString = query.toString();
  if (!queryString) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryString}`;
}

function skippedTest(name: string, operationId: string, endpoint: string, tags: string[], reason: string): TestCase {
  return {
    name,
    operationId,
    endpoint,
    tags,
    skip: true,
    skipReason: reason,
    response: {},
  };
}

async function operationToTest(
  doc: any,
  cfg: SpectestConfig,
  method: string,
  pathKey: string,
  operation: any,
  rootParameters: any[] = []
): Promise<TestCase> {
  const name = operation.summary || operation.operationId || `${method.toUpperCase()} ${pathKey}`;
  const operationId = operation.operationId || stableSlug(`${method}-${pathKey}`);
  const tags = [...new Set([...(operation.tags || []), 'openapi'].map(String))];

  try {
    const resolvedOperation = resolveRefs(operation, doc);
    const parameters = [
      ...rootParameters.map((param) => resolveRefs(param, doc)),
      ...(resolvedOperation.parameters || []).map((param: any) => resolveRefs(param, doc)),
    ];
    const serverPrefix = effectiveServerPrefix(doc, resolvedOperation, cfg);
    const { endpointPath, query, headers, cookies } = buildParameters(pathKey, parameters);
    mergeCookieHeader(headers, cookies);

    const body = buildRequestBody(resolvedOperation);
    const response = chooseResponse(resolvedOperation);
    const endpointWithoutQuery = `${serverPrefix}${endpointPath}`;
    await applySecurity(cfg, doc, resolvedOperation, method, pathKey, headers, query);

    const test: TestCase = {
      name,
      operationId,
      endpoint: appendQuery(endpointWithoutQuery, query),
      tags,
      request: {
        method: method.toUpperCase(),
        headers,
      },
      response: {},
    };
    if (body !== undefined) {
      test.request!.body = body;
    }
    if (response.status !== undefined) {
      (test.response as any).status = response.status;
    }
    if (response.schema) {
      test.response!.schema = {
        __spectestJsonSchema: true,
        schema: response.schema,
        openapiVersion: doc.openapi,
      };
    } else if (response.example !== undefined) {
      test.response!.json = response.example;
    }
    if (response.weakDefaultStatus) {
      (test as any).openapiWeakDefaultStatus = true;
    }
    return test;
  } catch (error) {
    if (error instanceof OpenApiSkip) {
      return skippedTest(name, operationId, pathKey, tags, error.message);
    }
    throw error;
  }
}

function assertUniqueOperationIds(suites: Suite[]): void {
  const seen = new Map<string, string>();
  for (const suite of suites) {
    for (const test of [...suite.setup, ...suite.tests, ...suite.teardown]) {
      if (!test.operationId) continue;
      const existing = seen.get(test.operationId);
      if (existing) {
        throw new Error(`Duplicate operationId '${test.operationId}' in ${suite.name}; already used in ${existing}`);
      }
      seen.set(test.operationId, suite.name);
    }
  }
}

async function loadOpenApiSuite(filePath: string, cfg: SpectestConfig): Promise<Suite> {
  const raw = await readFile(filePath, 'utf8');
  const doc = parseDocument(raw, filePath);
  assertOpenApiDocument(doc);

  const name = doc.info?.title || path.relative(process.cwd(), filePath);
  const tests: TestCase[] = [];
  for (const [pathKey, pathItem] of Object.entries(doc.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const rootParameters = Array.isArray((pathItem as any).parameters) ? (pathItem as any).parameters : [];
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      tests.push(await operationToTest(doc, cfg, method, pathKey, operation, rootParameters));
    }
  }

  const suite = { name, tests, setup: [], teardown: [], loadPath: filePath };
  for (const test of tests) {
    test.suiteName = name;
  }
  assertUniqueOperationIds([suite]);
  return suite;
}

export const openApiLoaderPlugin = (cfg: SpectestConfig): Plugin => ({
  name: 'openapi-loader',
  setup(ctx) {
    ctx.onLoad({ filter: /\.(json|ya?ml)$/i, source: 'openapi' }, async ({ path }) => {
      const suite = await loadOpenApiSuite(path, cfg);
      return { suites: [suite] };
    });
  },
});
