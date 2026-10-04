// Compiles an Arazzo document into Spectest TestCases.
//
// Every top-level workflow becomes one linear dependsOn chain:
//
//   [iteration 1: step nodes (sub-workflow steps inlined, then a join node),
//                 goto/retry-workflow blocks]
//   [iteration 2..N: the same, only for workflows that can jump backwards]
//   terminal "workflow" node (its result data = the workflow outputs)
//
// Each node gates itself with `when` on the scope's flow cursor (runtime.ts), so
// the chain implements Arazzo's control flow (default next step, end, goto,
// retry) while every executed step still shows up as an ordinary test result.
import path from 'path';
import { readFile } from 'fs/promises';
import { OpenApiSkip, applySecurity, effectiveServerPrefix, resolveGeneratorPlaceholders } from '../openapi/document.js';
import { exchangeFromResult } from '../runtime-expression.js';
import type { OpenApiBeforeSendHook, OpenApiPostTestHook, SpectestConfig, Suite, TestCase } from '../types.js';
import { loadArazzoDocument, parseText, type ArazzoDocument, type DocumentCache } from './document.js';
import { getWorkflow, normalizeExtension, resolveWorkflowReference, type ActionDef, type SpectestExtension, type StepDef, type WorkflowDef, type WorkflowRef } from './model.js';
import {
  applyPendingDelay,
  baseUrlFor,
  buildRequest,
  computeWorkflowOutputs,
  decideStep,
  finishBlock,
  gateBlock,
  gateStep,
  getFlow,
  nodeKey,
  schemaDefaults,
  toTestResponse,
  topScopeKey,
  validateInputs,
  type Block,
  type Program,
  type Scope,
  type StaticRequest,
} from './runtime.js';

const DEFAULT_MAX_ITERATIONS = 10;
const MAX_DEPTH = 8;
const MAX_NODES_PER_WORKFLOW = 5000;

class CompileSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileSkip';
  }
}

export interface CompiledArazzo {
  suite: Suite;
  program: Program;
  tests: TestCase[];
}

function mergeExtensions(...layers: SpectestExtension[]): SpectestExtension {
  const merged: SpectestExtension = {};
  const tags: string[] = [];
  for (const layer of layers) {
    Object.assign(merged, layer);
    if (layer.tags) tags.push(...layer.tags);
  }
  if (tags.length) merged.tags = [...new Set(tags)];
  return merged;
}

// ---------------------------------------------------------------------------
// Inputs

let inputsFileCache: { file: string; data: Promise<any> } | undefined;

async function inputsFromFile(cfg: SpectestConfig): Promise<Record<string, any>> {
  if (!cfg.arazzoInputsFile) return {};
  const file = path.resolve(cfg.projectRoot || process.cwd(), cfg.arazzoInputsFile);
  if (!inputsFileCache || inputsFileCache.file !== file) {
    inputsFileCache = { file, data: readFile(file, 'utf8').then((raw) => parseText(raw, file)) };
  }
  const data = await inputsFileCache.data;
  return data && typeof data === 'object' ? data : {};
}

async function topLevelInputs(workflow: WorkflowDef, cfg: SpectestConfig, x: SpectestExtension): Promise<{ values: Record<string, unknown>; error?: string }> {
  const fromFile = (await inputsFromFile(cfg))[workflow.workflowId];
  let configured: Record<string, unknown> | undefined;
  try {
    configured =
      typeof cfg.arazzoInputs === 'function'
        ? cfg.arazzoInputs(workflow.workflowId, { file: workflow.doc.location, title: workflow.doc.title })
        : cfg.arazzoInputs?.[workflow.workflowId];
  } catch (error) {
    return { values: {}, error: `arazzoInputs threw for workflow '${workflow.workflowId}': ${(error as Error).message}` };
  }
  const values = resolveGeneratorPlaceholders({
    ...schemaDefaults(workflow.inputsSchema),
    ...(x.inputs || {}),
    ...(configured || {}),
    ...(fromFile || {}),
  }) as Record<string, unknown>;
  const problems = validateInputs(values, workflow.inputsSchema);
  if (problems.length) {
    return { values, error: `invalid inputs for workflow '${workflow.workflowId}': ${problems.join('; ')} (provide them via arazzoInputs or --arazzo-inputs)` };
  }
  return { values };
}

