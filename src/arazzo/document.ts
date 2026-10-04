// Loading Arazzo documents and the source descriptions they reference.
//
// A document that isn't Arazzo at all (not an object, no `arazzo` version, no
// workflows) throws, like the OpenAPI loader does for non-OpenAPI input. Every
// other problem — schema violations, unreachable or unsupported sources — is
// recorded (as a warning, or as an error on the source) so the compiler can
// degrade the affected workflows to skipped tests instead of crashing.
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { load as parseYaml } from 'js-yaml';
import { HTTP_METHODS, assertOpenApiDocument } from '../openapi/document.js';
import type { ArazzoSourceOverride, SpectestConfig } from '../types.js';
import { arazzoSchema10, arazzoSchema11 } from './schemas.js';

export interface OpenApiOperationEntry {
  method: string;
  pathKey: string;
  operation: any;
  pathItem: any;
  operationId?: string;
}

export interface OpenApiSource {
  doc: any;
  location: string;
  operations: OpenApiOperationEntry[];
  byOperationId: Map<string, OpenApiOperationEntry>;
}

export interface SourceRef {
  name: string;
  type: string;
  url: string;
  location: string;
  override?: ArazzoSourceOverride;
  openapi?: OpenApiSource;
  arazzo?: ArazzoDocument;
  error?: string;
  raw: any;
}

export interface ArazzoDocument {
  location: string;
  doc: any;
  version: '1.0' | '1.1';
  title: string;
  self?: string;
  warnings: string[];
  sources: Map<string, SourceRef>;
  workflows: Map<string, any>;
  components: any;
}

export type DocumentCache = Map<string, Promise<ArazzoDocument>>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {
  '1.0': ajv.compile(arazzoSchema10),
  '1.1': ajv.compile(arazzoSchema11),
};

