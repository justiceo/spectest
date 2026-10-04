// Normalized view of Arazzo workflows: reusable objects resolved, workflow-level
// parameters/actions merged into steps, operation and workflow references
// resolved against source descriptions. Static problems are recorded on the
// step (`error`) so the compiler can skip the workflow with a reason.
import { OpenApiSkip, resolveRefs } from '../openapi/document.js';
import { RuntimeExpressionError, looksLikeRuntimeExpression, parseRuntimeExpression, parseTemplate } from '../runtime-expression.js';
import type { ArazzoDocument, OpenApiOperationEntry, SourceRef } from './document.js';

export interface ParamDef {
  name: string;
  in?: string;
  value: any;
}

export interface CriterionDef {
  context?: string;
  condition: string;
  type?: string;
  version?: string;
}

export interface WorkflowRef {
  doc: ArazzoDocument;
  workflowId: string;
}

export interface ActionDef {
  /** Stable identity, used to key retry counters and goto-workflow blocks. */
  key: string;
  name: string;
  kind: 'success' | 'failure';
  type: 'end' | 'goto' | 'retry';
  stepId?: string;
  workflow?: WorkflowRef;
  parameters: ParamDef[];
  retryAfter?: number;
  retryLimit?: number;
  criteria: CriterionDef[];
}

export interface OperationRef {
  source: SourceRef;
  entry: OpenApiOperationEntry;
  /** The operation with $refs resolved, plus path-item parameters merged in. */
  operation: any;
  parameters: any[];
}

export interface SpectestExtension {
  tags?: string[];
  skip?: boolean;
  skipReason?: string;
  phase?: 'setup' | 'main' | 'teardown';
  timeout?: number;
  delay?: number;
  recording?: 'off' | 'replay' | 'record';
  security?: string;
  beforeSend?: string;
  postTest?: string;
  maxIterations?: number;
  validateResponse?: 'auto' | 'always' | 'never';
  inputs?: Record<string, unknown>;
  idPrefix?: string;
  followRedirects?: boolean;
}

export interface StepDef {
  index: number;
  stepId: string;
  description?: string;
  kind: 'operation' | 'workflow';
  operation?: OperationRef;
  workflow?: WorkflowRef;
  parameters: ParamDef[];
  requestBody?: any;
  successCriteria: CriterionDef[];
  onSuccess: ActionDef[];
  onFailure: ActionDef[];
  outputs: Record<string, any>;
  timeout?: number;
  dependsOn: string[];
  x: SpectestExtension;
  error?: string;
  /** Path/query parameters the OpenAPI operation doesn't declare (likely typos). */
  parameterWarnings?: string[];
  raw: any;
}

export interface WorkflowDef {
  doc: ArazzoDocument;
  workflowId: string;
  summary?: string;
  raw: any;
  inputsSchema?: any;
  inputsSchemaError?: string;
  steps: StepDef[];
  outputs: Record<string, any>;
  dependsOn: WorkflowRef[];
  dependsOnErrors: string[];
  x: SpectestExtension;
  warnings: string[];
}

export function normalizeExtension(raw: any): SpectestExtension {
  if (!raw || typeof raw !== 'object') return {};
  const x: SpectestExtension = {};
  if (Array.isArray(raw.tags)) x.tags = raw.tags.map(String);
  else if (typeof raw.tags === 'string') x.tags = [raw.tags];
  if (typeof raw.skip === 'boolean') x.skip = raw.skip;
  if (typeof raw.skipReason === 'string') x.skipReason = raw.skipReason;
  if (raw.phase === 'setup' || raw.phase === 'main' || raw.phase === 'teardown') x.phase = raw.phase;
  if (typeof raw.timeout === 'number' && raw.timeout > 0) x.timeout = raw.timeout;
  if (typeof raw.delay === 'number' && raw.delay > 0) x.delay = raw.delay;
  if (raw.recording === 'off' || raw.recording === 'replay' || raw.recording === 'record') x.recording = raw.recording;
  if (typeof raw.security === 'string') x.security = raw.security;
  else if (raw.security === true) x.security = 'default';
  if (typeof raw.beforeSend === 'string') x.beforeSend = raw.beforeSend;
  if (typeof raw.postTest === 'string') x.postTest = raw.postTest;
  if (typeof raw.maxIterations === 'number' && raw.maxIterations >= 1) x.maxIterations = Math.floor(raw.maxIterations);
  if (raw.validateResponse === true) x.validateResponse = 'always';
  else if (raw.validateResponse === false) x.validateResponse = 'never';
  else if (raw.validateResponse === 'auto' || raw.validateResponse === 'always' || raw.validateResponse === 'never') {
    x.validateResponse = raw.validateResponse;
  }
  if (raw.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs)) x.inputs = raw.inputs;
  if (typeof raw.idPrefix === 'string') x.idPrefix = raw.idPrefix;
  if (typeof raw.followRedirects === 'boolean') x.followRedirects = raw.followRedirects;
  return x;
}