// ---------------------------------------------------------------------------
// Static analysis

/** True when the workflow can revisit a step (backward goto, retry-with-target, or retrying a sub-workflow step). */
function needsIterations(workflow: WorkflowDef): boolean {
  return workflow.steps.some((step) =>
    [...step.onSuccess, ...step.onFailure].some((action) => {
      if (action.type === 'retry') return Boolean(action.stepId || action.workflow || step.kind === 'workflow');
      if (action.type === 'goto' && action.stepId) {
        const target = workflow.steps.findIndex((s) => s.stepId === action.stepId);
        return target !== -1 && target <= step.index;
      }
      return false;
    })
  );
}

function blockActionsOf(workflow: WorkflowDef): ActionDef[] {
  const unique = new Map<string, ActionDef>();
  for (const step of workflow.steps) {
    for (const action of [...step.onSuccess, ...step.onFailure]) {
      if (action.workflow && !unique.has(action.key)) unique.set(action.key, action);
    }
  }
  return [...unique.values()];
}

function plainRetryBudget(step: StepDef): number {
  if (step.kind !== 'operation') return 0;
  return step.onFailure.filter((a) => a.type === 'retry' && !a.stepId && !a.workflow).reduce((sum, a) => sum + (a.retryLimit ?? 1), 0);
}

/** Collects static errors for a workflow and everything it can invoke (sub-workflows, goto targets). */
function staticErrors(workflow: WorkflowDef, cfg: SpectestConfig, seen = new Set<string>(), depth = 0): string[] {
  const key = topScopeKey(workflow.doc, workflow.workflowId);
  if (seen.has(key)) return [];
  seen.add(key);
  if (depth > MAX_DEPTH) return [`workflows nest deeper than ${MAX_DEPTH} levels`];
  const errors: string[] = [];
  if (workflow.inputsSchemaError) errors.push(workflow.inputsSchemaError);
  for (const step of workflow.steps) {
    if (step.error) errors.push(`step '${step.stepId}': ${step.error}`);
    const x = step.x;
    for (const hook of ['beforeSend', 'postTest'] as const) {
      const name = x[hook] || workflow.x[hook];
      if (name && !cfg.openapiHooks?.[name]?.[hook]) errors.push(`step '${step.stepId}': missing openapiHooks entry '${name}' for ${hook}`);
    }
    const nested: WorkflowRef[] = [];
    if (step.workflow) nested.push(step.workflow);
    for (const action of [...step.onSuccess, ...step.onFailure]) if (action.workflow) nested.push(action.workflow);
    for (const ref of nested) {
      try {
        const child = getWorkflow(ref.doc, ref.workflowId);
        for (const error of staticErrors(child, cfg, seen, depth + 1)) errors.push(`sub-workflow '${child.workflowId}': ${error}`);
      } catch (error) {
        errors.push(`step '${step.stepId}': ${(error as Error).message}`);
      }
    }
  }
  return errors;
}

const WORKFLOW_REFERENCE = /\$workflows\.([A-Za-z0-9_\-.]+?)\.(?:inputs|outputs)\./g;

/** Workflows this top-level workflow must wait for: explicit dependsOn, `$workflows.X` references, 1.1 step dependsOn. */
function workflowDependencies(workflow: WorkflowDef): { refs: WorkflowRef[]; errors: string[] } {
  const refs = [...workflow.dependsOn];
  const errors = [...workflow.dependsOnErrors];
  const visited = new Set<string>();
  const visit = (wf: WorkflowDef) => {
    const key = topScopeKey(wf.doc, wf.workflowId);
    if (visited.has(key)) return;
    visited.add(key);
    const text = JSON.stringify(wf.raw);
    for (const match of text.matchAll(WORKFLOW_REFERENCE)) {
      if (wf.doc.workflows.has(match[1]) && match[1] !== workflow.workflowId) refs.push({ doc: wf.doc, workflowId: match[1] });
    }
    for (const step of wf.steps) {
      for (const dep of step.dependsOn) {
        const cross = /^\$workflows\.([^.]+)\.steps\./.exec(dep);
        if (cross) {
          if (wf.doc.workflows.has(cross[1])) refs.push({ doc: wf.doc, workflowId: cross[1] });
          else errors.push(`step '${step.stepId}' depends on unknown workflow '${cross[1]}'`);
        } else if (dep.startsWith('$sourceDescriptions.')) {
          try {
            refs.push(resolveWorkflowReference(wf.doc, dep));
          } catch (error) {
            errors.push((error as Error).message);
          }
        } else if (!wf.steps.some((s) => s.stepId === dep)) {
          errors.push(`step '${step.stepId}' depends on unknown step '${dep}'`);
        }
      }
      const children: WorkflowRef[] = [];
      if (step.workflow) children.push(step.workflow);
      for (const action of [...step.onSuccess, ...step.onFailure]) if (action.workflow) children.push(action.workflow);
      for (const child of children) {
        try {
          visit(getWorkflow(child.doc, child.workflowId));
        } catch {
          // reported by staticErrors
        }
      }
    }
  };
  visit(workflow);
  const unique = new Map<string, WorkflowRef>();
  for (const ref of refs) {
    const key = topScopeKey(ref.doc, ref.workflowId);
    if (key !== topScopeKey(workflow.doc, workflow.workflowId)) unique.set(key, ref);
  }
  return { refs: [...unique.values()], errors };
}

