import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import type { Plugin } from '../plugin-api.js';
import type {
  OpenApiBeforeSendHook,
  OpenApiNegativeTestsConfig,
  OpenApiPostTestHook,
  OpenApiRequestMutation,
  OpenApiRequestMutator,
  SpectestConfig,
  Suite,
  TestCase,
} from '../types.js';
import { mutateObjectSchema, mutateValueForParam } from './openapi-schema-mutator.js';
import { validateAgainstSchema } from '../openapi-schema-validate.js';

const NEGATIVE_KEY_PREFIX = '__negative-';

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

type NegativeTestOverride = {
  enabled?: boolean;
  fields?: string[];
  status?: number;
  seedExample?: string;
};

type NormalizedXSpectest = {
  status?: number;
  tags?: string[];
  skip?: boolean;
  skipReason?: string;
  phase?: 'setup' | 'main' | 'teardown';
  dependsOn?: string[];
  beforeSend?: string;
  postTest?: string;
  security?: string;
  generate?: Record<string, string>;
  negative?: NegativeTestOverride;
};

type PendingLink = {
  kind: 'path' | 'query' | 'header' | 'cookie' | 'body';
  name?: string;
  source: string;
  expression: string;
};

type LinkSource = { from: string; parameters: Record<string, string>; requestBody?: string };
type ParamLinkCandidate = { name: string; source: string; expression: string };
type BodyLinkCandidate = { source: string; expression: string };

type OperationEntry = {
  method: string;
  pathKey: string;
  operation: any;
  rootParameters: any[];
  operationId: string;
  exampleKeys: string[];
  resolvedOperation?: any;
  resolvedParameters?: any[];
  bodyJsonContent?: any;
  resolutionError?: OpenApiSkip;
};

type SecurityOverride = { mode: 'none' } | { mode: 'variant'; variant: string };

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

function exampleValueForKey(source: any, key: string | undefined): any {
  if (!source || typeof source !== 'object') return undefined;
  if (key && source.examples && typeof source.examples === 'object' && key in source.examples) {
    const entry = source.examples[key];
    if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
    return entry;
  }
  return exampleValue(source);
}

function addExampleKeys(keys: Set<string>, source: any): void {
  if (source?.examples && typeof source.examples === 'object') {
    Object.keys(source.examples).forEach((k) => keys.add(k));
  }
}

function collectExampleKeys(bodyJsonContent: any, parameters: any[], responses: any): string[] {
  const keys = new Set<string>();
  addExampleKeys(keys, bodyJsonContent);
  for (const param of parameters) {
    addExampleKeys(keys, param);
  }
  for (const response of Object.values(responses || {})) {
    addExampleKeys(keys, chooseJsonContent((response as any)?.content));
  }
  return [...keys];
}

function normalizeXSpectest(raw: any): NormalizedXSpectest {
  if (!raw || typeof raw !== 'object') return {};
  const result: NormalizedXSpectest = {};
  if (typeof raw.status === 'number') result.status = raw.status;
  if (Array.isArray(raw.tags)) result.tags = raw.tags.map(String);
  if (typeof raw.skip === 'boolean') result.skip = raw.skip;
  if (typeof raw.skipReason === 'string') result.skipReason = raw.skipReason;
  if (raw.phase === 'setup' || raw.phase === 'main' || raw.phase === 'teardown') result.phase = raw.phase;
  if (Array.isArray(raw.dependsOn)) result.dependsOn = raw.dependsOn.map(String);
  if (typeof raw.beforeSend === 'string') result.beforeSend = raw.beforeSend;
  if (typeof raw.postTest === 'string') result.postTest = raw.postTest;
  if (typeof raw.security === 'string') result.security = raw.security;
  if (raw.generate && typeof raw.generate === 'object') result.generate = raw.generate;
  if (raw.negative && typeof raw.negative === 'object') {
    const negative: NegativeTestOverride = {};
    if (typeof raw.negative.enabled === 'boolean') negative.enabled = raw.negative.enabled;
    if (Array.isArray(raw.negative.fields)) negative.fields = raw.negative.fields.map(String);
    if (typeof raw.negative.status === 'number') negative.status = raw.negative.status;
    if (typeof raw.negative.seedExample === 'string') negative.seedExample = raw.negative.seedExample;
    result.negative = negative;
  }
  return result;
}

