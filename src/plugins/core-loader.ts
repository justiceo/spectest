import { readFile } from 'fs/promises';
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import type { Plugin } from '../plugin-api.js';
import type { Suite, TestCase } from '../types.js';

async function loadSuite(filePath: string): Promise<Suite> {
  let tests: TestCase[] = [];
  let name: string | undefined;
  let setup: TestCase[] = [];
  let teardown: TestCase[] = [];

  if (filePath.endsWith('.json')) {
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      tests = data;
    } else if (data) {
      if (Array.isArray(data.tests)) tests = data.tests;
      if (typeof data.name === 'string') name = data.name;
      if (Array.isArray(data.setup)) setup = data.setup;
      if (Array.isArray(data.teardown)) teardown = data.teardown;
    }
  } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    const raw = await readFile(filePath, 'utf8');
    const data: any = parseYaml(raw);
    if (Array.isArray(data)) {
      tests = data as any;
    } else if (data) {
      if (Array.isArray(data.tests)) tests = data.tests as any;
      if (typeof data.name === 'string') name = data.name;
      if (Array.isArray(data.setup)) setup = data.setup;
      if (Array.isArray(data.teardown)) teardown = data.teardown;
    }
  } else {
    const mod = await import(filePath);
    const exported = (mod as any).default || mod;
    if (Array.isArray(exported)) {
      tests = [...exported];
    } else if (exported && typeof exported === 'object') {
      if (Array.isArray((exported as any).tests)) {
        tests = [...(exported as any).tests];
      }
      if (typeof (exported as any).name === 'string') {
        name = (exported as any).name;
      }
      if (Array.isArray((exported as any).setup)) {
        setup = (exported as any).setup;
      }
      if (Array.isArray((exported as any).teardown)) {
        teardown = (exported as any).teardown;
      }
    }
  }

  if (!name) {
    const base = path.basename(filePath);
    const parsed = path.parse(base);
    name = parsed.name.replace(/\.spectest$/, '');
  }

  const allTests = [
    ...setup.map((t) => ({ ...t, phase: 'setup' as const })),
    ...tests,
    ...teardown.map((t) => ({ ...t, phase: 'teardown' as const })),
  ].map((t) => ({ ...t, suiteName: name }));

  const finalSetup = allTests.filter((t) => t.phase === 'setup');
  const finalTeardown = allTests.filter((t) => t.phase === 'teardown');
  const finalMain = allTests.filter((t) => t.phase !== 'setup' && t.phase !== 'teardown');

  return { name, tests: finalMain, setup: finalSetup, teardown: finalTeardown, loadPath: filePath };
}

export const coreLoaderPlugin: Plugin = {
  name: 'core-loader',
  setup(ctx) {
    ctx.onLoad({ filter: /\.(suite|spectest)\.(js|ts|mjs|cjs|json|yaml|yml)$/ }, async ({ path }) => {
      const suite = await loadSuite(path);
      return { suites: [suite] };
    });
  },
};