// ---------------------------------------------------------------------------
// Emission

interface PlannedTop {
  scope: Scope;
  deps: Scope[];
  skipReason?: string;
}

interface Emitter {
  program: Program;
  tests: TestCase[];
  suiteName: string;
  top: Scope;
  firstDeps: string[];
  firstNodePending: boolean;
  count: number;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'action';
}

function nodeIdFor(scope: Scope, round: number, step: StepDef): string {
  return `${scope.id}/${step.stepId}${round > 1 ? `#${round}` : ''}`;
}

function nodeLabel(scope: Scope, round: number, step: StepDef): string {
  return `${scope.label} › ${step.stepId}${round > 1 ? ` (iteration ${round})` : ''}`;
}

function scopeIsQuiet(scope: Scope): boolean {
  return Boolean(scope.parent);
}

function baseTags(top: Scope, extra?: string[]): string[] {
  return [...new Set(['arazzo', `arazzo:${top.entryWorkflowId}`, ...(top.x.tags || []), ...(extra || [])])];
}

function sourceMeta(em: Emitter, scope: Scope, extra: Record<string, unknown>) {
  return {
    kind: 'arazzo',
    file: em.program.file,
    group: em.top.group,
    entryWorkflowId: em.top.entryWorkflowId,
    workflowId: scope.workflow.workflowId,
    ...extra,
  };
}

function push(em: Emitter, test: TestCase, prev: string | undefined): string {
  em.count += 1;
  if (em.count > MAX_NODES_PER_WORKFLOW) {
    throw new CompileSkip(`workflow expands to more than ${MAX_NODES_PER_WORKFLOW} nodes; lower x-spectest.maxIterations`);
  }
  const deps = [...(prev ? [prev] : []), ...(em.firstNodePending ? em.firstDeps : [])];
  em.firstNodePending = false;
  if (deps.length) test.dependsOn = deps;
  test.suiteName = em.suiteName;
  test.phase = em.top.phase;
  em.tests.push(test);
  return test.operationId!;
}

function makeScope(program: Program, init: Omit<Scope, 'program' | 'nodes' | 'childScopes' | 'blocks' | 'blockActions' | 'rounds'> & { rounds?: number }): Scope {
  const workflow = init.workflow;
  const maxIterations = workflow.x.maxIterations || init.x.maxIterations || program.cfg.arazzoMaxIterations || DEFAULT_MAX_ITERATIONS;
  const scope: Scope = {
    ...init,
    program,
    rounds: init.rounds ?? (needsIterations(workflow) ? Math.max(1, maxIterations) : 1),
    nodes: new Map(),
    childScopes: new Map(),
    blocks: new Map(),
    blockActions: blockActionsOf(workflow),
  };
  program.scopes.set(scope.id, scope);
  return scope;
}

