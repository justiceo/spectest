import { existsSync, readFileSync } from 'fs';
import type { Plugin } from '../plugin-api.js';
import type { Suite, TestCase } from '../types.js';

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
  const focused = tests.filter((t) => t.focus);
  if (focused.length > 0) {
    return focused;
  }
  return tests;
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

function shuffle(arr: any[]) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export const coreFilterPlugin = (cfg: any): Plugin => ({
  name: 'core-filter',
  setup(ctx) {
    ctx.onPrepare(async (suites) => {
      let tests = suites.flatMap((s) => s.tests);

      tests = expandRepeats(tests);
      tests = filterTestsByFocus(tests);
      tests = filterTestsByTags(tests, cfg.tags);
      tests = filterTestsByName(tests, cfg.filter);
      tests = filterTestsByHappy(tests, cfg.happy);
      tests = filterTestsByFailures(tests, cfg.snapshotFile);

      if (cfg.randomize) {
        shuffle(tests);
      }

      const testsBySuite = tests.reduce((acc, test) => {
        const suiteName = test.suiteName || 'unknown';
        if (!acc[suiteName]) {
          acc[suiteName] = [];
        }
        acc[suiteName].push(test);
        return acc;
      }, {} as Record<string, TestCase[]>);

      return Object.entries(testsBySuite).map(([name, tests]) => ({
        name,
        tests,
      }));
    });
  },
});
