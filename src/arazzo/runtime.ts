// Run-time half of the Arazzo integration. compile.ts turns workflows into a
// linear chain of TestCases per top-level workflow; the hooks on those
// TestCases (when / beforeSend / assert) call into this module, which keeps
// per-scope flow state in the run's shared state object:
//
//   state.__arazzo[scopeId]          FlowState (cursor, inputs, retry counters, ...)
//   state.__arazzoOutputs[nodeId]    outputs evaluated when a step's node completed
//   state.__arazzoWorkflowOutputs[scopeId]  outputs of a completed (sub-)workflow
//
// A *scope* is one execution of a workflow: a top-level workflow, a workflow
// invoked by a step, or a workflow reached through a goto/retry action. Each
// scope walks its steps with a cursor; nodes whose step the cursor isn't on
// skip themselves (a pass-through skip, so the chain keeps moving).
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { setTimeout as sleep } from 'timers/promises';
import { normalizeOpenApiSchema, validateAgainstSchema } from '../openapi-schema-validate.js';
import { mergeCookieHeader, resolveGeneratorPlaceholders, valueToString } from '../openapi/document.js';
import {
  applyPath,
  applyPointer,
  embedValue,
  evaluateExchangeExpression,
  exchangeFromResult,
  isExchangeExpression,
  looksLikeRuntimeExpression,
  parseRuntimeExpression,
  parseTemplate,
  renderTemplate,
  type HttpExchange,
  type RuntimeExpression,
} from '../runtime-expression.js';
import type { AssertOutcome, SpectestConfig, TestResponse, WhenOutcome } from '../types.js';
import { evaluateCriteria, type ExpressionResolver } from './criteria.js';
import type { ArazzoDocument } from './document.js';
import type { ActionDef, ParamDef, SpectestExtension, StepDef, WorkflowDef } from './model.js';
import { unwrapBraces } from './model.js';
import { isJsonMediaType, isXmlMediaType, replaceJsonPath, replaceJsonPointer, replaceXPath, selectValue } from './selectors.js';

export type Anchor = { kind: 'step'; round: number; index: number } | { kind: 'block'; round: number; key: string };

export type InputsBinding =
  | { kind: 'static'; values: Record<string, unknown> }
  | { kind: 'params'; params: ParamDef[]; schema?: any; trigger: 'parent' | 'block' };

export interface Block {
  key: string;
  round: number;
  action: ActionDef;
  scope: Scope;
  joinId: string;
}

export interface Scope {
  id: string;
  label: string;
  program: Program;
  workflow: WorkflowDef;
  parent?: { scope: Scope; anchor: Anchor };
  rounds: number;
  phase: 'setup' | 'main' | 'teardown';
  group: string;
  entryWorkflowId: string;
  inputs: InputsBinding;
  /** `${round}:${stepIndex}` → id of the node recording that step's outcome. */
  nodes: Map<string, string>;
  childScopes: Map<string, Scope>;
  blocks: Map<string, Block>;
  /** Unique goto/retry actions of this workflow that target another workflow. */
  blockActions: ActionDef[];
  deferFailures: boolean;
  depth: number;
  x: SpectestExtension;
}

export interface Program {
  file: string;
  cfg: SpectestConfig;
  doc: ArazzoDocument;
  scopes: Map<string, Scope>;
  /** `${doc.location}#${workflowId}` → top-level scope. */
  topScopes: Map<string, Scope>;
  warnings: string[];
}

export interface FlowState {
  cursor: { round: number; index: number } | { round: number; block: string } | null;
  ended: boolean;
  outcome?: 'completed' | 'failed';
  failure?: string;
  returnTo?: number;
  retryCounts: Record<string, number>;
  inputs?: Record<string, unknown>;
  inputsError?: string;
  lastExchange?: string;
  lastTransition?: string;
  trigger?: string;
  pendingDelayMs?: number;
}

interface StoredOutputs {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

export class ArazzoRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArazzoRuntimeError';
  }
}

// ---------------------------------------------------------------------------
// State helpers

function flowStates(state: any): Record<string, FlowState> {
  state.__arazzo ??= {};
  return state.__arazzo;
}

export function getFlow(scope: Scope, state: any): FlowState | undefined {
  return state?.__arazzo?.[scope.id];
}

function storedOutputs(state: any): Record<string, StoredOutputs> {
  state.__arazzoOutputs ??= {};
  return state.__arazzoOutputs;
}

function storedWorkflowOutputs(state: any): Record<string, StoredOutputs> {
  state.__arazzoWorkflowOutputs ??= {};
  return state.__arazzoWorkflowOutputs;
}

export function nodeKey(round: number, index: number): string {
  return `${round}:${index}`;
}

export function topScopeKey(doc: ArazzoDocument, workflowId: string): string {
  return `${doc.location}#${workflowId}`;
}

// ---------------------------------------------------------------------------
// Inputs

const inputsAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(inputsAjv);
for (const format of ['int32', 'int64', 'float', 'double', 'password', 'byte', 'binary']) {
  inputsAjv.addFormat(format, true);
}

