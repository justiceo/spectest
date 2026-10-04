// Shared OpenAPI document helpers: parsing, $ref/JSON-pointer resolution, server
// selection, security-hook application and generator placeholders. Used by
// both the OpenAPI loader (plugins/openapi-loader.ts) and the Arazzo loader
// (arazzo/), which resolves Arazzo steps against the same OpenAPI documents.
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { load as parseYaml } from 'js-yaml';
import type { OpenApiRequestMutation, OpenApiRequestMutator, SpectestConfig } from '../types.js';

export const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export class OpenApiSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiSkip';
  }
}

export type SecurityOverride = { mode: 'none' } | { mode: 'variant'; variant: string };

export function parseDocument(raw: string, filePath: string): any {
  if (filePath.endsWith('.json')) {
    return JSON.parse(raw);
  }
  return parseYaml(raw);
}

export function assertOpenApiDocument(doc: any): void {
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

export async function parseOpenApiDoc(filePath: string): Promise<any> {
  const raw = await readFile(filePath, 'utf8');
  const doc = parseDocument(raw, filePath);
  assertOpenApiDocument(doc);
  return doc;
}

export function decodePointerPart(part: string): string {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function encodePointerPart(part: string): string {
  return part.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function resolvePointer(root: any, pointer: string): any {
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

export function resolveRefs<T>(value: T, root: any, stack: string[] = []): T {
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

export function getByJsonPointer(data: any, pointer: string): any {
  if (!pointer || pointer === '/') return data;
  const parts = pointer.replace(/^\//, '').split('/').map(decodePointerPart);
  let current = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function setByJsonPointer(target: any, pointer: string, value: any): void {
  const parts = pointer.replace(/^\//, '').split('/').map(decodePointerPart);
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

export function getHeaderValue(headers: any, name: string): any {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase());
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry ? entry[1] : undefined;
}

export function stableSlug(text: string): string {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'openapi-operation';
}

export function chooseJsonContent(content: any): any {
  if (!content || typeof content !== 'object') return undefined;
  return content['application/json'];
}

export function valueToString(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export const GENERATORS: Record<string, () => string> = {
  uuid: () => randomUUID(),
  timestamp: () => String(Date.now()),
  shortId: () => Math.random().toString(36).slice(2, 10),
};

const GENERATOR_PLACEHOLDER = /\{\{(uuid|timestamp|shortId)\}\}/g;

export function resolveGeneratorPlaceholders<T>(value: T): T {
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

/**
 * Relative server prefix (e.g. `/v1`) to prepend to an operation's path. Absolute
 * server URLs return '' so the run's baseUrl stays authoritative.
 */
export function effectiveServerPrefix(doc: any, operation: any, serverSelector: string | number | undefined): string {
  const servers = Array.isArray(operation.servers) ? operation.servers : doc.servers;
  if (!Array.isArray(servers) || servers.length === 0) return '';

  let selected: any;
  if (serverSelector !== undefined) {
    if (typeof serverSelector === 'number') {
      selected = servers[serverSelector];
    } else {
      selected = servers.find((server: any) => server?.url === serverSelector);
    }
    if (!selected) {
      throw new OpenApiSkip(`configured OpenAPI server '${serverSelector}' was not found`);
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

export function mergeCookieHeader(headers: Record<string, string>, cookies: Record<string, string>): void {
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

/**
 * Applies `cfg.openapiAuth` hooks for the operation's (or document's) security
 * requirements. Throws OpenApiSkip when a required scheme has no hook.
 */
export async function applySecurity(
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

export function appendQuery(endpoint: string, query: URLSearchParams): string {
  const queryString = query.toString();
  if (!queryString) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryString}`;
}