/** Strips one pair of `{}` around a value that is a single embedded expression (e.g. `{$statusCode == 401}`). */
export function unwrapBraces(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{$') && trimmed.endsWith('}') && trimmed.indexOf('}') === trimmed.length - 1) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveComponent(doc: ArazzoDocument, reference: string, type: string): any {
  let parsed;
  try {
    parsed = parseRuntimeExpression(unwrapBraces(reference));
  } catch (error) {
    throw new Error(`invalid reusable object reference '${reference}': ${(error as Error).message}`);
  }
  if (parsed.root !== 'components' || parsed.componentType !== type) {
    throw new Error(`reusable object reference '${reference}' must point at $components.${type}.<name>`);
  }
  const found = doc.components?.[type]?.[parsed.name];
  if (found === undefined) {
    throw new Error(`reusable object '${reference}' is not defined in components.${type}`);
  }
  return found;
}

function normalizeParameter(doc: ArazzoDocument, raw: any): ParamDef {
  if (raw && typeof raw === 'object' && typeof raw.reference === 'string') {
    const component = resolveComponent(doc, raw.reference, 'parameters');
    return {
      name: String(component.name),
      in: component.in,
      value: 'value' in raw ? raw.value : component.value,
    };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') {
    throw new Error('parameter must have a name');
  }
  return { name: raw.name, in: raw.in, value: raw.value };
}

function paramKey(param: ParamDef): string {
  return `${param.in ?? ''}:${param.name}`;
}

/** Workflow-level parameters, overridden (never removed) by step-level ones with the same name+in. */
export function mergeParameters(workflowLevel: ParamDef[], stepLevel: ParamDef[]): ParamDef[] {
  const merged = new Map<string, ParamDef>();
  for (const param of workflowLevel) merged.set(paramKey(param), param);
  for (const param of stepLevel) merged.set(paramKey(param), param);
  return [...merged.values()];
}

function normalizeCriterion(raw: any): CriterionDef {
  if (!raw || typeof raw !== 'object' || typeof raw.condition !== 'string') {
    throw new Error('criterion must have a condition');
  }
  const criterion: CriterionDef = { condition: raw.condition };
  if (typeof raw.context === 'string') criterion.context = raw.context;
  if (typeof raw.type === 'string') criterion.type = raw.type;
  else if (raw.type && typeof raw.type === 'object') {
    criterion.type = String(raw.type.type);
    if (raw.type.version !== undefined) criterion.version = String(raw.type.version);
  }
  return criterion;
}

function normalizeCriteria(raw: any): CriterionDef[] {
  return Array.isArray(raw) ? raw.map(normalizeCriterion) : [];
}

export function resolveWorkflowReference(doc: ArazzoDocument, reference: string): WorkflowRef {
  const value = unwrapBraces(String(reference));
  if (value.startsWith('$sourceDescriptions.')) {
    const parsed = parseRuntimeExpression(value);
    if (parsed.root !== 'sourceDescriptions') throw new Error(`invalid workflow reference '${reference}'`);
    const source = doc.sources.get(parsed.sourceName);
    if (!source) throw new Error(`workflow reference '${reference}' names an unknown source description '${parsed.sourceName}'`);
    if (source.error) throw new Error(source.error);
    if (!source.arazzo) throw new Error(`workflow reference '${reference}' must point at an arazzo source description`);
    // 1.1 also allows `$sourceDescriptions.<name>.<workflowId>.steps.<stepId>`; only the workflow part matters here.
    const workflowId = parsed.reference.split('.steps.')[0];
    if (!source.arazzo.workflows.has(workflowId)) {
      throw new Error(`workflow '${workflowId}' is not defined in source description '${parsed.sourceName}'`);
    }
    return { doc: source.arazzo, workflowId };
  }
  if (!doc.workflows.has(value)) {
    throw new Error(`workflow '${value}' is not defined in this document`);
  }
  return { doc, workflowId: value };
}

