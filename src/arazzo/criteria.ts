// Arazzo Criterion Object evaluation: simple conditions (literals, operators,
// runtime expressions), regex, JSONPath and XPath. Per the spec, a criterion
// that cannot be evaluated (syntax error, bad context, ...) fails rather than
// throwing; the error text is kept for the report.
import { RuntimeExpressionError, parseRuntimeExpression, type RuntimeExpression } from '../runtime-expression.js';
import type { CriterionDef } from './model.js';
import { unwrapBraces } from './model.js';
import { JSONPATH_VERSIONS, XPATH_VERSIONS, queryJsonPath, xpathTruthy } from './selectors.js';

export interface ExpressionResolver {
  /** Evaluates a runtime expression; throws for unresolvable references. */
  evaluate(expression: RuntimeExpression): unknown;
  /** Renders a string with embedded `{$expression}` segments. */
  interpolate(template: string): string;
}

export interface CriterionResult {
  pass: boolean;
  /** Human-readable explanation when the criterion failed. */
  message?: string;
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'lit'; value: boolean | null }
  | { kind: 'expr'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'eof' };

type Node =
  | { type: 'literal'; value: unknown }
  | { type: 'expr'; raw: string; expression: RuntimeExpression }
  | { type: 'not'; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }
  | { type: 'index'; target: Node; index: Node }
  | { type: 'prop'; target: Node; name: string };

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', '[', ']', '.'];
// Characters that end a runtime-expression token inside a condition.
const EXPRESSION_STOP = /[\s()[\]=!<>&|,]/;