function mergeXSpectest(base: NormalizedXSpectest, override: NormalizedXSpectest): NormalizedXSpectest {
  return { ...base, ...override };
}

function collectXSpectestForKey(
  resolvedOperation: any,
  bodyJsonContent: any,
  parameters: any[],
  key: string | undefined
): NormalizedXSpectest {
  let merged = normalizeXSpectest(resolvedOperation['x-spectest']);
  if (!key) return merged;

  const bodyEntry = bodyJsonContent?.examples?.[key];
  merged = mergeXSpectest(merged, normalizeXSpectest(bodyEntry?.['x-spectest']));
  for (const param of parameters) {
    const paramEntry = param?.examples?.[key];
    merged = mergeXSpectest(merged, normalizeXSpectest(paramEntry?.['x-spectest']));
  }
  for (const response of Object.values(resolvedOperation.responses || {})) {
    const jsonContent = chooseJsonContent((response as any)?.content);
    const responseEntry = jsonContent?.examples?.[key];
    merged = mergeXSpectest(merged, normalizeXSpectest(responseEntry?.['x-spectest']));
  }
  return merged;
}

const GENERATORS: Record<string, () => string> = {
  uuid: () => randomUUID(),
  timestamp: () => String(Date.now()),
  shortId: () => Math.random().toString(36).slice(2, 10),
};

const GENERATOR_PLACEHOLDER = /\{\{(uuid|timestamp|shortId)\}\}/g;

function resolveGeneratorPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(GENERATOR_PLACEHOLDER, (_match, generatorName: string) => GENERATORS[generatorName]()) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveGeneratorPlaceholders(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(value as any)) {
      result[k] = resolveGeneratorPlaceholders(v);
    }
    return result;
  }
  return value;
}