async function staticRequestFor(scope: Scope, step: StepDef, cfg: SpectestConfig): Promise<StaticRequest> {
  const op = step.operation!;
  const openapiDoc = op.source.openapi!.doc;
  let prefix = '';
  try {
    prefix = effectiveServerPrefix(openapiDoc, op.operation, op.source.override?.server);
  } catch (error) {
    throw new CompileSkip(`step '${step.stepId}': ${(error as Error).message}`);
  }
  const base = op.source.override?.baseUrl ? op.source.override.baseUrl.replace(/\/$/, '') : '';
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  const security = step.x.security ?? scope.x.security;
  if (security !== undefined) {
    try {
      const override = security === 'none' ? ({ mode: 'none' } as const) : security === 'default' || security === 'true' ? undefined : ({ mode: 'variant', variant: security } as const);
      await applySecurity(cfg, openapiDoc, op.operation, op.entry.method, op.entry.pathKey, headers, query, {}, override);
    } catch (error) {
      const reason = error instanceof OpenApiSkip ? error.message : String((error as Error).message);
      throw new CompileSkip(`step '${step.stepId}': ${reason}`);
    }
  }
  return { method: op.entry.method.toUpperCase(), urlTemplate: `${base}${prefix}${op.entry.pathKey}`, headers, query };
}

async function emitHttpNode(em: Emitter, scope: Scope, round: number, step: StepDef, prev: string | undefined): Promise<string> {
  const cfg = em.program.cfg;
  const id = nodeIdFor(scope, round, step);
  const staticRequest = await staticRequestFor(scope, step, cfg);
  const x = mergeExtensions(scope.x, step.x);
  const userBeforeSend: OpenApiBeforeSendHook | undefined = x.beforeSend ? cfg.openapiHooks?.[x.beforeSend]?.beforeSend : undefined;
  const userPostTest: OpenApiPostTestHook | undefined = x.postTest ? cfg.openapiHooks?.[x.postTest]?.postTest : undefined;
  const baseUrl = baseUrlFor(scope, step);
  const budget = plainRetryBudget(step);
  const index = step.index;
  scope.nodes.set(nodeKey(round, index), id);
  const test: TestCase = {
    name: nodeLabel(scope, round, step),
    operationId: id,
    endpoint: staticRequest.urlTemplate,
    tags: baseTags(em.top, step.x.tags),
    request: { method: staticRequest.method, headers: { ...staticRequest.headers } },
    response: {},
    when: (state) => gateStep(scope, round, index, id, state, { http: true }),
    beforeSend: async (_config: any, state: any) => {
      const flow = getFlow(scope, state);
      if (flow?.inputsError) throw new Error(flow.inputsError);
      await applyPendingDelay(id, state);
      let built = await buildRequest(scope, step, staticRequest, { scope, state });
      if (userBeforeSend) built = (await userBeforeSend(built, state)) || built;
      return built;
    },
    assert: async (response, state, ctx) => {
      const exchange = exchangeFromResult({ request: ctx.request, response: { status: response.status, headers: response.headers, data: response.data } }, baseUrl);
      return decideStep(
        { scope, round, index, nodeId: id, exchange, response: toTestResponse(response), scratch: ctx.scratch, isWorkflowStep: false },
        state
      );
    },
    source: sourceMeta(em, scope, {
      stepId: step.stepId,
      round,
      node: 'step',
      sourceName: step.operation!.source.name,
      sourceLocation: step.operation!.source.location,
      sourceOperationId: step.operation!.entry.operationId,
      method: step.operation!.entry.method,
      path: step.operation!.entry.pathKey,
    }),
  };
  if (scopeIsQuiet(scope) || round > 1) test.quiet = true;
  if (budget > 0) test.retry = { limit: budget, shouldRetry: () => false };
  const timeout = step.timeout ?? x.timeout;
  if (timeout) test.timeout = timeout;
  if (x.delay) test.delay = x.delay;
  if (x.recording) test.recording = x.recording;
  if (userPostTest) test.postTest = userPostTest;
  return push(em, test, prev);
}

function childOutputsReader(child: Scope, values: Record<string, unknown>, errors: Record<string, string>) {
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    if (errors[name]) throw new Error(`output '${name}' of workflow '${child.workflow.workflowId}' could not be evaluated: ${errors[name]}`);
    throw new Error(`workflow '${child.workflow.workflowId}' has no output '${name}'`);
  };
}