function normalizeAction(doc: ArazzoDocument, raw: any, kind: 'success' | 'failure', key: string): ActionDef {
  let source = raw;
  let actionKey = key;
  if (raw && typeof raw === 'object' && typeof raw.reference === 'string') {
    const type = kind === 'success' ? 'successActions' : 'failureActions';
    source = resolveComponent(doc, raw.reference, type);
    actionKey = `${doc.location}#components/${type}/${unwrapBraces(raw.reference).split('.').slice(2).join('.')}`;
  }
  if (!source || typeof source !== 'object' || typeof source.name !== 'string' || typeof source.type !== 'string') {
    throw new Error(`${kind} action must have a name and a type`);
  }
  const allowed = kind === 'success' ? ['end', 'goto'] : ['end', 'goto', 'retry'];
  if (!allowed.includes(source.type)) {
    throw new Error(`${kind} action '${source.name}' has unsupported type '${source.type}'`);
  }
  const action: ActionDef = {
    key: actionKey,
    name: source.name,
    kind,
    type: source.type,
    parameters: Array.isArray(source.parameters) ? source.parameters.map((p: any) => normalizeParameter(doc, p)) : [],
    criteria: normalizeCriteria(source.criteria),
  };
  if (typeof source.stepId === 'string') action.stepId = source.stepId;
  if (typeof source.workflowId === 'string') action.workflow = resolveWorkflowReference(doc, source.workflowId);
  if (action.type === 'goto' && !action.stepId && !action.workflow) {
    throw new Error(`goto action '${action.name}' needs a stepId or a workflowId`);
  }
  if (action.type === 'retry') {
    if (typeof source.retryAfter === 'number') action.retryAfter = Math.max(0, source.retryAfter);
    action.retryLimit = typeof source.retryLimit === 'number' ? Math.max(0, Math.floor(source.retryLimit)) : 1;
  }
  return action;
}

/** Step-level actions first (in order), then workflow-level ones the step didn't override by name. */
export function mergeActions(stepLevel: ActionDef[], workflowLevel: ActionDef[]): ActionDef[] {
  const names = new Set(stepLevel.map((a) => a.name));
  return [...stepLevel, ...workflowLevel.filter((a) => !names.has(a.name))];
}

function resolveOpenApiOperation(source: SourceRef, entry: OpenApiOperationEntry): OperationRef {
  const doc = source.openapi!.doc;
  try {
    const operation = resolveRefs(entry.operation, doc);
    const rootParams = Array.isArray(entry.pathItem?.parameters) ? entry.pathItem.parameters : [];
    const parameters = [...rootParams, ...(operation.parameters || [])].map((p: any) => resolveRefs(p, doc));
    return { source, entry, operation, parameters };
  } catch (error) {
    const reason = error instanceof OpenApiSkip ? error.message : String((error as Error)?.message || error);
    throw new Error(`could not resolve operation ${entry.method.toUpperCase()} ${entry.pathKey} in '${source.name}': ${reason}`);
  }
}

function openApiSources(doc: ArazzoDocument): SourceRef[] {
  return [...doc.sources.values()].filter((s) => s.type !== 'arazzo' && s.type !== 'asyncapi');
}

