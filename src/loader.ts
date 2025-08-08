import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import type { CliConfig } from './config';
import type { Suite, TestCase } from './types';

export async function resolveSuitePaths(cfg: CliConfig): Promise<string[]> {
  const projectRoot = cfg.projectRoot || process.cwd();
  if (cfg.suiteFile) {
    return [path.resolve(projectRoot, cfg.suiteFile)];
  }

  const testDir = path.resolve(projectRoot, cfg.testDir || './test');
  const files = await readdir(testDir);
  const pattern = new RegExp(cfg.filePattern || '\\.(suite|spectest)\\.');
  return files
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => path.join(testDir, f));
}

async function loadSuite(filePath: string): Promise<Suite> {
  let tests: TestCase[] = [];
  let name: string | undefined;

  if (filePath.endsWith('.json')) {
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      tests = data;
    } else if (data && Array.isArray(data.tests)) {
      tests = data.tests;
      if (typeof data.name === 'string') name = data.name;
    }
  } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    const raw = await readFile(filePath, 'utf8');
    const data: any = parseYaml(raw);
    if (Array.isArray(data)) {
      tests = data as any;
    } else if (data && Array.isArray(data.tests)) {
      tests = data.tests as any;
      if (typeof data.name === 'string') name = data.name;
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
    }
  }

  if (!name) {
    const base = path.basename(filePath);
    const parsed = path.parse(base);
    name = parsed.name.replace(/\.spectest$/, '');
  }

  return { name, tests, loadPath: filePath };
}

export async function loadSuites(paths: string[]): Promise<Suite[]> {
  const suites: Suite[] = [];
  for (const p of paths) {
    // eslint-disable-next-line no-await-in-loop
    const suite = await loadSuite(p);
    suites.push(suite);
  }
  return suites;
}

