import { readFile } from 'fs/promises';
import { load as parseYaml } from 'js-yaml';
import type { SpectestPlugin } from './plugin';
import type { Suite, TestCase } from './types';

export const yamlPlugin: SpectestPlugin = {
  name: 'yaml',
  setup(build) {
    build.onLoad(/\.ya?ml$/, async (path) => {
      const raw = await readFile(path, 'utf8');
      const data: any = parseYaml(raw);
      let tests: TestCase[] = [];
      let name: string | undefined;
      let setup: TestCase[] = [];
      let teardown: TestCase[] = [];

      if (Array.isArray(data)) {
        tests = data as any;
      } else if (data) {
        if (Array.isArray(data.tests)) tests = data.tests as any;
        if (typeof data.name === 'string') name = data.name;
        if (Array.isArray(data.setup)) setup = data.setup;
        if (Array.isArray(data.teardown)) teardown = data.teardown;
      }

      const allTests = [
        ...setup.map((t) => ({ ...t, phase: 'setup' as const })),
        ...tests,
        ...teardown.map((t) => ({ ...t, phase: 'teardown' as const })),
      ];

      return { name, tests: allTests, loadPath: path };
    });
  },
};