function setByPath(target: any, parts: string[], value: any): void {
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function applyGeneratorOverrides(body: any, generate: Record<string, string> | undefined): any {
  if (!generate || Object.keys(generate).length === 0) return body;
  if (body === undefined || body === null || typeof body !== 'object') return body;
  const result = JSON.parse(JSON.stringify(body));
  for (const [pathKey, generatorName] of Object.entries(generate)) {
    const generator = GENERATORS[generatorName];
    if (!generator) {
      throw new OpenApiSkip(`unknown x-spectest.generate generator '${generatorName}'`);
    }
    setByPath(result, pathKey.split('.'), generator());
  }
  return result;
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

function buildParameters(
  pathTemplate: string,
  parameters: any[],
  key: string | undefined,
  linkCandidates: ParamLinkCandidate[]
): {
  endpointPath: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  pendingLinks: PendingLink[];
} {
  let endpointPath = pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const pendingLinks: PendingLink[] = [];
  const linkedPathParams = new Set<string>();

  for (const param of parameters) {
    if (!param || typeof param !== 'object' || !param.in || !param.name) continue;
    if (!hasDefaultSerialization(param)) {
      throw new OpenApiSkip(`unsupported parameter serialization for ${param.in} parameter '${param.name}'`);
    }

    const value = resolveGeneratorPlaceholders(exampleValueForKey(param, key));
    if (value === undefined) {
      if (param.required || param.in === 'path') {
        const link = linkCandidates.find((c) => c.name === param.name);
        if (link) {
          pendingLinks.push({ kind: param.in, name: param.name, source: link.source, expression: link.expression });
          if (param.in === 'path') linkedPathParams.add(param.name);
          continue;
        }
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

  const unresolvedPathParams = [...endpointPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const trulyUnresolved = unresolvedPathParams.find((p) => !linkedPathParams.has(p));
  if (trulyUnresolved) {
    throw new OpenApiSkip(`missing required path parameter {${trulyUnresolved}} example/default`);
  }

  return { endpointPath, query, headers, cookies, pendingLinks };
}

function chooseJsonContent(content: any): any {
  if (!content || typeof content !== 'object') return undefined;
  return content['application/json'];
}

function buildRequestBody(
  operation: any,
  key: string | undefined,
  bodyCandidate: BodyLinkCandidate | undefined
): { value: any; pendingLink?: PendingLink } {
  const requestBody = operation.requestBody;
  if (!requestBody) return { value: undefined };
  const jsonContent = chooseJsonContent(requestBody.content);
  if (!jsonContent) {
    if (requestBody.required) {
      throw new OpenApiSkip('unsupported required request body media type');
    }
    return { value: undefined };
  }
  const value = exampleValueForKey(jsonContent, key);
  if (value === undefined) {
    if (requestBody.required) {
      if (bodyCandidate) {
        return { value: undefined, pendingLink: { kind: 'body', source: bodyCandidate.source, expression: bodyCandidate.expression } };
      }
      throw new OpenApiSkip('missing required request body example/default');
    }
    return { value: undefined };
  }
  return { value };
}

function responseStatusCode(status: string): number | undefined {
  if (/^\d+$/.test(status)) return Number(status);
  return undefined;
}

function chooseResponse(
  operation: any,
  key: string | undefined,
  forcedStatus: number | undefined
): { status?: number; schema?: any; example?: any; weakDefaultStatus?: boolean } {
  const responses = operation.responses || {};
  let responseKey: string | undefined;

  if (forcedStatus !== undefined) {
    responseKey = String(forcedStatus);
    if (!responses[responseKey]) {
      throw new OpenApiSkip(`x-spectest.status ${forcedStatus} has no matching response definition`);
    }
  } else if (key) {
    responseKey = Object.keys(responses).find((status) => {
      if (!/^\d\d\d$/.test(status) || /^2\d\d$/.test(status)) return false;
      const jsonContent = chooseJsonContent(responses[status]?.content);
      return Boolean(jsonContent?.examples && typeof jsonContent.examples === 'object' && key in jsonContent.examples);
    });
  }

  if (!responseKey) {
    const successStatus = Object.keys(responses)
      .filter((status) => /^2\d\d$/.test(status))
      .map(Number)
      .sort((a, b) => a - b)[0];
    responseKey = successStatus !== undefined ? String(successStatus) : responses.default ? 'default' : undefined;
  }
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
  const example = exampleValueForKey(jsonContent, key);
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
  requestMeta: { credentials?: RequestCredentials },
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
  if (mutation.credentials) {
    requestMeta.credentials = mutation.credentials;
  }
}

function resolveAuthHook(hooksEntry: any, variantName: string | undefined): OpenApiRequestMutator | undefined {
  if (typeof hooksEntry === 'function') {
    return variantName ? undefined : hooksEntry;
  }
  if (hooksEntry && typeof hooksEntry === 'object') {
    const key = variantName || 'valid';
    return typeof hooksEntry[key] === 'function' ? hooksEntry[key] : undefined;
  }
  return undefined;
}

async function applySecurity(
  cfg: SpectestConfig,
  doc: any,
  operation: any,
  method: string,
  pathKey: string,
  headers: Record<string, string>,
  query: URLSearchParams,
  requestMeta: { credentials?: RequestCredentials },
  securityOverride?: SecurityOverride
): Promise<void> {
  if (securityOverride?.mode === 'none') return;
  const security = operation.security ?? doc.security;
  if (!Array.isArray(security) || security.length === 0) return;
  const schemes = doc.components?.securitySchemes || {};
  const variantName = securityOverride?.mode === 'variant' ? securityOverride.variant : undefined;

  for (const requirement of security) {
    const entries = Object.keys(requirement || {});
    if (entries.length === 0) return;
    const hooks = cfg.openapiAuth || {};
    const resolvedHooks = entries.map((schemeName) => resolveAuthHook(hooks[schemeName], variantName));
    const hasAllHooks = resolvedHooks.every((hook) => typeof hook === 'function');
    if (!hasAllHooks) continue;

    for (let i = 0; i < entries.length; i += 1) {
      const schemeName = entries[i];
      const mutation = await resolvedHooks[i]!({
        schemeName,
        scheme: schemes[schemeName],
        operation,
        method: method.toUpperCase(),
        path: pathKey,
      });
      applyMutation(headers, query, requestMeta, mutation);
    }
    return;
  }

  throw new OpenApiSkip(variantName ? `missing auth hook variant '${variantName}' for required scheme` : 'missing auth hook');
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

function resolveHooks(
  cfg: SpectestConfig,
  xSpectest: NormalizedXSpectest
): { beforeSend?: OpenApiBeforeSendHook; postTest?: OpenApiPostTestHook; skip?: boolean; reason?: string } {
  const result: { beforeSend?: OpenApiBeforeSendHook; postTest?: OpenApiPostTestHook } = {};
  if (xSpectest.beforeSend) {
    const entry = cfg.openapiHooks?.[xSpectest.beforeSend];
    if (!entry?.beforeSend) {
      return { skip: true, reason: `missing openapiHooks entry '${xSpectest.beforeSend}' for beforeSend` };
    }
    result.beforeSend = entry.beforeSend;
  }
  if (xSpectest.postTest) {
    const entry = cfg.openapiHooks?.[xSpectest.postTest];
    if (!entry?.postTest) {
      return { skip: true, reason: `missing openapiHooks entry '${xSpectest.postTest}' for postTest` };
    }
    result.postTest = entry.postTest;
  }
  return result;
}

function parseRuntimeExpression(
  expression: string
): { kind: 'body'; pointer: string } | { kind: 'header'; name: string } | undefined {
  const bodyMatch = /^\$response\.body#(\/.*)$/.exec(expression);
  if (bodyMatch) return { kind: 'body', pointer: bodyMatch[1] };
  const headerMatch = /^\$response\.header\.(.+)$/.exec(expression);
  if (headerMatch) return { kind: 'header', name: headerMatch[1] };
  return undefined;
}

function getByJsonPointer(data: any, pointer: string): any {
  if (!pointer || pointer === '/') return data;
  const parts = pointer.replace(/^\//, '').split('/').map(decodePointerPart);
  let current = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function getHeaderValue(headers: any, name: string): any {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase());
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry ? entry[1] : undefined;
}

function resolveRuntimeExpression(expression: string, completedResult: any): any {
  const parsed = parseRuntimeExpression(expression);
  if (!parsed) {
    throw new Error(`unsupported link runtime expression '${expression}'`);
  }
  if (parsed.kind === 'body') {
    return getByJsonPointer(completedResult?.response?.data, parsed.pointer);
  }
  return getHeaderValue(completedResult?.response?.headers, parsed.name);
}

function applyPendingLinks(config: any, state: any, pendingLinks: PendingLink[]): any {
  const updated = { ...config, headers: { ...config.headers } };
  let url = String(updated.url);
  for (const link of pendingLinks) {
    const completed = state?.completedCases?.[link.source];
    if (!completed) {
      throw new Error(`link source '${link.source}' has no completed result in state`);
    }
    const value = resolveRuntimeExpression(link.expression, completed);
    if (link.kind === 'path') {
      url = url.replace(new RegExp(`\\{${link.name}\\}`, 'g'), encodeURIComponent(valueToString(value)));
    } else if (link.kind === 'query') {
      const [base, qs] = url.split('?');
      const params = new URLSearchParams(qs || '');
      params.set(link.name!, valueToString(value));
      const queryString = params.toString();
      url = queryString ? `${base}?${queryString}` : base;
    } else if (link.kind === 'header') {
      updated.headers[link.name!] = valueToString(value);
    } else if (link.kind === 'cookie') {
      mergeCookieHeader(updated.headers, { [link.name!]: valueToString(value) });
    } else if (link.kind === 'body') {
      updated.data = value;
    }
  }
  updated.url = url;
  return updated;
}

function composeBeforeSend(pendingLinks: PendingLink[], userBeforeSend: OpenApiBeforeSendHook | undefined): OpenApiBeforeSendHook {
  return async (config: any, state: any) => {
    let updated = config;
    if (pendingLinks.length) {
      updated = applyPendingLinks(config, state, pendingLinks);
    }
    if (userBeforeSend) {
      const result = await userBeforeSend(updated, state);
      if (result) updated = result;
    }
    return updated;
  };
}

function resolveLinkCandidatesForParams(
  sources: LinkSource[] | undefined,
  operationIdToGeneratedIds: Map<string, string[]>
): { paramCandidates: ParamLinkCandidate[]; bodyCandidate?: BodyLinkCandidate } {
  const paramCandidates: ParamLinkCandidate[] = [];
  let bodyCandidate: BodyLinkCandidate | undefined;
  for (const source of sources || []) {
    const generatedIds = operationIdToGeneratedIds.get(source.from);
    if (!generatedIds || generatedIds.length !== 1) continue;
    const sourceId = generatedIds[0];
    for (const [paramName, expression] of Object.entries(source.parameters || {})) {
      if (!paramCandidates.some((c) => c.name === paramName)) {
        paramCandidates.push({ name: paramName, source: sourceId, expression });
      }
    }
    if (!bodyCandidate && source.requestBody) {
      bodyCandidate = { source: sourceId, expression: source.requestBody };
    }
  }
  return { paramCandidates, bodyCandidate };
}

function collectLinks(operationEntries: OperationEntry[]): Map<string, LinkSource[]> {
  const index = new Map<string, LinkSource[]>();
  for (const entry of operationEntries) {
    if (entry.resolutionError || !entry.resolvedOperation) {
      continue;
    }
    const resolvedOperation = entry.resolvedOperation;
    const responses = resolvedOperation.responses || {};
    for (const response of Object.values(responses)) {
      const links = (response as any)?.links;
      if (!links || typeof links !== 'object') continue;
      for (const link of Object.values(links)) {
        const targetOperationId = (link as any)?.operationId;
        if (typeof targetOperationId !== 'string') continue;
        const list = index.get(targetOperationId) || [];
        list.push({
          from: entry.operationId,
          parameters:
            (link as any).parameters && typeof (link as any).parameters === 'object' ? (link as any).parameters : {},
          requestBody: typeof (link as any).requestBody === 'string' ? (link as any).requestBody : undefined,
        });
        index.set(targetOperationId, list);
      }
    }
  }
  return index;
}

async function buildTestForExample(
  doc: any,
  cfg: SpectestConfig,
  entry: OperationEntry,
  key: string | undefined,
  linkIndex: Map<string, LinkSource[]>,
  operationIdToGeneratedIds: Map<string, string[]>,
  preservePlaceholders: boolean
): Promise<TestCase> {
  const { method, pathKey, operation, operationId: rawOperationId } = entry;
  const fallbackName = operation.summary || operation.operationId || `${method.toUpperCase()} ${pathKey}`;
  const testOperationId = key ? `${rawOperationId}+${key}` : rawOperationId;
  const name = key ? `${fallbackName} — ${key}` : fallbackName;
  const baseTags = [...new Set([...(operation.tags || []), 'openapi'].map(String))];

  if (entry.resolutionError) {
    return skippedTest(name, testOperationId, pathKey, baseTags, entry.resolutionError.message);
  }

  try {
    const resolvedOperation = entry.resolvedOperation;
    const parameters = entry.resolvedParameters || [];
    const bodyJsonContent = entry.bodyJsonContent;
    const xSpectest = collectXSpectestForKey(resolvedOperation, bodyJsonContent, parameters, key);
    const tags = [...new Set([...baseTags, ...(xSpectest.tags || [])])];

    if (xSpectest.skip) {
      const test = skippedTest(name, testOperationId, pathKey, tags, xSpectest.skipReason || 'skipped via x-spectest');
      if (xSpectest.phase) test.phase = xSpectest.phase;
      return test;
    }

    const { paramCandidates, bodyCandidate } = resolveLinkCandidatesForParams(
      linkIndex.get(rawOperationId),
      operationIdToGeneratedIds
    );
    const serverPrefix = effectiveServerPrefix(doc, resolvedOperation, cfg);
    const { endpointPath, query, headers, cookies, pendingLinks } = buildParameters(pathKey, parameters, key, paramCandidates);
    mergeCookieHeader(headers, cookies);

    const { value: rawBody, pendingLink: bodyPendingLink } = buildRequestBody(resolvedOperation, key, bodyCandidate);
    if (bodyPendingLink) pendingLinks.push(bodyPendingLink);
    // When scaffolding a static file (preservePlaceholders), keep `{{uuid}}`/
    // `{{timestamp}}`/`{{shortId}}` tokens literal instead of baking in a
    // one-time value: generate-command.ts detects them and wires a
    // beforeSend that re-rolls them on every send, so re-running the
    // generated file doesn't replay the same "must not already exist" value
    // (e.g. a signup email) forever.
    const body =
      rawBody !== undefined
        ? applyGeneratorOverrides(preservePlaceholders ? rawBody : resolveGeneratorPlaceholders(rawBody), xSpectest.generate)
        : rawBody;

    const response = chooseResponse(resolvedOperation, key, xSpectest.status);
    const endpointWithoutQuery = `${serverPrefix}${endpointPath}`;

    const securityOverride: SecurityOverride | undefined =
      xSpectest.security === 'none'
        ? { mode: 'none' }
        : xSpectest.security
          ? { mode: 'variant', variant: xSpectest.security }
          : undefined;
    const requestMeta: { credentials?: RequestCredentials } = {};
    await applySecurity(cfg, doc, resolvedOperation, method, pathKey, headers, query, requestMeta, securityOverride);

    const test: TestCase = {
      name,
      operationId: testOperationId,
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
    if (requestMeta.credentials) {
      (test.request as any).credentials = requestMeta.credentials;
    }
    if (response.status !== undefined) {
      (test.response as any).status = response.status;
    }
    if (response.schema) {
      test.response!.schema = response.schema;
    } else if (response.example !== undefined) {
      test.response!.json = response.example;
    }
    if (response.weakDefaultStatus) {
      (test as any).openapiWeakDefaultStatus = true;
    }
    if (xSpectest.phase) {
      test.phase = xSpectest.phase;
    }

    const dependsOn = new Set<string>(xSpectest.dependsOn || []);
    pendingLinks.forEach((link) => dependsOn.add(link.source));
    if (dependsOn.size) {
      test.dependsOn = [...dependsOn];
    }

    const hooks = resolveHooks(cfg, xSpectest);
    if (hooks.skip) {
      return skippedTest(name, testOperationId, pathKey, tags, hooks.reason!);
    }
    if (pendingLinks.length) {
      test.beforeSend = composeBeforeSend(pendingLinks, hooks.beforeSend);
    } else if (hooks.beforeSend) {
      test.beforeSend = hooks.beforeSend;
    }
    if (hooks.postTest) {
      test.postTest = hooks.postTest;
    }

    return test;
  } catch (error) {
    if (error instanceof OpenApiSkip) {
      return skippedTest(name, testOperationId, pathKey, baseTags, error.message);
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

async function parseOpenApiDoc(filePath: string): Promise<any> {
  const raw = await readFile(filePath, 'utf8');
  const doc = parseDocument(raw, filePath);
  assertOpenApiDocument(doc);
  return doc;
}

function lowestDocumented4xx(responses: any): number | undefined {
  return Object.keys(responses || {})
    .filter((status) => /^4\d\d$/.test(status))
    .map(Number)
    .sort((a, b) => a - b)[0];
}

function hasAnyTag(tags: string[], candidates: string[]): boolean {
  const normalized = candidates.map((t) => t.toLowerCase());
  return tags.some((t) => normalized.includes(String(t).toLowerCase()));
}

function setExampleEntry(source: any, key: string, value: any, xSpectest?: any): void {
  if (!source || typeof source !== 'object') return;
  if (!source.examples || typeof source.examples !== 'object') source.examples = {};
  source.examples[key] = xSpectest ? { value, 'x-spectest': xSpectest } : { value };
}

/**
 * Seeds the operation's body + every parameter with the chosen seed's value under `key`, so a
 * request built for a synthetic negative key is well-formed except for the one mutated field.
 */
function seedAllUnderKey(entry: OperationEntry, seedKey: string, key: string): void {
  if (entry.bodyJsonContent) {
    const seedBody = exampleValueForKey(entry.bodyJsonContent, seedKey);
    if (seedBody !== undefined) setExampleEntry(entry.bodyJsonContent, key, seedBody);
  }
  for (const param of entry.resolvedParameters || []) {
    const seedValue = exampleValueForKey(param, seedKey);
    if (seedValue !== undefined) setExampleEntry(param, key, seedValue);
  }
}

/**
 * Mutates one field of an operation's request body/query/cookie parameters at a time, seeded from
 * an existing hand-written example, and injects each surviving violation as a synthetic entry into
 * the same `examples` map `collectExampleKeys` already reads — see design-docs/openapi-negative-and-fuzz-testing.md.
 * Never throws: an operation this can't safely apply to is simply left without negative cases.
 */
function injectNegativeExamples(
  entry: OperationEntry,
  cfg: SpectestConfig,
  ctx: { isLinkSource: boolean; isLinkTarget: boolean }
): void {
  const negativeCfg: OpenApiNegativeTestsConfig = cfg.openapiNegativeTests || {};
  if (!negativeCfg.enabled || entry.resolutionError || !entry.resolvedOperation) return;

  const resolvedOperation = entry.resolvedOperation;
  const opXSpectest = normalizeXSpectest(resolvedOperation['x-spectest']);
  if (opXSpectest.negative?.enabled === false) return;

  const tags = [...new Set([...(resolvedOperation.tags || []), ...(opXSpectest.tags || [])].map(String))];
  const excludeTags = negativeCfg.excludeTags || ['real-backend'];
  if (hasAnyTag(tags, excludeTags)) return;

  const hasDependsOn = Boolean(opXSpectest.dependsOn && opXSpectest.dependsOn.length > 0);
  if (hasDependsOn || ctx.isLinkSource || ctx.isLinkTarget) return;

  const existingKeys = collectExampleKeys(entry.bodyJsonContent, entry.resolvedParameters || [], resolvedOperation.responses);
  if (existingKeys.length === 0) return;

  const seedKey =
    opXSpectest.negative?.seedExample && existingKeys.includes(opXSpectest.negative.seedExample)
      ? opXSpectest.negative.seedExample
      : existingKeys[0];

  const statusOverride = opXSpectest.negative?.status;
  const status = statusOverride ?? lowestDocumented4xx(resolvedOperation.responses);
  if (status === undefined) return;

  const maxCases = negativeCfg.maxCasesPerOperation ?? 20;
  const fields = opXSpectest.negative?.fields;
  const xSpectestStamp = { status, tags: ['negative'] };
  let injectedCount = 0;

  const bodySchema = entry.bodyJsonContent?.schema;
  const seedBody = bodySchema ? exampleValueForKey(entry.bodyJsonContent, seedKey) : undefined;
  if (bodySchema && seedBody && typeof seedBody === 'object' && !Array.isArray(seedBody)) {
    for (const violation of mutateObjectSchema(bodySchema, seedBody, { fields })) {
      if (injectedCount >= maxCases) break;
      if (validateAgainstSchema(violation.value, bodySchema).success) continue;
      seedAllUnderKey(entry, seedKey, violation.key);
      setExampleEntry(entry.bodyJsonContent, violation.key, violation.value, xSpectestStamp);
      injectedCount += 1;
    }
  }

  for (const param of entry.resolvedParameters || []) {
    if (injectedCount >= maxCases) break;
    if (param.in !== 'query' && param.in !== 'cookie') continue;
    if (fields && !fields.includes(param.name)) continue;
    if (!param.schema) continue;
    const seedValue = exampleValueForKey(param, seedKey);
    if (seedValue === undefined) continue;
    // "required" violations are excluded here: a missing value for a required parameter is
    // indistinguishable, downstream, from an unresolved example — buildParameters treats it as
    // `missing required parameter` and skips the test rather than sending a param-less request.
    const violations = mutateValueForParam(param.schema, seedValue, false, param.name).filter(
      (v) => v.violatedConstraint !== 'required'
    );
    for (const violation of violations) {
      if (injectedCount >= maxCases) break;
      if (validateAgainstSchema(violation.value, param.schema).success) continue;
      seedAllUnderKey(entry, seedKey, violation.key);
      setExampleEntry(param, violation.key, violation.value, xSpectestStamp);
      injectedCount += 1;
    }
  }
}

function buildOperationEntries(doc: any, cfg: SpectestConfig = {}): OperationEntry[] {
  const operationEntries: OperationEntry[] = [];
  for (const [pathKey, pathItem] of Object.entries(doc.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const rootParameters = Array.isArray((pathItem as any).parameters) ? (pathItem as any).parameters : [];
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      const operationId = (operation as any).operationId || stableSlug(`${method}-${pathKey}`);
      let exampleKeys: string[] = [];
      let resolvedOperation: any;
      let resolvedParameters: any[] | undefined;
      let bodyJsonContent: any;
      let resolutionError: OpenApiSkip | undefined;
      try {
        resolvedOperation = resolveRefs(operation, doc);
        resolvedParameters = [
          ...rootParameters.map((param: any) => resolveRefs(param, doc)),
          ...(resolvedOperation.parameters || []).map((param: any) => resolveRefs(param, doc)),
        ];
        bodyJsonContent = chooseJsonContent(resolvedOperation.requestBody?.content);
        exampleKeys = collectExampleKeys(bodyJsonContent, resolvedParameters, resolvedOperation.responses);
      } catch (error) {
        exampleKeys = [];
        resolutionError = error instanceof OpenApiSkip ? error : new OpenApiSkip(String((error as any)?.message || error));
      }
      operationEntries.push({
        method,
        pathKey,
        operation,
        rootParameters,
        operationId,
        exampleKeys,
        resolvedOperation,
        resolvedParameters,
        bodyJsonContent,
        resolutionError,
      });
    }
  }

  const linkIndex = collectLinks(operationEntries);
  const linkSourceOperationIds = new Set<string>();
  for (const sources of linkIndex.values()) {
    for (const source of sources) linkSourceOperationIds.add(source.from);
  }

  for (const entry of operationEntries) {
    if (entry.resolutionError || !entry.resolvedOperation) continue;
    injectNegativeExamples(entry, cfg, {
      isLinkSource: linkSourceOperationIds.has(entry.operationId),
      isLinkTarget: linkIndex.has(entry.operationId),
    });
    entry.exampleKeys = collectExampleKeys(entry.bodyJsonContent, entry.resolvedParameters || [], entry.resolvedOperation.responses);
  }

  return operationEntries;
}

function generatedIdsForEntry(entry: OperationEntry): string[] {
  return entry.exampleKeys.length ? entry.exampleKeys.map((k) => `${entry.operationId}+${k}`) : [entry.operationId];
}

export async function loadOpenApiSuite(
  filePath: string,
  cfg: SpectestConfig,
  opts: { preservePlaceholders?: boolean } = {}
): Promise<Suite> {
  const doc = await parseOpenApiDoc(filePath);
  const name = doc.info?.title || path.relative(process.cwd(), filePath);

  const operationEntries = buildOperationEntries(doc, cfg);

  const operationIdToGeneratedIds = new Map<string, string[]>();
  for (const entry of operationEntries) {
    // Synthetic negative keys are excluded here so a link source that gets split into multiple
    // tests by negative injection still resolves to exactly one generated id for dependents'
    // auto-derived dependsOn/beforeSend. describeOpenApiOperations (coverage/--list) stays inclusive.
    const ids = generatedIdsForEntry(entry).filter((id) => !id.includes(`+${NEGATIVE_KEY_PREFIX}`));
    operationIdToGeneratedIds.set(entry.operationId, ids);
  }

  const linkIndex = collectLinks(operationEntries);

  const tests: TestCase[] = [];
  for (const entry of operationEntries) {
    const keys: (string | undefined)[] = entry.exampleKeys.length ? entry.exampleKeys : [undefined];
    for (const key of keys) {
      tests.push(
        await buildTestForExample(
          doc,
          cfg,
          entry,
          key,
          linkIndex,
          operationIdToGeneratedIds,
          opts.preservePlaceholders || false
        )
      );
    }
  }

  const suite = { name, tests, setup: [], teardown: [], loadPath: filePath };
  for (const test of tests) {
    test.suiteName = name;
  }
  assertUniqueOperationIds([suite]);
  return suite;
}

export interface OpenApiOperationDescriptor {
  method: string;
  pathKey: string;
  operationId: string;
  generatedIds: string[];
}

export async function describeOpenApiOperations(
  filePath: string,
  cfg: SpectestConfig = {}
): Promise<OpenApiOperationDescriptor[]> {
  const doc = await parseOpenApiDoc(filePath);
  return buildOperationEntries(doc, cfg).map((entry) => ({
    method: entry.method,
    pathKey: entry.pathKey,
    operationId: entry.operationId,
    generatedIds: generatedIdsForEntry(entry),
  }));
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