export function validateInputs(values: Record<string, unknown>, schema: any): string[] {
  if (!schema || typeof schema !== 'object') return [];
  try {
    const validate = inputsAjv.compile(normalizeOpenApiSchema(schema));
    if (validate(values)) return [];
    return (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`);
  } catch (error) {
    return [`invalid inputs schema: ${(error as Error).message}`];
  }
}

/** `default` values declared on the inputs schema's top-level properties. */
export function schemaDefaults(schema: any): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const properties = schema && typeof schema === 'object' ? schema.properties : undefined;
  if (!properties || typeof properties !== 'object') return defaults;
  for (const [name, property] of Object.entries<any>(properties)) {
    if (property && typeof property === 'object' && 'default' in property) defaults[name] = property.default;
  }
  return defaults;
}

function scopeInputs(scope: Scope, state: any): Record<string, unknown> {
  if (scope.inputs.kind === 'static') return scope.inputs.values;
  return getFlow(scope, state)?.inputs || {};
}

/** Looks up `name` as a key first, then as a dotted path (Arazzo 1.1 allows dots in names). */
function lookupNamed(container: Record<string, unknown> | undefined, name: string): { found: boolean; value: unknown } {
  if (!container) return { found: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(container, name)) return { found: true, value: container[name] };
  const parts = name.split('.');
  for (let split = parts.length - 1; split >= 1; split -= 1) {
    const head = parts.slice(0, split).join('.');
    if (Object.prototype.hasOwnProperty.call(container, head)) {
      return { found: true, value: applyPath(container[head], parts.slice(split)) };
    }
  }
  return { found: false, value: undefined };
}

// ---------------------------------------------------------------------------
// Expression evaluation

export interface EvalContext {
  scope: Scope;
  state: any;
  exchange?: HttpExchange;
  /** Resolves `$outputs.<name>` (a workflow step's child outputs, or the workflow's own outputs). */
  outputs?: (name: string) => unknown;
}

function stepIndex(scope: Scope, stepId: string): number {
  const index = scope.workflow.steps.findIndex((s) => s.stepId === stepId);
  if (index === -1) throw new ArazzoRuntimeError(`unknown step '${stepId}' in workflow '${scope.workflow.workflowId}'`);
  return index;
}

/** Outputs of the most recent execution of a step in this scope (undefined if it hasn't run). */
function latestStepOutputs(scope: Scope, index: number, state: any): StoredOutputs | undefined {
  const all = state?.__arazzoOutputs || {};
  for (let round = scope.rounds; round >= 1; round -= 1) {
    const nodeId = scope.nodes.get(nodeKey(round, index));
    if (nodeId && all[nodeId]) return all[nodeId];
  }
  return undefined;
}

function readOutput(stored: StoredOutputs | undefined, name: string, owner: string): unknown {
  if (!stored) return undefined;
  const direct = lookupNamed(stored.values, name);
  if (direct.found) return direct.value;
  const head = Object.keys(stored.errors).find((key) => name === key || name.startsWith(`${key}.`));
  if (head) throw new ArazzoRuntimeError(`output '${head}' of ${owner} could not be evaluated: ${stored.errors[head]}`);
  throw new ArazzoRuntimeError(`${owner} has no output '${name}'`);
}

function topScopeFor(program: Program, scope: Scope, workflowId: string): Scope {
  const found = program.topScopes.get(topScopeKey(scope.workflow.doc, workflowId));
  if (!found) throw new ArazzoRuntimeError(`unknown workflow '${workflowId}'`);
  return found;
}

export function evaluateExpression(expression: RuntimeExpression, ctx: EvalContext): unknown {
  const { scope, state } = ctx;
  if (isExchangeExpression(expression)) {
    if (!ctx.exchange) throw new ArazzoRuntimeError(`'${expression.raw}' is not available here (no HTTP exchange)`);
    return evaluateExchangeExpression(expression, ctx.exchange);
  }
  switch (expression.root) {
    case 'inputs':
      return applyPointer(lookupNamed(scopeInputs(scope, state), expression.name).value, expression.pointer);
    case 'outputs': {
      const value = ctx.outputs ? ctx.outputs(expression.name) : readWorkflowOutputs(scope, state, expression.name);
      return applyPointer(value, expression.pointer);
    }
    case 'steps': {
      const index = stepIndex(scope, expression.stepId);
      const stored = latestStepOutputs(scope, index, state);
      return applyPointer(readOutput(stored, expression.name, `step '${expression.stepId}'`), expression.pointer);
    }
    case 'workflows': {
      const target = topScopeFor(scope.program, scope, expression.workflowId);
      if (expression.field === 'inputs') {
        return applyPointer(lookupNamed(scopeInputs(target, state), expression.name).value, expression.pointer);
      }
      if (expression.field === 'outputs') {
        // After a goto/retry into workflow X, its outputs come from that execution.
        const viaBlock = latestBlockScope(scope, expression.workflowId, state);
        return applyPointer(readWorkflowOutputs(viaBlock || target, state, expression.name), expression.pointer);
      }
      throw new ArazzoRuntimeError(`'${expression.raw}' can only be used in dependsOn`);
    }
    case 'sourceDescriptions': {
      const source = scope.workflow.doc.sources.get(expression.sourceName);
      if (!source) throw new ArazzoRuntimeError(`unknown source description '${expression.sourceName}'`);
      const operation = source.openapi?.byOperationId.get(expression.reference);
      if (operation) return operation.operationId;
      if (source.arazzo?.workflows.has(expression.reference)) return expression.reference;
      return source.raw?.[expression.reference];
    }
    case 'components': {
      const value = scope.workflow.doc.components?.[expression.componentType]?.[expression.name];
      if (value === undefined) throw new ArazzoRuntimeError(`'${expression.raw}' is not defined`);
      return value;
    }
    case 'self':
      return applyPath(scope.workflow.doc.self ?? scope.workflow.doc.location, expression.path);
    case 'state':
      return state?.[expression.name];
    case 'message':
      throw new ArazzoRuntimeError(`'${expression.raw}' refers to an AsyncAPI message, which Spectest does not support`);
    default:
      throw new ArazzoRuntimeError(`'${expression.raw}' is not supported in Arazzo documents`);
  }
}

/** The most recent completed goto/retry execution of `workflowId` reachable from this scope or its ancestors. */
function latestBlockScope(scope: Scope, workflowId: string, state: any): Scope | undefined {
  const outputs = state?.__arazzoWorkflowOutputs || {};
  for (let current: Scope | undefined = scope; current; current = current.parent?.scope) {
    for (let round = current.rounds; round >= 1; round -= 1) {
      for (const action of current.blockActions) {
        if (action.workflow?.workflowId !== workflowId || action.workflow.doc !== scope.workflow.doc) continue;
        const block = current.blocks.get(`${round}:${action.key}`);
        if (block && outputs[block.scope.id]) return block.scope;
      }
    }
  }
  return undefined;
}

function readWorkflowOutputs(scope: Scope, state: any, name: string): unknown {
  const stored = state?.__arazzoWorkflowOutputs?.[scope.id];
  if (!stored) return undefined;
  return readOutput(stored, name, `workflow '${scope.workflow.workflowId}'`);
}

export function makeResolver(ctx: EvalContext): ExpressionResolver {
  const evaluate = (expression: RuntimeExpression) => evaluateExpression(expression, ctx);
  return {
    evaluate,
    interpolate: (template: string) => {
      const segments = parseTemplate(template);
      return segments ? renderTemplate(segments, evaluate) : template;
    },
  };
}

function isSelectorObject(value: any): boolean {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.context === 'string' &&
    typeof value.selector === 'string' &&
    (typeof value.type === 'string' || (value.type && typeof value.type === 'object'))
  );
}

async function evaluateSelector(value: any, ctx: EvalContext): Promise<unknown> {
  const context = evaluateExpression(parseRuntimeExpression(unwrapBraces(value.context)), ctx);
  const type = typeof value.type === 'string' ? value.type : String(value.type.type);
  const version = typeof value.type === 'object' && value.type.version !== undefined ? String(value.type.version) : undefined;
  return selectValue(context, value.selector, type, version);
}

/**
 * Resolves an Arazzo value: a whole runtime expression (type-preserving), a
 * string with embedded `{$expr}` segments, a Selector Object, or a literal
 * (with Spectest's `{{uuid}}`-style generator placeholders re-rolled).
 */
export async function resolveValue(value: unknown, ctx: EvalContext): Promise<unknown> {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (looksLikeRuntimeExpression(trimmed)) return evaluateExpression(parseRuntimeExpression(trimmed), ctx);
    const segments = parseTemplate(value);
    if (segments) return renderTemplate(segments, (e) => evaluateExpression(e, ctx));
    return resolveGeneratorPlaceholders(value);
  }
  if (isSelectorObject(value)) return evaluateSelector(value, ctx);
  return value;
}

/** Deep-resolves a payload object/array; every string and selector inside is resolved. */
export async function resolveDeep(value: unknown, ctx: EvalContext): Promise<unknown> {
  if (typeof value === 'string' || isSelectorObject(value)) return resolveValue(value, ctx);
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveDeep(item, ctx)));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const resolved = await resolveDeep(nested, ctx);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  return value;
}

/**
 * Renders a JSON text template. A JSON string literal consisting of exactly one
 * embedded expression (`"{$inputs.customer}"`) is replaced by the value's JSON
 * (type-preserving); other embedded expressions inside strings are escaped into
 * the string, and ones outside strings are inserted as JSON.
 */
export function renderJsonTemplate(template: string, evaluate: (source: string) => unknown): string {
  let out = '';
  let inString = false;
  let stringStart = -1;
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '$') {
      const close = template.indexOf('}', i);
      if (close !== -1) {
        const value = evaluate(template.slice(i + 1, close));
        if (inString && stringStart === out.length - 1 && template[close + 1] === '"') {
          out = out.slice(0, -1) + JSON.stringify(value === undefined ? null : value);
          inString = false;
          i = close + 2;
          continue;
        }
        out += inString ? JSON.stringify(embedValue(value)).slice(1, -1) : JSON.stringify(value === undefined ? null : value);
        i = close + 1;
        continue;
      }
    }
    if (inString && ch === '\\') {
      out += ch + (template[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (!inString) stringStart = out.length;
      inString = !inString;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function renderStringPayload(payload: string, contentType: string | undefined, ctx: EvalContext): unknown {
  const evaluateSource = (source: string) => evaluateExpression(parseRuntimeExpression(source), ctx);
  if (isJsonMediaType(contentType)) {
    const rendered = renderJsonTemplate(payload, evaluateSource);
    try {
      return JSON.parse(rendered);
    } catch {
      return rendered;
    }
  }
  const segments = parseTemplate(payload);
  if (!segments) return resolveGeneratorPlaceholders(payload);
  if (isXmlMediaType(contentType)) {
    return renderTemplate(segments, (e) => {
      const value = evaluateExpression(e, ctx);
      return typeof value === 'string' ? xmlEscape(value) : value;
    });
  }
  if (contentType && /x-www-form-urlencoded/i.test(contentType)) {
    return renderTemplate(segments, (e) => encodeURIComponent(embedValue(evaluateExpression(e, ctx))));
  }
  return renderTemplate(segments, (e) => evaluateExpression(e, ctx));
}

// ---------------------------------------------------------------------------
// Request building

function operationContentType(step: StepDef): string | undefined {
  const content = step.operation?.operation?.requestBody?.content;
  if (!content || typeof content !== 'object') return undefined;
  const types = Object.keys(content);
  return types.find((t) => isJsonMediaType(t)) || types[0];
}

function toFormValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : embedValue(value);
}

export async function buildRequestBody(step: StepDef, ctx: EvalContext): Promise<{ body: unknown; contentType?: string } | undefined> {
  const requestBody = step.requestBody;
  if (!requestBody || typeof requestBody !== 'object') return undefined;
  const payload = requestBody.payload;
  let contentType: string | undefined = typeof requestBody.contentType === 'string' ? requestBody.contentType : operationContentType(step);
  let body: unknown;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    body = looksLikeRuntimeExpression(trimmed) ? evaluateExpression(parseRuntimeExpression(trimmed), ctx) : renderStringPayload(payload, contentType, ctx);
  } else if (payload !== undefined) {
    body = await resolveDeep(payload, ctx);
  }
  if (!contentType && body !== undefined) {
    contentType = typeof body === 'object' ? 'application/json' : typeof body === 'string' && body.trim().startsWith('<') ? 'application/xml' : 'text/plain';
  }

  for (const replacement of Array.isArray(requestBody.replacements) ? requestBody.replacements : []) {
    if (!replacement || typeof replacement.target !== 'string') continue;
    const value = await resolveValue(replacement.value, ctx);
    const selectorType = typeof replacement.targetSelectorType === 'string' ? replacement.targetSelectorType : replacement.targetSelectorType?.type;
    const version = typeof replacement.targetSelectorType === 'object' ? replacement.targetSelectorType?.version : undefined;
    const xmlBody = typeof body === 'string' && (isXmlMediaType(contentType) || body.trim().startsWith('<'));
    const type = selectorType || (xmlBody ? 'xpath' : 'jsonpointer');
    if (type === 'xpath') {
      if (typeof body !== 'string') throw new ArazzoRuntimeError(`replacement '${replacement.target}' uses XPath but the payload is not XML`);
      body = (await replaceXPath(body, replacement.target, value, version)).xml;
      continue;
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new ArazzoRuntimeError(`replacement '${replacement.target}' needs a JSON payload`);
      }
    }
    if (body === undefined || body === null || typeof body !== 'object') body = {};
    if (type === 'jsonpath') replaceJsonPath(body, replacement.target, value, version);
    else if (type === 'jsonpointer') replaceJsonPointer(body, replacement.target, value);
    else throw new ArazzoRuntimeError(`unsupported targetSelectorType '${type}'`);
  }

  if (body !== undefined && typeof body === 'object' && body !== null && contentType) {
    if (/x-www-form-urlencoded/i.test(contentType)) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => form.append(key, toFormValue(item)));
        else form.append(key, toFormValue(value));
      }
      body = form.toString();
    } else if (/multipart\/form-data/i.test(contentType)) {
      const form = new FormData();
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined) continue;
        form.append(key, toFormValue(value));
      }
      return { body: form };
    }
  }
  return { body, contentType };
}

export interface StaticRequest {
  method: string;
  /** Path template with the server prefix, or an absolute URL template when the source has a baseUrl override. */
  urlTemplate: string;
  headers: Record<string, string>;
  query: URLSearchParams;
}

function serializePathValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => embedValue(v)).join(',');
  return valueToString(value);
}

/** Builds the outbound request config for an operation step (runs inside beforeSend). */
export async function buildRequest(scope: Scope, step: StepDef, staticRequest: StaticRequest, ctx: EvalContext): Promise<any> {
  const headers: Record<string, string> = { ...staticRequest.headers };
  const query = new URLSearchParams(staticRequest.query);
  const cookies: Record<string, string> = {};
  const pathParams: Record<string, unknown> = {};
  let rawQueryString: string | undefined;

  for (const param of step.parameters) {
    let value: unknown;
    try {
      value = await resolveValue(param.value, ctx);
    } catch (error) {
      throw new ArazzoRuntimeError(`could not resolve ${param.in} parameter '${param.name}': ${(error as Error).message}`);
    }
    if (param.in === 'path') {
      if (value === undefined || value === null) {
        throw new ArazzoRuntimeError(`path parameter '${param.name}' resolved to ${String(value)} (from ${JSON.stringify(param.value)})`);
      }
      pathParams[param.name] = value;
      continue;
    }
    if (value === undefined) continue;
    if (param.in === 'query') {
      query.delete(param.name);
      if (Array.isArray(value)) value.forEach((item) => query.append(param.name, embedValue(item)));
      else query.append(param.name, valueToString(value));
    } else if (param.in === 'querystring') {
      rawQueryString = typeof value === 'string' ? value.replace(/^\?/, '') : new URLSearchParams(value as any).toString();
    } else if (param.in === 'header') {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === param.name.toLowerCase()) delete headers[key];
      headers[param.name] = valueToString(value);
    } else if (param.in === 'cookie') {
      cookies[param.name] = valueToString(value);
    }
  }
  mergeCookieHeader(headers, cookies);

  let url = staticRequest.urlTemplate.replace(/\{([^}]+)\}/g, (match, name) => {
    if (!(name in pathParams)) return match;
    return encodeURIComponent(serializePathValue(pathParams[name]));
  });
  const unresolved = /\{([^}]+)\}/.exec(url.split('?')[0]);
  if (unresolved) {
    const unused = Object.keys(pathParams).filter((name) => !staticRequest.urlTemplate.includes(`{${name}}`));
    const hint = unused.length ? `; the step sets path parameter ${unused.map((n) => `'${n}'`).join(', ')}, which the path does not use` : " (add it to the step's parameters)";
    throw new ArazzoRuntimeError(`path parameter '${unresolved[1]}' has no value${hint}`);
  }
  const queryString = rawQueryString ?? query.toString();
  if (queryString) url += `${url.includes('?') ? '&' : '?'}${queryString}`;

  // An Arazzo step is one API operation, so a 3xx is its result rather than something to follow.
  const followRedirects = step.x.followRedirects ?? scope.x.followRedirects ?? false;
  const config: any = { method: staticRequest.method, url, headers, redirect: followRedirects ? 'follow' : 'manual', spectestMeta: { pathParams } };
  const built = await buildRequestBody(step, ctx);
  if (built && built.body !== undefined) {
    config.data = built.body;
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
    if (built.contentType && !hasContentType && !(built.body instanceof FormData)) headers['Content-Type'] = built.contentType;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Scope activation and flow movement

function anchorMatches(flow: FlowState, anchor: Anchor): boolean {
  const cursor = flow.cursor as any;
  if (!cursor || cursor.round !== anchor.round) return false;
  return anchor.kind === 'step' ? cursor.index === anchor.index : cursor.block === anchor.key;
}

function describeCursor(scope: Scope, flow: FlowState): string {
  const cursor = flow.cursor as any;
  if (!cursor) return 'nowhere';
  const where = cursor.block !== undefined ? `workflow block '${cursor.block}'` : `step '${scope.workflow.steps[cursor.index]?.stepId}'`;
  return cursor.round > 1 ? `${where} (iteration ${cursor.round})` : where;
}

async function initializeScope(scope: Scope, state: any): Promise<FlowState> {
  const flow: FlowState = { cursor: { round: 1, index: 0 }, ended: false, retryCounts: {} };
  if (scope.workflow.steps.length === 0) {
    flow.cursor = null;
    flow.ended = true;
    flow.outcome = 'completed';
  }
  if (scope.inputs.kind === 'params' && scope.parent) {
    const parentScope = scope.parent.scope;
    const parentFlow = getFlow(parentScope, state);
    const triggerResult = scope.inputs.trigger === 'block' && parentFlow?.trigger ? state.completedCases?.[parentFlow.trigger] : undefined;
    const ctx: EvalContext = {
      scope: parentScope,
      state,
      exchange: triggerResult ? exchangeFromResult(triggerResult, baseUrlFor(parentScope)) : undefined,
    };
    const values: Record<string, unknown> = { ...schemaDefaults(scope.inputs.schema) };
    try {
      for (const param of scope.inputs.params) {
        const value = await resolveValue(param.value, ctx);
        if (value !== undefined) values[param.name] = value;
      }
      flow.inputs = values;
      const problems = validateInputs(values, scope.inputs.schema);
      if (problems.length) flow.inputsError = `invalid inputs for workflow '${scope.workflow.workflowId}': ${problems.join('; ')}`;
    } catch (error) {
      flow.inputs = values;
      flow.inputsError = `could not resolve inputs for workflow '${scope.workflow.workflowId}': ${(error as Error).message}`;
    }
  }
  flowStates(state)[scope.id] = flow;
  return flow;
}

/** Ensures a scope's ancestors put it in control and initializes its flow state on first use. */
export async function activateScope(scope: Scope, state: any): Promise<{ ok: true; flow: FlowState } | { ok: false; reason: string }> {
  if (scope.parent) {
    const parent = await activateScope(scope.parent.scope, state);
    if ('reason' in parent) return parent;
    if (parent.flow.ended) return { ok: false, reason: `workflow '${scope.parent.scope.workflow.workflowId}' already ended` };
    if (!anchorMatches(parent.flow, scope.parent.anchor)) return { ok: false, reason: 'not reached' };
  }
  const existing = getFlow(scope, state);
  return { ok: true, flow: existing || (await initializeScope(scope, state)) };
}

function completeScope(flow: FlowState, transition: string): void {
  flow.cursor = null;
  flow.ended = true;
  flow.outcome = flow.outcome || 'completed';
  flow.lastTransition = transition;
}

/** Moves the cursor from step `from` to step `to`; a non-forward move starts the next iteration. */
function moveTo(scope: Scope, flow: FlowState, round: number, from: number, to: number, why: string): string | undefined {
  const nextRound = to > from ? round : round + 1;
  if (nextRound > scope.rounds) {
    return `iteration limit reached: '${why}' needs iteration ${nextRound} but workflow '${scope.workflow.workflowId}' allows ${scope.rounds} (raise x-spectest.maxIterations or arazzoMaxIterations)`;
  }
  flow.cursor = { round: nextRound, index: to };
  flow.lastTransition = `${why} → step '${scope.workflow.steps[to].stepId}'${nextRound > 1 ? ` (iteration ${nextRound})` : ''}`;
  return undefined;
}

function moveToBlock(scope: Scope, flow: FlowState, round: number, action: ActionDef, triggerId: string, why: string): string | undefined {
  if (!scope.blocks.has(`${round}:${action.key}`)) return `workflow '${action.workflow?.workflowId}' is not available for '${why}'`;
  flow.cursor = { round, block: action.key };
  flow.trigger = triggerId;
  flow.lastTransition = `${why} → workflow '${action.workflow!.workflowId}'`;
  return undefined;
}

function consumeDelay(scope: Scope, state: any): number {
  let total = 0;
  for (let current: Scope | undefined = scope; current; current = current.parent?.scope) {
    const flow = getFlow(current, state);
    if (flow?.pendingDelayMs) {
      total += flow.pendingDelayMs;
      delete flow.pendingDelayMs;
    }
  }
  return total;
}

/** `when` for a node that records step `index` of iteration `round` in `scope`. */
export async function gateStep(scope: Scope, round: number, index: number, nodeId: string, state: any, opts: { http: boolean }): Promise<WhenOutcome> {
  const active = await activateScope(scope, state);
  if ('reason' in active) return { skip: active.reason, quiet: true };
  const flow = active.flow;
  if (flow.ended) {
    return { skip: `not executed: ${flow.lastTransition || `workflow '${scope.workflow.workflowId}' ended`}`, quiet: round > 1 };
  }
  const cursor = flow.cursor as any;
  if (cursor && cursor.round === round && cursor.index === index) {
    if (opts.http) {
      const delay = consumeDelay(scope, state);
      if (delay > 0) {
        state.__arazzoDelays ??= {};
        state.__arazzoDelays[nodeId] = delay;
      }
    }
    return true;
  }
  if (cursor && cursor.round > round) return { skip: `flow moved on to iteration ${cursor.round}`, quiet: true };
  const reason = flow.lastTransition ? `not executed: ${flow.lastTransition}` : `not executed (flow is at ${describeCursor(scope, flow)})`;
  return { skip: reason, quiet: round > 1 };
}

export async function gateBlock(scope: Scope, round: number, key: string, state: any): Promise<WhenOutcome> {
  const active = await activateScope(scope, state);
  if ('reason' in active) return { skip: active.reason, quiet: true };
  const cursor = active.flow.cursor as any;
  if (!active.flow.ended && cursor && cursor.round === round && cursor.block === key) return true;
  return { skip: 'not reached', quiet: true };
}

// ---------------------------------------------------------------------------
// Outcomes

export function baseUrlFor(scope: Scope, step?: StepDef): string | undefined {
  return step?.operation?.source.override?.baseUrl || scope.program.cfg.baseUrl;
}

function retryAfterMs(headers: any, fallbackSeconds: number | undefined): number {
  const header = headers && typeof headers.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return Math.max(0, (fallbackSeconds ?? 0) * 1000);
}

function pickResponse(responses: any, status: number): { key?: string; response?: any } {
  if (!responses || typeof responses !== 'object') return {};
  const exact = String(status);
  if (responses[exact]) return { key: exact, response: responses[exact] };
  const range = Object.keys(responses).find((key) => key.toUpperCase() === `${exact[0]}XX`);
  if (range) return { key: range, response: responses[range] };
  if (responses.default) return { key: 'default', response: responses.default };
  return {};
}

/** Contract check of a response against the step's OpenAPI operation. */
export function validateAgainstOperation(step: StepDef, status: number, headers: any, body: unknown): string[] {
  const operation = step.operation?.operation;
  if (!operation) return [];
  const { key, response } = pickResponse(operation.responses, status);
  if (!key) {
    const documented = Object.keys(operation.responses || {}).join(', ') || 'none';
    return [`response status ${status} is not documented for ${step.operation!.entry.method.toUpperCase()} ${step.operation!.entry.pathKey} (documented: ${documented})`];
  }
  const content = response?.content;
  if (!content || typeof content !== 'object') return [];
  const received = String((headers && typeof headers.get === 'function' ? headers.get('content-type') : headers?.['content-type']) || '');
  const mediaType =
    Object.keys(content).find((type) => received && received.toLowerCase().startsWith(type.toLowerCase())) ||
    Object.keys(content).find((type) => isJsonMediaType(type));
  const schema = mediaType ? content[mediaType]?.schema : undefined;
  if (!schema || !isJsonMediaType(mediaType) || (received && !isJsonMediaType(received))) return [];
  const result = validateAgainstSchema(body, schema);
  return result.success ? [] : [`response does not match the OpenAPI schema for ${key}: ${result.errors.join(', ')}`];
}

async function evaluateOutputsMap(map: Record<string, any>, ctx: EvalContext): Promise<StoredOutputs> {
  const stored: StoredOutputs = { values: {}, errors: {} };
  for (const [name, expression] of Object.entries(map || {})) {
    try {
      stored.values[name] = await resolveValue(expression, ctx);
    } catch (error) {
      stored.errors[name] = (error as Error).message;
    }
  }
  return stored;
}

/** Evaluates and stores a (sub-)workflow's outputs; `$outputs.x` inside refers to sibling outputs. */
export async function computeWorkflowOutputs(scope: Scope, state: any): Promise<StoredOutputs> {
  const map = scope.workflow.outputs || {};
  const stored: StoredOutputs = { values: {}, errors: {} };
  const inProgress = new Set<string>();
  const flow = getFlow(scope, state);
  const lastResult = flow?.lastExchange ? state.completedCases?.[flow.lastExchange] : undefined;
  const evaluateOne = async (name: string): Promise<unknown> => {
    if (name in stored.values) return stored.values[name];
    if (name in stored.errors) throw new ArazzoRuntimeError(stored.errors[name]);
    if (!(name in map)) throw new ArazzoRuntimeError(`workflow '${scope.workflow.workflowId}' has no output '${name}'`);
    if (inProgress.has(name)) throw new ArazzoRuntimeError(`output '${name}' refers to itself`);
    inProgress.add(name);
    try {
      const value = await resolveValue(map[name], ctx);
      stored.values[name] = value;
      return value;
    } catch (error) {
      stored.errors[name] = (error as Error).message;
      throw error;
    } finally {
      inProgress.delete(name);
    }
  };
  const ctx: EvalContext = {
    scope,
    state,
    exchange: lastResult ? exchangeFromResult(lastResult, baseUrlFor(scope)) : undefined,
    outputs: (name) => {
      if (name in stored.values) return stored.values[name];
      throw new ArazzoRuntimeError(`output '${name}' must be declared before it is referenced`);
    },
  };
  for (const name of Object.keys(map)) {
    try {
      await evaluateOne(name);
    } catch {
      // recorded in stored.errors
    }
  }
  storedWorkflowOutputs(state)[scope.id] = stored;
  return stored;
}

function setLastExchange(scope: Scope, state: any, nodeId: string): void {
  for (let current: Scope | undefined = scope; current; current = current.parent?.scope) {
    const flow = getFlow(current, state);
    if (flow) flow.lastExchange = nodeId;
  }
}

function criteriaMatch(action: ActionDef, resolver: ExpressionResolver): Promise<string[]> {
  return evaluateCriteria(action.criteria, resolver);
}

function responseValidationMode(scope: Scope, step: StepDef): 'auto' | 'always' | 'never' {
  return step.x.validateResponse || scope.x.validateResponse || scope.program.cfg.arazzoResponseValidation || 'auto';
}

export interface OutcomeInput {
  scope: Scope;
  round: number;
  index: number;
  nodeId: string;
  /** HTTP step: the live exchange; workflow step: the child's last exchange. */
  exchange?: HttpExchange;
  response?: { status: number; headers: any; body: unknown };
  /** Errors already established (e.g. a deferred sub-workflow failure). */
  priorErrors?: string[];
  /** For HTTP nodes: the assert scratch (plain retry counters live there). */
  scratch?: Record<string, any>;
  /** `$outputs` resolver for a workflow step (its child's outputs). */
  outputs?: (name: string) => unknown;
  isWorkflowStep: boolean;
}

/**
 * Decides a step's outcome: evaluates successCriteria (or the OpenAPI contract
 * check), records outputs, then applies the matching success/failure action
 * and moves the scope's cursor. Returns the AssertOutcome for the node.
 */
export async function decideStep(input: OutcomeInput, state: any): Promise<AssertOutcome> {
  const { scope, round, index, nodeId } = input;
  const step = scope.workflow.steps[index];
  const flow = getFlow(scope, state)!;
  const ctx: EvalContext = { scope, state, exchange: input.exchange, outputs: input.outputs };
  const resolver = makeResolver(ctx);

  storedOutputs(state)[nodeId] = await evaluateOutputsMap(step.outputs, ctx);
  if (!input.isWorkflowStep) setLastExchange(scope, state, nodeId);

  const errors: string[] = [...(input.priorErrors || [])];
  if (errors.length === 0) {
    if (step.successCriteria.length > 0) errors.push(...(await evaluateCriteria(step.successCriteria, resolver)));
    const mode = responseValidationMode(scope, step);
    if (!input.isWorkflowStep && input.response && (mode === 'always' || (mode === 'auto' && step.successCriteria.length === 0))) {
      errors.push(...validateAgainstOperation(step, input.response.status, input.response.headers, input.response.body));
    }
  }

  if (errors.length === 0) {
    if (flow.returnTo !== undefined) {
      const target = flow.returnTo;
      delete flow.returnTo;
      const problem = moveTo(scope, flow, round, index, target, `returning after '${step.stepId}'`);
      return problem ? fail(scope, flow, [problem]) : {};
    }
    for (const action of step.onSuccess) {
      if ((await criteriaMatch(action, resolver)).length > 0) continue;
      const why = `onSuccess '${action.name}'`;
      if (action.type === 'end') {
        completeScope(flow, `workflow ended by ${why} after step '${step.stepId}'`);
        return { note: `${why}: end workflow` };
      }
      if (action.stepId) {
        const problem = moveTo(scope, flow, round, index, stepIndex(scope, action.stepId), why);
        return problem ? fail(scope, flow, [problem]) : { note: `${why}: goto step '${action.stepId}'` };
      }
      const problem = moveToBlock(scope, flow, round, action, nodeId, why);
      return problem ? fail(scope, flow, [problem]) : { note: `${why}: goto workflow '${action.workflow!.workflowId}'` };
    }
    if (index + 1 < scope.workflow.steps.length) {
      flow.cursor = { round, index: index + 1 };
      flow.lastTransition = `step '${step.stepId}' succeeded`;
    } else {
      completeScope(flow, `workflow completed after step '${step.stepId}'`);
    }
    return {};
  }

  const summary = errors.join('; ');
  for (const action of step.onFailure) {
    if ((await criteriaMatch(action, resolver)).length > 0) continue;
    const why = `onFailure '${action.name}'`;
    if (action.type === 'retry') {
      const limit = action.retryLimit ?? 1;
      const delayMs = retryAfterMs(input.response?.headers, action.retryAfter);
      if (!action.stepId && !action.workflow && !input.isWorkflowStep && input.scratch) {
        input.scratch.retries ??= {};
        const used = input.scratch.retries[action.key] || 0;
        if (used >= limit) continue;
        input.scratch.retries[action.key] = used + 1;
        return { errors, retry: { delayMs }, note: `${why}: retry ${used + 1}/${limit}` };
      }
      // Counted per step across iterations, so the limit holds however the loop is unrolled.
      const counter = `${action.key}@${index}`;
      const used = flow.retryCounts[counter] || 0;
      if (used >= limit) continue;
      flow.retryCounts[counter] = used + 1;
      if (delayMs > 0) flow.pendingDelayMs = delayMs;
      let problem: string | undefined;
      if (action.stepId) {
        flow.returnTo = index;
        problem = moveTo(scope, flow, round, index, stepIndex(scope, action.stepId), why);
      } else if (action.workflow) {
        flow.returnTo = index;
        problem = moveToBlock(scope, flow, round, action, nodeId, why);
      } else {
        problem = moveTo(scope, flow, round, index, index, why);
      }
      if (problem) return fail(scope, flow, [...errors, problem]);
      const target = action.stepId ? `step '${action.stepId}' then ` : action.workflow ? `workflow '${action.workflow.workflowId}' then ` : '';
      return { note: `${summary} — ${why}: run ${target}retry (${used + 1}/${limit})` };
    }
    if (action.type === 'end') {
      completeScope(flow, `workflow ended by ${why} after step '${step.stepId}'`);
      return { note: `${summary} — ${why}: end workflow` };
    }
    if (action.stepId) {
      const problem = moveTo(scope, flow, round, index, stepIndex(scope, action.stepId), why);
      return problem ? fail(scope, flow, [...errors, problem]) : { note: `${summary} — ${why}: goto step '${action.stepId}'` };
    }
    const problem = moveToBlock(scope, flow, round, action, nodeId, why);
    return problem ? fail(scope, flow, [...errors, problem]) : { note: `${summary} — ${why}: goto workflow '${action.workflow!.workflowId}'` };
  }

  if (scope.deferFailures) {
    flow.outcome = 'failed';
    flow.failure = `step '${step.stepId}': ${summary}`;
    completeScope(flow, `workflow failed at step '${step.stepId}'`);
    return { note: `${summary} — handed to the calling step's onFailure actions` };
  }
  return fail(scope, flow, errors);
}

function fail(scope: Scope, flow: FlowState, errors: string[]): AssertOutcome {
  flow.outcome = 'failed';
  flow.failure = errors.join('; ');
  flow.cursor = null;
  flow.ended = true;
  flow.lastTransition = `workflow '${scope.workflow.workflowId}' failed`;
  return { errors, retry: false };
}

/** After a goto/retry block finishes: one-way gotos end the workflow, retry-with-workflow returns to the step. */
export function finishBlock(scope: Scope, round: number, block: Block, state: any): AssertOutcome {
  const flow = getFlow(scope, state)!;
  const childFlow = getFlow(block.scope, state);
  if (block.action.type === 'retry' && flow.returnTo !== undefined) {
    const target = flow.returnTo;
    delete flow.returnTo;
    const problem = moveTo(scope, flow, round, scope.workflow.steps.length, target, `returning from workflow '${block.action.workflow!.workflowId}'`);
    return problem ? fail(scope, flow, [problem]) : { note: `workflow '${block.action.workflow!.workflowId}' finished; retrying step '${scope.workflow.steps[target].stepId}'` };
  }
  completeScope(flow, `control transferred to workflow '${block.action.workflow!.workflowId}'`);
  return { note: `workflow '${block.action.workflow!.workflowId}' ${childFlow?.outcome === 'failed' ? 'failed' : 'completed'}; '${scope.workflow.workflowId}' ends here` };
}

/** Delay requested by a call-return retry, consumed by the next HTTP node of the scope. */
export async function applyPendingDelay(nodeId: string, state: any): Promise<void> {
  const delay = state?.__arazzoDelays?.[nodeId];
  if (delay && delay > 0) await sleep(Math.min(delay, 120000));
}

export function toTestResponse(response: TestResponse): { status: number; headers: any; body: unknown } {
  return { status: response.status, headers: response.headers, body: response.data };
}