export function isRemote(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/** github.com "blob" page URLs serve HTML; rewrite them to the raw file. */
export function rawGithubUrl(url: string): string {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(url);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : url;
}

export function resolveLocation(reference: string, base: string): string {
  if (isRemote(reference)) return rawGithubUrl(reference);
  if (reference.startsWith('file://')) return fileURLToPath(reference);
  if (isRemote(base)) return rawGithubUrl(new URL(reference, base).toString());
  if (path.isAbsolute(reference)) return reference;
  return path.resolve(path.dirname(base), reference);
}

async function readLocation(location: string, timeoutMs = 30000): Promise<string> {
  if (!isRemote(location)) {
    return readFile(location, 'utf8');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(location, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GET ${location} returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseText(raw: string, location: string): any {
  if (/\.json(\?|#|$)/i.test(location)) {
    return JSON.parse(raw);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    try {
      return JSON.parse(raw);
    } catch {
      throw error;
    }
  }
}

function formatSchemaErrors(errors: any[] | null | undefined): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const error of errors || []) {
    // `oneOf`/`if` branches produce noisy duplicates; keep the leaf messages.
    if (error.keyword === 'if' || error.keyword === 'oneOf' || error.keyword === 'anyOf') continue;
    const where = error.instancePath || '/';
    const detail =
      error.keyword === 'unevaluatedProperties' && error.params?.unevaluatedProperty
        ? `${error.message} '${error.params.unevaluatedProperty}'`
        : error.message;
    const message = `${where} ${detail}`;
    if (!seen.has(message)) {
      seen.add(message);
      messages.push(message);
    }
  }
  return messages;
}

export function detectVersion(doc: any): { version: '1.0' | '1.1'; warning?: string } {
  const declared = String(doc.arazzo ?? '');
  if (/^1\.0\.\d+/.test(declared)) return { version: '1.0' };
  if (/^1\.1\.\d+/.test(declared)) return { version: '1.1' };
  return { version: '1.1', warning: `unsupported Arazzo version '${declared}'; interpreting it as 1.1` };
}

/** Validates a parsed document against the official schema for its version. */
export function validateArazzoDocument(doc: any): { version: '1.0' | '1.1'; errors: string[]; warnings: string[] } {
  const { version, warning } = detectVersion(doc);
  const validate = validators[version];
  const ok = validate(doc);
  return { version, errors: ok ? [] : formatSchemaErrors(validate.errors), warnings: warning ? [warning] : [] };
}

export function assertArazzoShape(doc: any, location: string): void {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Arazzo document ${location} must be an object`);
  }
  if (typeof doc.arazzo !== 'string') {
    throw new Error(`Arazzo document ${location} must declare an 'arazzo' version`);
  }
  if (!Array.isArray(doc.workflows) || doc.workflows.length === 0) {
    throw new Error(`Arazzo document ${location} must include at least one workflow`);
  }
}

function indexOpenApi(doc: any, location: string): OpenApiSource {
  const operations: OpenApiOperationEntry[] = [];
  const byOperationId = new Map<string, OpenApiOperationEntry>();
  for (const [pathKey, pathItem] of Object.entries<any>(doc.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries<any>(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      const entry: OpenApiOperationEntry = { method, pathKey, operation, pathItem, operationId: operation.operationId };
      operations.push(entry);
      if (typeof operation.operationId === 'string') byOperationId.set(operation.operationId, entry);
    }
  }
  return { doc, location, operations, byOperationId };
}

function sourceOverride(cfg: SpectestConfig, name: string): ArazzoSourceOverride | undefined {
  const raw = cfg.arazzoSources?.[name];
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? { url: raw } : raw;
}

function resolveOverrideLocation(reference: string, cfg: SpectestConfig): string {
  if (isRemote(reference) || path.isAbsolute(reference)) return rawGithubUrl(reference);
  return path.resolve(cfg.projectRoot || process.cwd(), reference);
}

async function loadSource(raw: any, owner: ArazzoDocument, cfg: SpectestConfig, cache: DocumentCache): Promise<SourceRef> {
  const name = String(raw?.name ?? '');
  const url = String(raw?.url ?? '');
  const override = sourceOverride(cfg, name);
  const base = owner.self && isRemote(owner.self) ? owner.self : owner.location;
  const location = override?.url ? resolveOverrideLocation(override.url, cfg) : url ? resolveLocation(url, base) : '';
  const ref: SourceRef = { name, type: String(raw?.type ?? ''), url, location, override, raw };
  if (!location) {
    ref.error = `source description '${name}' has no url`;
    return ref;
  }
  if (ref.type === 'asyncapi') {
    ref.error = `source description '${name}' is AsyncAPI, which Spectest does not support (HTTP/OpenAPI only)`;
    return ref;
  }
  try {
    if (ref.type === 'arazzo') {
      ref.arazzo = await loadArazzoDocument(location, cfg, cache);
      return ref;
    }
    const text = await readLocation(location);
    const parsed = parseText(text, location);
    if (!ref.type) {
      ref.type = parsed?.arazzo ? 'arazzo' : parsed?.asyncapi ? 'asyncapi' : 'openapi';
      if (ref.type === 'arazzo') {
        ref.arazzo = await loadArazzoDocument(location, cfg, cache);
        return ref;
      }
      if (ref.type === 'asyncapi') {
        ref.error = `source description '${name}' is AsyncAPI, which Spectest does not support (HTTP/OpenAPI only)`;
        return ref;
      }
    }
    assertOpenApiDocument(parsed);
    ref.openapi = indexOpenApi(parsed, location);
  } catch (error) {
    ref.error = `could not load source description '${name}' from ${location}: ${(error as Error)?.message || error}`;
  }
  return ref;
}

/**
 * Loads an Arazzo document plus (recursively) every source description it
 * references. `cache` de-duplicates documents across a run and makes cyclic
 * `type: arazzo` references safe.
 */
export function loadArazzoDocument(location: string, cfg: SpectestConfig = {}, cache: DocumentCache = new Map()): Promise<ArazzoDocument> {
  const key = isRemote(location) ? location : path.resolve(location);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const text = await readLocation(key);
    const doc = parseText(text, key);
    return buildArazzoDocument(doc, key, cfg, cache);
  })();
  cache.set(key, promise);
  return promise;
}

/** Builds a document from an already-parsed object (used by loadArazzoDocument and tests). */
export async function buildArazzoDocument(
  doc: any,
  location: string,
  cfg: SpectestConfig = {},
  cache: DocumentCache = new Map()
): Promise<ArazzoDocument> {
  assertArazzoShape(doc, location);
  const { version, errors, warnings } = validateArazzoDocument(doc);
  if (errors.length > 0) {
    const message = `${location} does not conform to the Arazzo ${version} schema:\n  - ${errors.join('\n  - ')}`;
    if (cfg.arazzoStrict) throw new Error(message);
    warnings.push(...errors.map((e) => `schema: ${e}`));
  }
  const result: ArazzoDocument = {
    location,
    doc,
    version,
    title: String(doc.info?.title || path.basename(location)),
    self: typeof doc.$self === 'string' ? doc.$self : undefined,
    warnings,
    sources: new Map(),
    workflows: new Map(),
    components: doc.components && typeof doc.components === 'object' ? doc.components : {},
  };
  for (const workflow of doc.workflows) {
    if (workflow && typeof workflow.workflowId === 'string') {
      if (result.workflows.has(workflow.workflowId)) {
        warnings.push(`duplicate workflowId '${workflow.workflowId}'; the first definition wins`);
        continue;
      }
      result.workflows.set(workflow.workflowId, workflow);
    } else {
      warnings.push('a workflow without a workflowId was ignored');
    }
  }
  // Register the (still source-less) document before loading sources, so a
  // cyclic `type: arazzo` reference resolves to it instead of awaiting itself.
  const key = isRemote(location) ? location : path.resolve(location);
  cache.set(key, Promise.resolve(result));
  const rawSources = Array.isArray(doc.sourceDescriptions) ? doc.sourceDescriptions : [];
  const loaded = await Promise.all(rawSources.map((raw: any) => loadSource(raw, result, cfg, cache)));
  for (const source of loaded) {
    if (result.sources.has(source.name)) {
      warnings.push(`duplicate sourceDescription name '${source.name}'; the first definition wins`);
      continue;
    }
    result.sources.set(source.name, source);
  }
  return result;
}

export function locationToUrl(location: string): string {
  return isRemote(location) ? location : pathToFileURL(location).toString();
}
