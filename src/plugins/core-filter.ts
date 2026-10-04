import { existsSync, readFileSync } from 'fs';
import type { Plugin } from '../plugin-api.js';
import type { SpectestConfig, Suite, TestCase } from '../types.js';

function expandRepeats(tests: TestCase[]) {
  return tests.flatMap((test) => {
    const repeat = Number.isFinite(Number(test.repeat)) ? Number(test.repeat) : 0;
    const bombard = Number.isFinite(Number(test.bombard)) ? Number(test.bombard) : 0;
    const totalRuns = repeat + 1;
    const repeated = Array.from({ length: totalRuns }).map((_, idx) => {
      if (idx === 0) {
        return test;
      }
      const clone = Object.assign(Object.create(Object.getPrototypeOf(test)), test);
      clone.name = `(Run ${idx + 1}) ${test.name}`;
      return clone;
    });

    return repeated.flatMap((t) => {
      const totalBombs = bombard + 1;
      return Array.from({ length: totalBombs }).map((_, bIdx) => {
        if (bIdx === 0) return t;
        const clone = Object.assign(Object.create(Object.getPrototypeOf(t)), t);
        clone.name = `(Bombard ${bIdx + 1}) ${t.name}`;
        return clone;
      });
    });
  });
}

function filterTestsByFocus(tests: TestCase[]) {
  const hasFocus = tests.some((t) => t.focus);
  if (!hasFocus) {
    return tests;
  }
  return tests.filter((t) => {
    return t.phase === 'setup' || t.phase === 'teardown' || t.focus;
  });
}

function filterTestsByTags(tests: TestCase[], tags?: string[]) {
  if (!tags || tags.length === 0) {
    return tests;
  }
  const normalizedTags = tags.map((t) => t.toLowerCase());
  return tests.filter((test) => {
    let rawTags = [];
    if (Array.isArray(test.tags)) {
      rawTags = test.tags;
    } else if (test.tags) {
      rawTags = [test.tags];
    }
    const testTags = rawTags.map((t) => String(t).toLowerCase());
    return testTags.some((tag) => normalizedTags.includes(tag));
  });
}

function filterTestsByHappy(tests: TestCase[], happy?: boolean) {
  if (!happy) {
    return tests;
  }
  return tests.filter((test) => {
    const status = typeof test.response?.status === 'number' ? test.response.status : 200;
    return status >= 200 && status < 300;
  });
}

function filterTestsByName(tests: TestCase[], pattern?: string) {
  if (!pattern) {
    return tests;
  }
  const regex = new RegExp(pattern, 'i');
  return tests.filter((test) => regex.test(test.name));
}

function filterTestsByFailures(tests: TestCase[], snapshotPath?: string) {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    return tests;
  }
  try {
    const raw = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const cases = Array.isArray(raw) ? raw : raw.cases || [];
    const failing = new Set(
      cases.filter((c) => c.status && c.status !== 'pass').map((c) => c.name)
    );
    return tests.filter((test) => failing.has(test.name));
  } catch {
    return tests;
  }
}

function isArazzo(test: TestCase | undefined): boolean {
  return test?.source?.kind === 'arazzo';
}

function filterTestsByWorkflow(tests: TestCase[], workflows?: string[]) {
  if (!workflows || workflows.length === 0) {
    return tests;
  }
  const wanted = new Set(workflows);
  return tests.filter((test) => isArazzo(test) && wanted.has(String(test.source!.entryWorkflowId)));
}

// Arazzo steps form a single gated chain per workflow, so selecting any step
// (by tag, name, focus, ...) pulls in the rest of its workflow and every
// dependency edge that touches an Arazzo node. Without this a filtered-out
// predecessor would leave the selected step stuck as failed-precondition.
function includeArazzoClosure(all: TestCase[], selected: TestCase[]): TestCase[] {
  if (!all.some(isArazzo)) {
    return selected;
  }
  const byId = new Map<string, TestCase>();
  const byGroup = new Map<string, TestCase[]>();
  for (const test of all) {
    if (test.operationId) byId.set(test.operationId, test);
    if (isArazzo(test)) {
      const group = String(test.source!.group);
      byGroup.set(group, [...(byGroup.get(group) || []), test]);
    }
  }
  const included = new Set(selected);
  const queue = [...selected];
  while (queue.length > 0) {
    const test = queue.pop()!;
    const related: TestCase[] = [];
    if (isArazzo(test)) {
      related.push(...(byGroup.get(String(test.source!.group)) || []));
    }
    for (const depId of test.dependsOn || []) {
      const dep = byId.get(depId);
      if (dep && (isArazzo(test) || isArazzo(dep))) related.push(dep);
    }
    for (const candidate of related) {
      if (!included.has(candidate)) {
        included.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return all.filter((test) => included.has(test));
}

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function toSnakeCase(text: string): string {
  if (!text) return '';
  // Handle spaces and non-alphanumeric characters (replace with underscores)
  let result = text.replace(/[^a-zA-Z0-9]+/g, '_');

  // Insert underscores before uppercase letters (handling both CamelCases)
  result = result.replace(/([a-z0-9])([A-Z])/g, '$1_$2'); // lowerCamelCase
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'); // UpperCamelCase and acronyms

  // Convert to lowercase
  result = result.toLowerCase();

  // Remove consecutive underscores (clean up extra underscores)
  result = result.replace(/_+/g, '_');

  // Remove leading and trailing underscores
  result = result.replace(/^_+|_+$/g, '');

  return result;
}

export const coreFilterPlugin = (cfg: SpectestConfig): Plugin => ({
  name: 'core-filter',
  setup(ctx) {
    ctx.onPrepare(async (suites) => {
      let tests = suites.flatMap((s) => [...s.setup, ...s.tests, ...s.teardown]);

      tests.forEach((test) => {
        if (!test.operationId) {
          test.operationId = `${toSnakeCase(test.name)}_ ${Math.floor(Math.random() * 1000)}`;
        }
      });

      tests = expandRepeats(tests);
      const expanded = tests;
      tests = filterTestsByWorkflow(tests, cfg.workflows);
      tests = filterTestsByFocus(tests);
      tests = filterTestsByTags(tests, cfg.tags);
      tests = filterTestsByName(tests, cfg.filter);
      tests = filterTestsByHappy(tests, cfg.happy);
      tests = filterTestsByFailures(tests, cfg.snapshotFile);
      tests = includeArazzoClosure(expanded, tests);

      if (cfg.randomize) {
        shuffle(tests);
      }

      const testsBySuite = tests.reduce((acc, test) => {
        const suiteName = test.suiteName || 'unknown';
        if (!acc[suiteName]) {
          acc[suiteName] = {
            name: suiteName,
            setup: [],
            tests: [],
            teardown: [],
          };
        }
        const phase = test.phase || 'main';
        if (phase === 'setup') {
          acc[suiteName].setup.push(test);
        } else if (phase === 'teardown') {
          acc[suiteName].teardown.push(test);
        } else {
          acc[suiteName].tests.push(test);
        }
        return acc;
      }, {} as Record<string, Suite>);

      return Object.values(testsBySuite);
    });
  },
});