export function resolveOperationId(doc: ArazzoDocument, reference: string): OperationRef {
  const value = unwrapBraces(String(reference));
  if (value.startsWith('$sourceDescriptions.')) {
    const parsed = parseRuntimeExpression(value);
    if (parsed.root !== 'sourceDescriptions') throw new Error(`invalid operation reference '${reference}'`);
    const source = doc.sources.get(parsed.sourceName);
    if (!source) throw new Error(`operation reference '${reference}' names an unknown source description '${parsed.sourceName}'`);
    if (source.error) throw new Error(source.error);
    if (!source.openapi) throw new Error(`operation reference '${reference}' must point at an OpenAPI source description`);
    const entry = source.openapi.byOperationId.get(parsed.reference);
    if (!entry) {
      throw new Error(`operationId '${parsed.reference}' was not found in source description '${source.name}'${didYouMean(parsed.reference, [source])}`);
    }
    return resolveOpenApiOperation(source, entry);
  }
  const sources = openApiSources(doc);
  const matches = sources.filter((s) => s.openapi?.byOperationId.has(value));
  if (matches.length === 1) {
    return resolveOpenApiOperation(matches[0], matches[0].openapi!.byOperationId.get(value)!);
  }
  if (matches.length > 1) {
    throw new Error(
      `operationId '${value}' exists in several source descriptions (${matches.map((m) => m.name).join(', ')}); qualify it as $sourceDescriptions.<name>.${value}`
    );
  }
  const failed = sources.filter((s) => s.error);
  const loaded = sources.filter((s) => s.openapi);
  if (loaded.length === 0 && failed.length > 0) {
    throw new Error(`operationId '${value}' could not be resolved: ${failed.map((s) => s.error).join('; ')}`);
  }
  const note = failed.length > 0 ? ` (also, ${failed.map((s) => s.error).join('; ')})` : '';
  throw new Error(`operationId '${value}' was not found in any OpenAPI source description${didYouMean(value, sources)}${note}`);
}

// operationIds are case-sensitive; point out a near miss that differs only in case.
function didYouMean(operationId: string, sources: SourceRef[]): string {
  for (const source of sources) {
    for (const candidate of source.openapi?.byOperationId.keys() || []) {
      if (candidate.toLowerCase() === operationId.toLowerCase()) return ` (did you mean '${candidate}'?)`;
    }
  }
  return '';
}

export function resolveOperationPath(doc: ArazzoDocument, reference: string): OperationRef {
  const value = String(reference).trim();
  const match = /^\{?\$sourceDescriptions\.([^.}]+)\.url\}?#(\/.*)$/.exec(value);
  if (!match) {
    // Tolerate `$sourceDescriptions.<name>.<operationId>` written as an operationPath.
    if (value.startsWith('$sourceDescriptions.') || value.startsWith('{$sourceDescriptions.')) return resolveOperationId(doc, value);
    throw new Error(`operationPath '${reference}' must look like '{$sourceDescriptions.<name>.url}#/paths/<path>/<method>'`);
  }
  const source = doc.sources.get(match[1]);
  if (!source) throw new Error(`operationPath '${reference}' names an unknown source description '${match[1]}'`);
  if (source.error) throw new Error(source.error);
  if (!source.openapi) throw new Error(`operationPath '${reference}' must point at an OpenAPI source description`);
  const parts = match[2].replace(/^\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts[0] !== 'paths' || parts.length < 2) {
    throw new Error(`operationPath '${reference}' must point into #/paths`);
  }
  const pathKey = parts[1];
  const candidates = source.openapi.operations.filter((op) => op.pathKey === pathKey);
  if (candidates.length === 0) throw new Error(`operationPath '${reference}': path '${pathKey}' not found in '${source.name}'`);
  if (parts.length >= 3) {
    const entry = candidates.find((op) => op.method === parts[2].toLowerCase());
    if (!entry) throw new Error(`operationPath '${reference}': no ${parts[2].toUpperCase()} operation on '${pathKey}'`);
    return resolveOpenApiOperation(source, entry);
  }
  // Pointer to a path item rather than an operation: accept it when unambiguous.
  if (candidates.length === 1) return resolveOpenApiOperation(source, candidates[0]);
  throw new Error(`operationPath '${reference}' points at a path item with several operations; add the method to the pointer`);
}

