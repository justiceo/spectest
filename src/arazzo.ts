// `spectest/arazzo`: run an Arazzo document from a regular `.spectest.js` suite.
//
// Files written by `spectest generate arazzo-tests` call loadArazzoRuntime() and
// spread `arazzo.hooks(operationId)` into each test. The Arazzo document stays the
// source of truth for requests, criteria and control flow; the generated file only
// carries editable presentation fields (name, tags, timeout, skip, ...).
import path from 'path';
import { fileURLToPath } from 'url';
import { compileArazzo, type CompiledArazzo } from './arazzo/compile.js';
import { loadConfigFromCliOpts } from './config.js';
import type { Suite, TestCase } from './types.js';

export interface ArazzoRuntime {
  suite: Suite;
  tests: TestCase[];
  /** Run-time fields (gating, request building, assertions, retries) for one compiled node. */
  hooks(operationId: string): Partial<TestCase>;
}

const RUNTIME_FIELDS: (keyof TestCase)[] = ['when', 'beforeSend', 'assert', 'retry', 'virtual', 'quiet', 'postTest', 'source', 'response'];

const loaded = new Map<string, Promise<CompiledArazzo>>();

/** Documents loaded through this helper; the CLI won't also run them as discovered `*.arazzo.*` files. */
export function claimedArazzoDocuments(): Set<string> {
  const g = globalThis as any;
  g.__SPECTEST_ARAZZO_CLAIMED__ ??= new Set<string>();
  return g.__SPECTEST_ARAZZO_CLAIMED__;
}

export async function loadArazzoRuntime(document: string | URL, overrides: Record<string, unknown> = {}): Promise<ArazzoRuntime> {
  const file = document instanceof URL || String(document).startsWith('file:') ? fileURLToPath(document) : path.resolve(String(document));
  claimedArazzoDocuments().add(file);
  if (!loaded.has(file)) {
    loaded.set(
      file,
      (async () => {
        const base = (globalThis as any).__SPECTEST_CONFIG__ || (await loadConfigFromCliOpts({}));
        return compileArazzo(file, { ...base, ...overrides });
      })()
    );
  }
  const compiled = await loaded.get(file)!;
  const byId = new Map(compiled.tests.map((test) => [test.operationId!, test]));
  return {
    suite: compiled.suite,
    tests: compiled.tests,
    hooks(operationId: string) {
      const test = byId.get(operationId);
      if (!test) {
        throw new Error(`Arazzo document ${file} has no step node '${operationId}' (was the file regenerated after the document changed?)`);
      }
      const fields: Partial<TestCase> = {};
      for (const key of RUNTIME_FIELDS) {
        if (test[key] !== undefined) (fields as any)[key] = test[key];
      }
      return fields;
    },
  };
}