async function emitWorkflowStep(em: Emitter, scope: Scope, round: number, step: StepDef, prev: string | undefined): Promise<string> {
  const id = nodeIdFor(scope, round, step);
  if (scope.depth + 1 > MAX_DEPTH) throw new CompileSkip(`workflows nest deeper than ${MAX_DEPTH} levels (at step '${step.stepId}')`);
  const workflow = getWorkflow(step.workflow!.doc, step.workflow!.workflowId);
  const child = makeScope(em.program, {
    id,
    label: nodeLabel(scope, round, step),
    workflow,
    parent: { scope, anchor: { kind: 'step', round, index: step.index } },
    phase: scope.phase,
    group: scope.group,
    entryWorkflowId: scope.entryWorkflowId,
    inputs: { kind: 'params', params: step.parameters, schema: workflow.inputsSchema, trigger: 'parent' },
    deferFailures: step.onFailure.length > 0,
    depth: scope.depth + 1,
    x: mergeExtensions(normalizeExtension(workflow.doc.doc['x-spectest']), workflow.x),
  });
  scope.childScopes.set(nodeKey(round, step.index), child);
  const last = await emitScope(em, child, prev);
  scope.nodes.set(nodeKey(round, step.index), id);
  const index = step.index;
  const baseUrl = baseUrlFor(scope);
  const test: TestCase = {
    name: nodeLabel(scope, round, step),
    operationId: id,
    endpoint: '',
    virtual: true,
    tags: baseTags(em.top, step.x.tags),
    when: (state) => gateStep(scope, round, index, id, state, { http: false }),
    assert: async (_response, state) => {
      const childFlow = getFlow(child, state);
      const outputs = await computeWorkflowOutputs(child, state);
      const lastResult = childFlow?.lastExchange ? state.completedCases?.[childFlow.lastExchange] : undefined;
      const prior = childFlow?.outcome === 'failed' ? [`workflow '${workflow.workflowId}' failed (${childFlow.failure})`] : [];
      const outcome = await decideStep(
        {
          scope,
          round,
          index,
          nodeId: id,
          exchange: lastResult ? exchangeFromResult(lastResult, baseUrl) : undefined,
          response: lastResult ? { status: lastResult.response.status, headers: lastResult.response.headers, body: lastResult.response.data } : undefined,
          priorErrors: prior,
          outputs: childOutputsReader(child, outputs.values, outputs.errors),
          isWorkflowStep: true,
        },
        state
      );
      const normalized = Array.isArray(outcome) ? { errors: outcome } : outcome || {};
      return { ...normalized, data: outputs.values };
    },
    source: sourceMeta(em, scope, { stepId: step.stepId, round, node: 'workflow-step', calls: workflow.workflowId }),
  };
  if (scopeIsQuiet(scope) || round > 1) test.quiet = true;
  return push(em, test, last);
}

async function emitBlock(em: Emitter, scope: Scope, round: number, action: ActionDef, ordinal: number, prev: string | undefined): Promise<string> {
  const workflow = getWorkflow(action.workflow!.doc, action.workflow!.workflowId);
  if (scope.depth + 1 > MAX_DEPTH) throw new CompileSkip(`workflows nest deeper than ${MAX_DEPTH} levels (via action '${action.name}')`);
  const id = `${scope.id}!${ordinal}-${slug(action.name)}${round > 1 ? `#${round}` : ''}`;
  const blockScope = makeScope(em.program, {
    id,
    label: `${scope.label} ⇢ ${workflow.workflowId}${round > 1 ? ` (iteration ${round})` : ''}`,
    workflow,
    parent: { scope, anchor: { kind: 'block', round, key: action.key } },
    phase: scope.phase,
    group: scope.group,
    entryWorkflowId: scope.entryWorkflowId,
    inputs: { kind: 'params', params: action.parameters, schema: workflow.inputsSchema, trigger: 'block' },
    deferFailures: false,
    depth: scope.depth + 1,
    x: mergeExtensions(normalizeExtension(workflow.doc.doc['x-spectest']), workflow.x),
  });
  const block: Block = { key: action.key, round, action, scope: blockScope, joinId: id };
  scope.blocks.set(`${round}:${action.key}`, block);
  const last = await emitScope(em, blockScope, prev);
  const test: TestCase = {
    name: `${blockScope.label} (via ${action.kind === 'success' ? 'onSuccess' : 'onFailure'} '${action.name}')`,
    operationId: id,
    endpoint: '',
    virtual: true,
    quiet: true,
    tags: baseTags(em.top),
    when: (state) => gateBlock(scope, round, action.key, state),
    assert: async (_response, state) => {
      const outputs = await computeWorkflowOutputs(blockScope, state);
      const outcome = finishBlock(scope, round, block, state);
      const normalized = Array.isArray(outcome) ? { errors: outcome } : outcome || {};
      return { ...normalized, data: outputs.values };
    },
    source: sourceMeta(em, scope, { round, node: 'block', action: action.name, calls: workflow.workflowId }),
  };
  return push(em, test, last);
}

