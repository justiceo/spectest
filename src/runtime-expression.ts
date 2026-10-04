// Runtime expressions as defined by OpenAPI links and the Arazzo specification
// (1.0.x and 1.1.x ABNF), plus Spectest's own `$generated.<key>` / `$state.<key>`
// extensions. Parsing is shared by the OpenAPI loader (links) and the Arazzo
// loader; evaluation of the HTTP-exchange parts ($url, $method, $statusCode,
// $request.*, $response.*) lives here too, while workflow-scoped roots
// ($inputs, $steps, $workflows, ...) are evaluated by the Arazzo runtime.
import { decodePointerPart } from './openapi/document.js';

export type RuntimeExpression =
  | { root: 'url' | 'method' | 'statusCode' | 'self'; path: string[]; raw: string }
  | {
      root: 'request' | 'response' | 'message';
      part: 'header' | 'query' | 'path' | 'body' | 'payload';
      name?: string;
      pointer?: string;
      path: string[];
      raw: string;
    }
  | { root: 'inputs' | 'outputs'; name: string; pointer?: string; raw: string }
  | { root: 'steps'; stepId: string; name: string; pointer?: string; raw: string }
  | { root: 'workflows'; workflowId: string; field: 'inputs' | 'outputs' | 'steps'; name: string; pointer?: string; raw: string }
  | { root: 'sourceDescriptions'; sourceName: string; reference: string; raw: string }
  | { root: 'components'; componentType: string; name: string; raw: string }
  | { root: 'generated' | 'state'; name: string; raw: string };

export class RuntimeExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeExpressionError';
  }
}

const KNOWN_ROOTS = [
  'url',
  'method',
  'statusCode',
  'self',
  'request',
  'response',
  'message',
  'inputs',
  'outputs',
  'steps',
  'workflows',
  'sourceDescriptions',
  'components',
  'generated',
  'state',
];

/** True when `value` looks like it is meant to be a runtime expression (starts with a known `$root`). */
export function looksLikeRuntimeExpression(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('$')) return false;
  const match = /^\$([A-Za-z]+)/.exec(value);
  return Boolean(match && KNOWN_ROOTS.includes(match[1]));
}

function splitPointer(rest: string): { name: string; pointer?: string } {
  const hash = rest.indexOf('#');
  if (hash === -1) return { name: rest };
  return { name: rest.slice(0, hash), pointer: rest.slice(hash + 1) };
}

function splitDotPath(rest: string): string[] {
  return rest ? rest.split('.').filter((p) => p.length > 0) : [];
}

