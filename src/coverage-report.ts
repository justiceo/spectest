import { describeOpenApiOperations } from './plugins/openapi-loader.js';
import type { TestCase, TestResult } from './types.js';

export type CoverageStatus =
  | { kind: 'generated-passed' }
  | { kind: 'generated-failed' }
  | { kind: 'generated-skipped'; reason: string }
  | { kind: 'covered-by-handwritten'; operationId: string }
  | { kind: 'uncovered' };

export interface CoverageRow {
  method: string;
  path: string;
  operationId: string;
  status: CoverageStatus;
}

function hasOpenApiTag(test: TestCase): boolean {
  const tags = Array.isArray(test.tags) ? test.tags : test.tags ? [test.tags] : [];
  return tags.includes('openapi');
}

function pathToRegex(pathTemplate: string): RegExp {
  const pattern = pathTemplate
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

function stripQueryAndOrigin(endpoint: string): string {
  const withoutQuery = endpoint.split('?')[0];
  try {
    return new URL(withoutQuery).pathname;
  } catch {
    return withoutQuery;
  }
}

function findHandwrittenMatch(method: string, pathKey: string, handwrittenTests: TestCase[]): TestCase | undefined {
  const regex = pathToRegex(pathKey);
  return handwrittenTests.find((test) => {
    const testMethod = (test.request?.method || 'GET').toUpperCase();
    if (testMethod !== method.toUpperCase()) return false;
    return regex.test(stripQueryAndOrigin(test.endpoint || ''));
  });
}

export async function buildCoverageReport(
  openapiPath: string,
  allTests: TestCase[],
  results: TestResult[]
): Promise<CoverageRow[]> {
  const operations = await describeOpenApiOperations(openapiPath);
  const generatedTests = allTests.filter(hasOpenApiTag);
  const handwrittenTests = allTests.filter((test) => !hasOpenApiTag(test));

  const resultsByOperationId = new Map<string, TestResult>();
  for (const result of results) {
    if (result.operationId) resultsByOperationId.set(result.operationId, result);
  }
  const testsByOperationId = new Map<string, TestCase>();
  for (const test of generatedTests) {
    if (test.operationId) testsByOperationId.set(test.operationId, test);
  }

  return operations.map((op) => {
    const generatedForOp = op.generatedIds.map((id) => testsByOperationId.get(id)).filter(Boolean) as TestCase[];
    const executed = generatedForOp.filter((t) => !t.skip);

    let status: CoverageStatus;
    if (executed.length > 0) {
      const anyFailed = executed.some((t) => resultsByOperationId.get(t.operationId!)?.status === 'failed');
      status = anyFailed ? { kind: 'generated-failed' } : { kind: 'generated-passed' };
    } else {
      const handwrittenMatch = findHandwrittenMatch(op.method, op.pathKey, handwrittenTests);
      if (handwrittenMatch) {
        status = { kind: 'covered-by-handwritten', operationId: handwrittenMatch.operationId || handwrittenMatch.name };
      } else if (generatedForOp.length > 0) {
        status = { kind: 'generated-skipped', reason: generatedForOp[0].skipReason || 'skipped' };
      } else {
        status = { kind: 'uncovered' };
      }
    }

    return { method: op.method.toUpperCase(), path: op.pathKey, operationId: op.operationId, status };
  });
}

function describeStatus(status: CoverageStatus): string {
  switch (status.kind) {
    case 'generated-passed':
      return 'generated & passed';
    case 'generated-failed':
      return 'generated & failed';
    case 'generated-skipped':
      return `generated & skipped (${status.reason})`;
    case 'covered-by-handwritten':
      return `covered by hand-written test ${status.operationId}`;
    case 'uncovered':
      return 'uncovered';
    default:
      return 'unknown';
  }
}

export function formatCoverageReport(rows: CoverageRow[]): string {
  const methodWidth = Math.max(6, ...rows.map((r) => r.method.length)) + 1;
  const pathWidth = Math.max(4, ...rows.map((r) => r.path.length)) + 1;
  const opWidth = Math.max(11, ...rows.map((r) => r.operationId.length)) + 1;
  const lines = rows.map(
    (row) => `${row.method.padEnd(methodWidth)}${row.path.padEnd(pathWidth)}${row.operationId.padEnd(opWidth)}${describeStatus(row.status)}`
  );
  return lines.join('\n');
}