async function emitScope(em: Emitter, scope: Scope, prev: string | undefined): Promise<string | undefined> {
  let last = prev;
  for (let round = 1; round <= scope.rounds; round += 1) {
    for (const step of scope.workflow.steps) {
      last = step.kind === 'workflow' ? await emitWorkflowStep(em, scope, round, step, last) : await emitHttpNode(em, scope, round, step, last);
    }
    for (const [ordinal, action] of scope.blockActions.entries()) {
      last = await emitBlock(em, scope, round, action, ordinal + 1, last);
    }
  }
  return last;
}

function emitTerminal(em: Emitter, scope: Scope, prev: string | undefined): void {
  const test: TestCase = {
    name: `${scope.label} (workflow)`,
    operationId: scope.id,
    endpoint: '',
    virtual: true,
    tags: baseTags(em.top),
    assert: async (_response, state) => {
      const flow = getFlow(scope, state);
      const outputs = await computeWorkflowOutputs(scope, state);
      const errors = Object.entries(outputs.errors).map(([name, error]) => `output '${name}': ${error}`);
      const transition = flow?.lastTransition;
      return { errors, data: outputs.values, ...(transition && !/^workflow completed/.test(transition) ? { note: transition } : {}) };
    },
    source: sourceMeta(em, scope, { node: 'workflow' }),
  };
  push(em, test, prev);
}

function emitSkipped(em: Emitter, scope: Scope, reason: string): void {
  for (const step of scope.workflow.steps) {
    const own = step.error ? `${step.error}` : reason;
    push(
      em,
      {
        name: nodeLabel(scope, 1, step),
        operationId: nodeIdFor(scope, 1, step),
        endpoint: step.operation ? step.operation.entry.pathKey : '',
        tags: baseTags(em.top, step.x.tags),
        skip: true,
        skipReason: own,
        source: sourceMeta(em, scope, { stepId: step.stepId, round: 1, node: 'step' }),
      },
      undefined
    );
  }
  push(
    em,
    {
      name: `${scope.label} (workflow)`,
      operationId: scope.id,
      endpoint: '',
      virtual: true,
      tags: baseTags(em.top),
      skip: true,
      skipReason: reason,
      source: sourceMeta(em, scope, { node: 'workflow' }),
    },
    undefined
  );
}

function findCycles(planned: PlannedTop[]): Map<Scope, string> {
  const result = new Map<Scope, string>();
  const state = new Map<Scope, 'visiting' | 'done'>();
  const stack: Scope[] = [];
  const byScope = new Map(planned.map((p) => [p.scope, p]));
  const visit = (scope: Scope) => {
    if (state.get(scope) === 'done') return;
    if (state.get(scope) === 'visiting') {
      const cycle = stack.slice(stack.indexOf(scope)).concat(scope);
      const text = cycle.map((s) => s.workflow.workflowId).join(' → ');
      for (const member of cycle) result.set(member, `workflow dependency cycle: ${text}`);
      return;
    }
    state.set(scope, 'visiting');
    stack.push(scope);
    for (const dep of byScope.get(scope)?.deps || []) visit(dep);
    stack.pop();
    state.set(scope, 'done');
  };
  for (const p of planned) visit(p.scope);
  return result;
}

/** Compiles every workflow of the document at `location` into TestCases. */
export async function compileArazzo(location: string, cfg: SpectestConfig = {}, cache: DocumentCache = new Map()): Promise<CompiledArazzo> {
  const doc = await loadArazzoDocument(location, cfg, cache);
  return compileArazzoDocument(doc, cfg);
}