export function parseRuntimeExpression(raw: string): RuntimeExpression {
  const expression = raw.trim();
  if (!expression.startsWith('$')) {
    throw new RuntimeExpressionError(`runtime expression '${raw}' must start with '$'`);
  }

  const simple = /^\$(url|method|statusCode|self)(?:\.(.*))?$/.exec(expression);
  if (simple) {
    return { root: simple[1] as 'url', path: splitDotPath(simple[2] || ''), raw: expression };
  }

  const http = /^\$(request|response|message)\.(.*)$/.exec(expression);
  if (http) {
    const root = http[1] as 'request' | 'response' | 'message';
    const rest = http[2];
    const named = /^(header|query|path)\.(.+)$/.exec(rest);
    if (named) {
      return { root, part: named[1] as 'header', name: named[2], path: [], raw: expression };
    }
    const body = /^(body|payload)(#.*|\..*)?$/.exec(rest);
    if (body) {
      const suffix = body[2] || '';
      if (suffix.startsWith('#')) {
        return { root, part: body[1] as 'body', pointer: suffix.slice(1), path: [], raw: expression };
      }
      return { root, part: body[1] as 'body', path: splitDotPath(suffix.slice(1)), raw: expression };
    }
    throw new RuntimeExpressionError(
      `unsupported runtime expression '${raw}': expected $${root}.header.<name>, .query.<name>, .path.<name> or .body[#pointer]`
    );
  }

  const io = /^\$(inputs|outputs)\.(.+)$/.exec(expression);
  if (io) {
    const { name, pointer } = splitPointer(io[2]);
    if (!name) throw new RuntimeExpressionError(`runtime expression '${raw}' is missing a name`);
    return { root: io[1] as 'inputs', name, pointer, raw: expression };
  }

  if (expression.startsWith('$steps.')) {
    const rest = expression.slice('$steps.'.length);
    const marker = rest.indexOf('.outputs.');
    if (marker <= 0) {
      throw new RuntimeExpressionError(`unsupported runtime expression '${raw}': expected $steps.<stepId>.outputs.<name>`);
    }
    const { name, pointer } = splitPointer(rest.slice(marker + '.outputs.'.length));
    if (!name) throw new RuntimeExpressionError(`runtime expression '${raw}' is missing an output name`);
    return { root: 'steps', stepId: rest.slice(0, marker), name, pointer, raw: expression };
  }

  if (expression.startsWith('$workflows.')) {
    const rest = expression.slice('$workflows.'.length);
    const match = /^(.+?)\.(inputs|outputs|steps)\.(.+)$/.exec(rest);
    if (!match) {
      throw new RuntimeExpressionError(
        `unsupported runtime expression '${raw}': expected $workflows.<workflowId>.inputs|outputs.<name>`
      );
    }
    const { name, pointer } = splitPointer(match[3]);
    return { root: 'workflows', workflowId: match[1], field: match[2] as 'inputs', name, pointer, raw: expression };
  }

  if (expression.startsWith('$sourceDescriptions.')) {
    const rest = expression.slice('$sourceDescriptions.'.length);
    const dot = rest.indexOf('.');
    if (dot <= 0 || dot === rest.length - 1) {
      throw new RuntimeExpressionError(`unsupported runtime expression '${raw}': expected $sourceDescriptions.<name>.<reference>`);
    }
    return { root: 'sourceDescriptions', sourceName: rest.slice(0, dot), reference: rest.slice(dot + 1), raw: expression };
  }

  if (expression.startsWith('$components.')) {
    const rest = expression.slice('$components.'.length);
    const dot = rest.indexOf('.');
    if (dot <= 0 || dot === rest.length - 1) {
      throw new RuntimeExpressionError(`unsupported runtime expression '${raw}': expected $components.<type>.<name>`);
    }
    return { root: 'components', componentType: rest.slice(0, dot), name: rest.slice(dot + 1), raw: expression };
  }

  const ext = /^\$(generated|state)\.(.+)$/.exec(expression);
  if (ext) {
    return { root: ext[1] as 'generated', name: ext[2], raw: expression };
  }

  throw new RuntimeExpressionError(`unsupported runtime expression '${raw}'`);
}

export type TemplateSegment = { kind: 'literal'; text: string } | { kind: 'expression'; source: string; expression: RuntimeExpression };

/**
 * Splits a string with embedded `{$expression}` segments. Returns null when the
 * string has no embedded expressions. Throws on an embedded segment that does
 * not parse as a runtime expression.
 */
export function parseTemplate(value: string): TemplateSegment[] | null {
  if (!value.includes('{$')) return null;
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{$', cursor);
    if (open === -1) {
      segments.push({ kind: 'literal', text: value.slice(cursor) });
      break;
    }
    const close = value.indexOf('}', open);
    if (close === -1) {
      segments.push({ kind: 'literal', text: value.slice(cursor) });
      break;
    }
    if (open > cursor) segments.push({ kind: 'literal', text: value.slice(cursor, open) });
    const source = value.slice(open + 1, close);
    segments.push({ kind: 'expression', source, expression: parseRuntimeExpression(source) });
    cursor = close + 1;
  }
  return segments.some((s) => s.kind === 'expression') ? segments : null;
}

/** String form of a value embedded in a template, per Arazzo 1.1 §Runtime Expressions. */
export function embedValue(value: unknown): string {
  if (value === undefined || value === null) return value === null ? 'null' : '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

export function renderTemplate(segments: TemplateSegment[], evaluate: (expression: RuntimeExpression) => unknown): string {
  return segments.map((segment) => (segment.kind === 'literal' ? segment.text : embedValue(evaluate(segment.expression)))).join('');
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[[{"]|^-?\d|^(true|false|null)$/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Applies an RFC 6901 pointer (as written after `#` in an expression). A JSON string is parsed first. */
export function applyPointer(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === '' || pointer === '/') return value;
  let current: any = maybeParseJson(value);
  const parts = pointer.replace(/^\//, '').split('/').map(decodePointerPart);
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Applies a `.a.b` property-dereference path (simple-condition syntax). */
export function applyPath(value: unknown, path: string[]): unknown {
  let current: any = path.length ? maybeParseJson(value) : value;
  for (const part of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** A completed (or in-flight) HTTP request/response pair the exchange roots read from. */
export interface HttpExchange {
  url?: string;
  method?: string;
  request?: {
    headers?: any;
    query?: URLSearchParams;
    path?: Record<string, unknown>;
    body?: unknown;
  };
  response?: {
    status?: number;
    headers?: any;
    body?: unknown;
  };
}

function headerLookup(headers: any, name: string): unknown {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry ? entry[1] : undefined;
}

export function isExchangeExpression(expression: RuntimeExpression): boolean {
  return (
    expression.root === 'url' ||
    expression.root === 'method' ||
    expression.root === 'statusCode' ||
    expression.root === 'request' ||
    expression.root === 'response'
  );
}

/** Evaluates `$url`, `$method`, `$statusCode`, `$request.*` and `$response.*` against an exchange. */
export function evaluateExchangeExpression(expression: RuntimeExpression, exchange: HttpExchange | undefined): unknown {
  switch (expression.root) {
    case 'url':
      return applyPath(exchange?.url, expression.path);
    case 'method':
      return applyPath(exchange?.method, expression.path);
    case 'statusCode':
      return applyPath(exchange?.response?.status, expression.path);
    case 'request':
    case 'response': {
      const side: any = expression.root === 'request' ? exchange?.request : exchange?.response;
      if (expression.part === 'header') return headerLookup(side?.headers, expression.name!);
      if (expression.part === 'query') {
        const query: URLSearchParams | undefined = side?.query;
        if (!query) return undefined;
        const all = query.getAll(expression.name!);
        return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
      }
      if (expression.part === 'path') return side?.path?.[expression.name!];
      if (expression.part === 'body') {
        return applyPath(applyPointer(side?.body, expression.pointer), expression.path);
      }
      throw new RuntimeExpressionError(`'${expression.raw}' is not available for HTTP steps`);
    }
    default:
      throw new RuntimeExpressionError(`'${expression.raw}' is not an HTTP exchange expression`);
  }
}

/** Normalizes a header container (Headers or plain object) into a plain lowercase-keyed object. */
export function headersToObject(headers: any): Record<string, string> {
  if (!headers) return {};
  if (typeof headers.entries === 'function' && typeof headers.get === 'function') {
    return Object.fromEntries(headers.entries());
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value as string;
  }
  return result;
}

/**
 * Builds an exchange from a completed TestResult. The runner stores the
 * outbound request config as `.request` (`url`, `method`, `headers`, `data`,
 * plus optional `spectestMeta.pathParams`) and the parsed response as `.response`.
 */
export function exchangeFromResult(result: any, baseUrl?: string): HttpExchange {
  const request = result?.request || {};
  const rawUrl = typeof request.url === 'string' ? request.url : undefined;
  let url = rawUrl;
  let query: URLSearchParams | undefined;
  if (rawUrl !== undefined) {
    try {
      const parsed = new URL(rawUrl, baseUrl || 'http://spectest.invalid');
      query = parsed.searchParams;
      url = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) || baseUrl ? parsed.toString() : rawUrl;
    } catch {
      query = undefined;
    }
  }
  return {
    url,
    method: request.method,
    request: {
      headers: request.headers,
      query,
      path: request.spectestMeta?.pathParams,
      body: request.data,
    },
    response: result?.response
      ? { status: result.response.status, headers: result.response.headers, body: result.response.data }
      : undefined,
  };
}