export class ConditionSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionSyntaxError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && !EXPRESSION_STOP.test(source[j])) j += 1;
      tokens.push({ kind: 'expr', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Arazzo strings use single quotes with '' as the escape; double quotes are accepted too.
      let j = i + 1;
      let text = '';
      while (j < source.length) {
        if (source[j] === ch) {
          if (source[j + 1] === ch) {
            text += ch;
            j += 2;
            continue;
          }
          break;
        }
        text += source[j];
        j += 1;
      }
      if (j >= source.length) throw new ConditionSyntaxError(`unterminated string starting at position ${i}`);
      tokens.push({ kind: 'str', value: text });
      i = j + 1;
      continue;
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number && (ch !== '-' || tokens.length === 0 || tokens[tokens.length - 1].kind === 'op')) {
      tokens.push({ kind: 'num', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
    if (word) {
      const value = word[0];
      if (value === 'true' || value === 'false') tokens.push({ kind: 'lit', value: value === 'true' });
      else if (value === 'null') tokens.push({ kind: 'lit', value: null });
      else tokens.push({ kind: 'ident', value });
      i += value.length;
      continue;
    }
    throw new ConditionSyntaxError(`unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4 };

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectOp(value: string): void {
    const token = this.next();
    if (token.kind !== 'op' || token.value !== value) throw new ConditionSyntaxError(`expected '${value}'`);
  }

  parseAll(): Node {
    const node = this.parse(0);
    if (this.peek().kind !== 'eof') throw new ConditionSyntaxError('unexpected trailing input');
    return node;
  }

  private parse(minPrecedence: number): Node {
    let left = this.parsePostfix(this.parsePrefix());
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !(token.value in BINARY_PRECEDENCE)) break;
      const precedence = BINARY_PRECEDENCE[token.value];
      // Left-associative: stop at operators that bind no tighter than the caller's.
      if (precedence <= minPrecedence) break;
      this.next();
      const right = this.parse(precedence);
      left = { type: 'binary', op: token.value, left, right };
    }
    return left;
  }

  private parsePrefix(): Node {
    const token = this.next();
    switch (token.kind) {
      case 'num':
      case 'str':
      case 'lit':
        return { type: 'literal', value: token.value };
      case 'expr': {
        try {
          return { type: 'expr', raw: token.value, expression: parseRuntimeExpression(token.value) };
        } catch (error) {
          throw new ConditionSyntaxError((error as Error).message);
        }
      }
      case 'op':
        if (token.value === '!') return { type: 'not', operand: this.parsePostfix(this.parsePrefix()) };
        if (token.value === '(') {
          const inner = this.parse(0);
          this.expectOp(')');
          return inner;
        }
        throw new ConditionSyntaxError(`unexpected '${token.value}'`);
      case 'ident':
        throw new ConditionSyntaxError(`unexpected identifier '${token.value}' (strings need single quotes)`);
      default:
        throw new ConditionSyntaxError('unexpected end of condition');
    }
  }

  private parsePostfix(node: Node): Node {
    for (;;) {
      const token = this.peek();
      if (token.kind === 'op' && token.value === '[') {
        this.next();
        const index = this.parse(0);
        this.expectOp(']');
        node = { type: 'index', target: node, index };
        continue;
      }
      if (token.kind === 'op' && token.value === '.') {
        this.next();
        const name = this.next();
        if (name.kind !== 'ident' && name.kind !== 'num') throw new ConditionSyntaxError("expected a property name after '.'");
        node = { type: 'prop', target: node, name: String(name.value) };
        continue;
      }
      return node;
    }
  }
}

export function parseCondition(source: string): Node {
  return new Parser(tokenize(source)).parseAll();
}

function normalize(value: unknown): unknown {
  return value === undefined ? null : value;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left === null || right === null) return left === right;
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  if (typeof left === 'number' || typeof right === 'number') {
    const l = asNumber(left);
    const r = asNumber(right);
    if (l !== undefined && r !== undefined) return l === r;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }
  if (typeof left === 'object' && typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left === null || right === null) return false;
  const l = asNumber(left);
  const r = asNumber(right);
  let order: number;
  if (l !== undefined && r !== undefined) order = l - r;
  else if (typeof left === 'string' && typeof right === 'string') order = left.toLowerCase().localeCompare(right.toLowerCase());
  else return false;
  switch (op) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    default:
      return order >= 0;
  }
}

export function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

function evaluateNode(node: Node, resolver: ExpressionResolver, seen: Map<string, unknown>): unknown {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'expr': {
      const value = resolver.evaluate(node.expression);
      seen.set(node.raw, value);
      return value;
    }
    case 'not':
      return !truthy(evaluateNode(node.operand, resolver, seen));
    case 'index': {
      const target: any = evaluateNode(node.target, resolver, seen);
      const index: any = evaluateNode(node.index, resolver, seen);
      return target === null || target === undefined ? undefined : target[index];
    }
    case 'prop': {
      const target: any = evaluateNode(node.target, resolver, seen);
      return target === null || target === undefined || typeof target !== 'object' ? undefined : target[node.name];
    }
    case 'binary': {
      if (node.op === '&&') return truthy(evaluateNode(node.left, resolver, seen)) && truthy(evaluateNode(node.right, resolver, seen));
      if (node.op === '||') return truthy(evaluateNode(node.left, resolver, seen)) || truthy(evaluateNode(node.right, resolver, seen));
      const left = evaluateNode(node.left, resolver, seen);
      const right = evaluateNode(node.right, resolver, seen);
      if (node.op === '==') return looseEquals(left, right);
      if (node.op === '!=') return !looseEquals(left, right);
      return compare(node.op, left, right);
    }
  }
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  const json = JSON.stringify(value);
  return json && json.length > 80 ? `${json.slice(0, 77)}...` : String(json);
}

export function evaluateSimpleCondition(condition: string, resolver: ExpressionResolver): CriterionResult {
  const source = unwrapBraces(condition);
  const seen = new Map<string, unknown>();
  try {
    const value = evaluateNode(parseCondition(source), resolver, seen);
    if (truthy(value)) return { pass: true };
    const values = [...seen.entries()].map(([raw, v]) => `${raw} = ${show(v)}`).join(', ');
    return { pass: false, message: `${source}${values ? ` (${values})` : ''}` };
  } catch (error) {
    const kind = error instanceof ConditionSyntaxError ? 'invalid condition' : 'could not evaluate';
    return { pass: false, message: `${source} (${kind}: ${(error as Error).message})` };
  }
}

function contextValue(criterion: CriterionDef, resolver: ExpressionResolver): unknown {
  if (!criterion.context) throw new Error(`a ${criterion.type} criterion needs a context`);
  const context = unwrapBraces(criterion.context);
  return resolver.evaluate(parseRuntimeExpression(context));
}

export async function evaluateCriterion(criterion: CriterionDef, resolver: ExpressionResolver): Promise<CriterionResult> {
  const type = criterion.type || 'simple';
  if (type === 'simple') {
    return evaluateSimpleCondition(criterion.condition, resolver);
  }
  const label = `${type} '${criterion.condition}' on ${criterion.context ?? '(no context)'}`;
  try {
    const context = contextValue(criterion, resolver);
    if (context === null || context === undefined) return { pass: false, message: `${label} (context is ${String(context)})` };
    const condition = resolver.interpolate(criterion.condition);
    if (type === 'regex') {
      const text = typeof context === 'string' ? context : typeof context === 'object' ? JSON.stringify(context) : String(context);
      return new RegExp(condition).test(text) ? { pass: true } : { pass: false, message: `${label} did not match ${show(text)}` };
    }
    if (type === 'jsonpath') {
      if (criterion.version && !JSONPATH_VERSIONS.includes(criterion.version)) throw new Error(`unsupported JSONPath version '${criterion.version}'`);
      const matches = queryJsonPath(context, condition, criterion.version);
      return matches.length > 0 ? { pass: true } : { pass: false, message: `${label} matched no nodes` };
    }
    if (type === 'xpath') {
      if (criterion.version && !XPATH_VERSIONS.includes(criterion.version)) throw new Error(`unsupported XPath version '${criterion.version}'`);
      return (await xpathTruthy(context, condition, criterion.version)) ? { pass: true } : { pass: false, message: `${label} was false` };
    }
    return { pass: false, message: `unsupported criterion type '${type}'` };
  } catch (error) {
    const reason = error instanceof RuntimeExpressionError ? error.message : (error as Error)?.message || String(error);
    return { pass: false, message: `${label} (could not evaluate: ${reason})` };
  }
}

/** Evaluates every criterion (logical AND); returns the failure messages. */
export async function evaluateCriteria(criteria: CriterionDef[], resolver: ExpressionResolver): Promise<string[]> {
  const failures: string[] = [];
  for (const criterion of criteria) {
    const result = await evaluateCriterion(criterion, resolver);
    if (!result.pass) failures.push(`criterion failed: ${result.message}`);
  }
  return failures;
}
