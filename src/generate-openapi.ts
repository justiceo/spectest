import { readdir } from 'fs/promises';
import path from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

interface TestCase {
  name: string;
  endpoint: string;
  request?: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response?: {
    status?: number;
    json?: any;
    schema?: any;
    headers?: Record<string, any>;
  };
}

async function loadSuites(testDir = './spec', filePattern = /\.(suite|suites)\./) {
  const absDir = path.resolve(testDir);
  const files = await readdir(absDir);
  const suiteFiles = files.filter((f) => filePattern.test(f));
  const modules = await Promise.all(suiteFiles.map((f) => import(path.join(absDir, f))));
  return modules.reduce<TestCase[]>((acc, mod) => {
    if (Array.isArray(mod.default)) acc.push(...mod.default);
    return acc;
  }, []);
}

function dedupeTests(tests: TestCase[]): TestCase[] {
  const seen = new Set<string>();
  const result: TestCase[] = [];
  tests.forEach((t) => {
    const method = t.request?.method || 'GET';
    const key = `${method.toUpperCase()} ${t.endpoint}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  });
  return result;
}

export async function generateOpenApi() {
  const tests = await loadSuites();
  const unique = dedupeTests(tests);
  const spec: any = {
    openapi: '3.0.0',
    info: {
      title: 'Generated API',
      version: '1.0.0',
    },
    paths: {},
  };

  unique.forEach((test) => {
    const method = (test.request?.method || 'GET').toLowerCase();
    const pathKey = test.endpoint;
    spec.paths[pathKey] = spec.paths[pathKey] || {};
    const op: any = {
      summary: test.name,
      responses: {},
    };

    if (test.request?.body) {
      op.requestBody = {
        content: {
          'application/json': { example: test.request.body },
        },
      };
    }

    const status = test.response?.status || 200;
    const respObj: any = { description: '' };
    if (test.response?.schema) {
      respObj.content = {
        'application/json': { schema: test.response.schema },
      };
    } else if (test.response?.json) {
      respObj.content = {
        'application/json': { example: test.response.json },
      };
    }
    op.responses[status] = respObj;

    spec.paths[pathKey][method] = op;
  });

  return spec;
}

if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  generateOpenApi().then((spec) => {
    console.log(JSON.stringify(spec, null, 2));
  });
}