export async function compileArazzoDocument(doc: ArazzoDocument, cfg: SpectestConfig = {}): Promise<CompiledArazzo> {
  const program: Program = { file: doc.location, cfg, doc, scopes: new Map(), topScopes: new Map(), warnings: [...doc.warnings] };
  const docX = normalizeExtension(doc.doc['x-spectest']);
  const suiteName = doc.title;

  // Top-level scopes: every workflow of the entry document, plus external workflows they depend on.
  const queue: WorkflowRef[] = [...doc.workflows.keys()].map((workflowId) => ({ doc, workflowId }));
  const planned: PlannedTop[] = [];
  const pendingDeps = new Map<Scope, WorkflowRef[]>();
  while (queue.length > 0) {
    const ref = queue.shift()!;
    const key = topScopeKey(ref.doc, ref.workflowId);
    if (program.topScopes.has(key)) continue;
    const workflow = getWorkflow(ref.doc, ref.workflowId);
    const external = ref.doc !== doc;
    const sourceName = external ? [...doc.sources.values()].find((s) => s.arazzo === ref.doc)?.name : undefined;
    const refDocX = external ? normalizeExtension(ref.doc.doc['x-spectest']) : docX;
    const x = mergeExtensions(refDocX, workflow.x);
    const idPrefix = docX.idPrefix || '';
    const id = `${idPrefix}${sourceName ? `${sourceName}.` : ''}${workflow.workflowId}`;
    const inputs = await topLevelInputs(workflow, cfg, x);
    const scope = makeScope(program, {
      id,
      label: sourceName ? `${sourceName}.${workflow.workflowId}` : workflow.workflowId,
      workflow,
      phase: x.phase || 'main',
      group: id,
      entryWorkflowId: workflow.workflowId,
      inputs: { kind: 'static', values: inputs.values },
      deferFailures: false,
      depth: 0,
      x,
    });
    program.topScopes.set(key, scope);
    const deps = workflowDependencies(workflow);
    pendingDeps.set(scope, deps.refs);
    for (const dep of deps.refs) queue.push(dep);
    const errors = [...staticErrors(workflow, cfg), ...deps.errors];
    if (inputs.error) errors.push(inputs.error);
    for (const warning of workflow.warnings) program.warnings.push(`${workflow.workflowId}: ${warning}`);
    let skipReason: string | undefined;
    if (x.skip) skipReason = x.skipReason || 'skipped via x-spectest';
    else if (errors.length) skipReason = errors[0];
    planned.push({ scope, deps: [], skipReason });
  }
  for (const entry of planned) {
    entry.deps = (pendingDeps.get(entry.scope) || []).map((ref) => program.topScopes.get(topScopeKey(ref.doc, ref.workflowId))!).filter(Boolean);
  }
  for (const [scope, reason] of findCycles(planned)) {
    const entry = planned.find((p) => p.scope === scope)!;
    entry.skipReason = entry.skipReason || reason;
  }

  const tests: TestCase[] = [];
  const phaseOrder = { setup: 0, main: 1, teardown: 2 };
  for (const entry of planned) {
    const { scope } = entry;
    const firstDeps: string[] = [];
    for (const dep of entry.deps) {
      if (phaseOrder[dep.phase] === phaseOrder[scope.phase]) firstDeps.push(dep.id);
      else if (phaseOrder[dep.phase] > phaseOrder[scope.phase]) {
        program.warnings.push(`workflow '${scope.workflow.workflowId}' (${scope.phase}) depends on '${dep.workflow.workflowId}', which runs later (${dep.phase})`);
      }
    }
    const em: Emitter = { program, tests: [], suiteName, top: scope, firstDeps, firstNodePending: true, count: 0 };
    if (entry.skipReason) {
      emitSkipped(em, scope, entry.skipReason);
    } else {
      try {
        const last = await emitScope(em, scope, undefined);
        emitTerminal(em, scope, last);
      } catch (error) {
        if (!(error instanceof CompileSkip)) throw error;
        em.tests = [];
        em.count = 0;
        em.firstNodePending = true;
        emitSkipped(em, scope, error.message);
      }
    }
    tests.push(...em.tests);
  }

  const suite: Suite = {
    name: suiteName,
    loadPath: doc.location,
    setup: tests.filter((t) => t.phase === 'setup'),
    tests: tests.filter((t) => t.phase !== 'setup' && t.phase !== 'teardown'),
    teardown: tests.filter((t) => t.phase === 'teardown'),
  };
  return { suite, program, tests };
}