/** Parse-checks every runtime expression in a value tree, collecting warnings. */
export function lintExpressions(value: any, where: string, warnings: string[]): void {
  if (typeof value === 'string') {
    try {
      if (looksLikeRuntimeExpression(value.trim())) parseRuntimeExpression(value.trim());
      else parseTemplate(value);
    } catch (error) {
      if (error instanceof RuntimeExpressionError) warnings.push(`${where}: ${error.message}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => lintExpressions(item, `${where}[${i}]`, warnings));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) lintExpressions(nested, `${where}.${key}`, warnings);
  }
}

function undeclaredParameterWarnings(step: StepDef): string[] {
  const op = step.operation!;
  const warnings: string[] = [];
  const label = op.entry.operationId || `${op.entry.method.toUpperCase()} ${op.entry.pathKey}`;
  for (const param of step.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    const declared = op.parameters.filter((p: any) => p?.in === param.in);
    const inTemplate = param.in === 'path' && op.entry.pathKey.includes(`{${param.name}}`);
    if (inTemplate || declared.some((p: any) => p.name === param.name)) continue;
    if (param.in === 'query' && declared.length === 0) continue;
    const known = declared.map((p: any) => p.name).join(', ');
    warnings.push(`step '${step.stepId}': ${param.in} parameter '${param.name}' is not declared by operation '${label}'${known ? ` (declared: ${known})` : ''}`);
  }
  return warnings;
}

function normalizeStep(doc: ArazzoDocument, raw: any, index: number, workflowParams: ParamDef[], workflowSuccess: ActionDef[], workflowFailure: ActionDef[], workflowKey: string): StepDef {
  const stepId = typeof raw?.stepId === 'string' ? raw.stepId : `step${index + 1}`;
  const step: StepDef = {
    index,
    stepId,
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    kind: 'operation',
    parameters: [],
    successCriteria: [],
    onSuccess: [],
    onFailure: [],
    outputs: raw?.outputs && typeof raw.outputs === 'object' ? raw.outputs : {},
    dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(String) : [],
    x: normalizeExtension(raw?.['x-spectest']),
    raw,
  };
  if (typeof raw?.timeout === 'number' && raw.timeout > 0) step.timeout = raw.timeout;
  try {
    if (typeof raw?.stepId !== 'string') throw new Error(`step #${index + 1} has no stepId`);
    const targets = ['operationId', 'operationPath', 'workflowId', 'channelPath'].filter((f) => raw[f] !== undefined);
    if (targets.length !== 1) {
      throw new Error(`step '${stepId}' must have exactly one of operationId, operationPath or workflowId`);
    }
    if (raw.channelPath !== undefined || raw.action !== undefined || raw.correlationId !== undefined) {
      throw new Error(`step '${stepId}' is an AsyncAPI step, which Spectest does not support (HTTP/OpenAPI only)`);
    }
    if (raw.workflowId !== undefined) {
      step.kind = 'workflow';
      step.workflow = resolveWorkflowReference(doc, raw.workflowId);
    } else if (raw.operationId !== undefined) {
      step.operation = resolveOperationId(doc, raw.operationId);
    } else {
      step.operation = resolveOperationPath(doc, raw.operationPath);
    }
    const stepParams = Array.isArray(raw.parameters) ? raw.parameters.map((p: any) => normalizeParameter(doc, p)) : [];
    step.parameters = mergeParameters(workflowParams, stepParams);
    if (step.kind === 'operation') {
      for (const param of step.parameters) {
        if (!param.in) {
          // Arazzo requires `in` for operation steps; infer it from the OpenAPI operation when unambiguous.
          const declared = step.operation!.parameters.filter((p: any) => p?.name === param.name);
          if (declared.length === 1) param.in = declared[0].in;
          else throw new Error(`parameter '${param.name}' of step '${stepId}' has no 'in' location`);
        }
        if (!['path', 'query', 'querystring', 'header', 'cookie'].includes(String(param.in))) {
          throw new Error(`parameter '${param.name}' of step '${stepId}' has unsupported location '${param.in}'`);
        }
      }
      step.parameterWarnings = undeclaredParameterWarnings(step);
    }
    if (raw.requestBody !== undefined) {
      if (step.kind === 'workflow') throw new Error(`step '${stepId}' invokes a workflow and cannot have a requestBody`);
      step.requestBody = raw.requestBody;
    }
    step.successCriteria = normalizeCriteria(raw.successCriteria);
    const onSuccess = Array.isArray(raw.onSuccess)
      ? raw.onSuccess.map((a: any, i: number) => normalizeAction(doc, a, 'success', `${workflowKey}/steps/${stepId}/onSuccess/${i}`))
      : [];
    const onFailure = Array.isArray(raw.onFailure)
      ? raw.onFailure.map((a: any, i: number) => normalizeAction(doc, a, 'failure', `${workflowKey}/steps/${stepId}/onFailure/${i}`))
      : [];
    step.onSuccess = mergeActions(onSuccess, workflowSuccess);
    step.onFailure = mergeActions(onFailure, workflowFailure);
  } catch (error) {
    step.error = (error as Error).message;
  }
  return step;
}

const workflowCache = new WeakMap<ArazzoDocument, Map<string, WorkflowDef>>();

/** Normalizes (and memoizes) a workflow of a loaded document. */
export function getWorkflow(doc: ArazzoDocument, workflowId: string): WorkflowDef {
  let perDoc = workflowCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    workflowCache.set(doc, perDoc);
  }
  const cached = perDoc.get(workflowId);
  if (cached) return cached;
  const raw = doc.workflows.get(workflowId);
  if (!raw) throw new Error(`workflow '${workflowId}' is not defined in ${doc.location}`);
  const workflowKey = `${doc.location}#${workflowId}`;
  const def: WorkflowDef = {
    doc,
    workflowId,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    raw,
    steps: [],
    outputs: raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {},
    dependsOn: [],
    dependsOnErrors: [],
    x: normalizeExtension(raw['x-spectest']),
    warnings: [],
  };
  perDoc.set(workflowId, def);

  if (raw.inputs !== undefined) {
    try {
      def.inputsSchema = resolveRefs(raw.inputs, doc.doc);
    } catch (error) {
      def.inputsSchemaError = `could not resolve the inputs schema of workflow '${workflowId}': ${(error as Error).message}`;
    }
  }
  for (const reference of Array.isArray(raw.dependsOn) ? raw.dependsOn : []) {
    try {
      def.dependsOn.push(resolveWorkflowReference(doc, String(reference)));
    } catch (error) {
      def.dependsOnErrors.push((error as Error).message);
    }
  }

  let workflowParams: ParamDef[] = [];
  let workflowSuccess: ActionDef[] = [];
  let workflowFailure: ActionDef[] = [];
  let workflowLevelError: string | undefined;
  try {
    workflowParams = Array.isArray(raw.parameters) ? raw.parameters.map((p: any) => normalizeParameter(doc, p)) : [];
    workflowSuccess = Array.isArray(raw.successActions)
      ? raw.successActions.map((a: any, i: number) => normalizeAction(doc, a, 'success', `${workflowKey}/successActions/${i}`))
      : [];
    workflowFailure = Array.isArray(raw.failureActions)
      ? raw.failureActions.map((a: any, i: number) => normalizeAction(doc, a, 'failure', `${workflowKey}/failureActions/${i}`))
      : [];
  } catch (error) {
    workflowLevelError = (error as Error).message;
  }

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  def.steps = rawSteps.map((s: any, i: number) => normalizeStep(doc, s, i, workflowParams, workflowSuccess, workflowFailure, workflowKey));
  if (workflowLevelError) {
    for (const step of def.steps) step.error = step.error || workflowLevelError;
  }
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.stepId)) step.error = step.error || `duplicate stepId '${step.stepId}'`;
    seen.add(step.stepId);
    for (const action of [...step.onSuccess, ...step.onFailure]) {
      if (action.stepId && !def.steps.some((s) => s.stepId === action.stepId)) {
        step.error = step.error || `action '${action.name}' of step '${step.stepId}' targets unknown step '${action.stepId}'`;
      }
    }
    def.warnings.push(...(step.parameterWarnings || []));
    lintExpressions(step.raw?.parameters, `step '${step.stepId}' parameters`, def.warnings);
    lintExpressions(step.raw?.requestBody, `step '${step.stepId}' requestBody`, def.warnings);
    lintExpressions(step.outputs, `step '${step.stepId}' outputs`, def.warnings);
  }
  if (rawSteps.length === 0) def.warnings.push(`workflow '${workflowId}' has no steps`);
  lintExpressions(def.outputs, `workflow '${workflowId}' outputs`, def.warnings);
  return def;
}
