import Renderer from './renderer';
import { readdir, writeFile, readFile } from 'fs/promises';
import { existsSync, realpathSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import axios from 'axios';

import { loadConfig } from './config';
import Server from './server';
import RateLimiter from './rate-limiter';
import { resolveUserAgent } from './user-agents';
import type { Suite, TestCase } from "./types";


let api;
let rateLimiter;
const server = new Server();

const testState = {
  sessionCookie: null,
  completedCases: {} as Record<string, any>,
};

function setupEnvironment(cfg) {
  api = axios.create({
    baseURL: cfg.baseUrl,
    timeout: cfg.timeout || 30000,
    validateStatus: () => true,
  });
  api.defaults.headers.common['User-Agent'] = resolveUserAgent(cfg.userAgent);

  server.setConfig({
    startCommand: cfg.startCmd,
    serverUrl: cfg.baseUrl,
    runningServer: cfg.runningServer,
  });

  rateLimiter = new RateLimiter(cfg.rps || Infinity);
}

async function discoverSuites(cfg): Promise<Suite[]> {
  const projectRoot = cfg.projectRoot || process.cwd();

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
    } else {
      const mod = await import(filePath);
      const exported = mod.default || mod;

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

    return { name, tests };
  }

  if (cfg.suiteFile) {
    const suitePath = path.resolve(projectRoot, cfg.suiteFile);
    const suite = await loadSuite(suitePath);
    return [suite];
  }

  const testDir = path.resolve(projectRoot, cfg.testDir);
  const files = await readdir(testDir);
  const pattern = new RegExp(cfg.filePattern);
  const suiteFiles = files.filter((f) => pattern.test(f)).sort();
  const suites: Suite[] = [];
  for (const file of suiteFiles) {
    const suitePath = path.join(testDir, file);
    // eslint-disable-next-line no-await-in-loop
    const suite = await loadSuite(suitePath);
    suites.push(suite);
  }
  return suites;
}

function validateWithSchema(data, schema) {
  if (typeof schema.safeParse !== 'function') {
    return { success: false, errors: ['response schema is not a valid zod schema'] };
  }
  const result = schema.safeParse(data);
  return {
    success: result.success,
    errors: result.success ? [] : result.error.issues.map((i) => i.message),
  };
}

function validateTests(tests: TestCase[]) {
  const nameSet = new Set<string>();
  const opIdSet = new Set<string>();

  tests.forEach((t, idx) => {
    if (!t.name) {
      throw new Error(`Test case at index ${idx} is missing a name`);
    }
    if (nameSet.has(t.name)) {
      throw new Error(`Duplicate test name '${t.name}' detected`);
    }
    nameSet.add(t.name);

    if (!t.endpoint) {
      throw new Error(`Test '${t.name}' is missing an endpoint`);
    }

    if (t.rps !== undefined) {
      const rps = Number(t.rps);
      if (!Number.isFinite(rps) || rps < 0) {
        throw new Error(`Test '${t.name}' has invalid rps value '${t.rps}'`);
      }
    }

    if (!t.operationId) {
      t.operationId = t.name;
    }
    if (opIdSet.has(t.operationId)) {
      throw new Error(`Duplicate operationId '${t.operationId}' detected`);
    }
    opIdSet.add(t.operationId);
  });
}

async function runTest(test: TestCase) {
  if (typeof test.delay === 'number' && test.delay > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, test.delay);
    });
  }
  const startTime = Date.now();
  let requestId: string | null = null;
  if (test.request?.headers) {
    for (const [h, v] of Object.entries(test.request.headers)) {
      if (h.toLowerCase() === 'x-request-id') {
        requestId = String(v);
        break;
      }
    }
  }
  const testTimeout =
    typeof test.timeout === 'number' && !Number.isNaN(test.timeout)
      ? test.timeout
      : api.defaults.timeout;
  try {
    let config = {
      method: test.request?.method || 'GET',
      url: test.endpoint,
      data: test.request?.body,
      headers: {...test.request?.headers},
    };

    if (test.request?.credentials === 'include' && testState.sessionCookie) {
      config.headers.Cookie = testState.sessionCookie;
    }

    if (typeof test.beforeSend === 'function') {
      const immutableState = JSON.parse(JSON.stringify(testState));
      const updatedConfig = await test.beforeSend(config, immutableState);
      if (updatedConfig) config = updatedConfig;
    }

    if (rateLimiter) {
      await rateLimiter.acquire();
    }
    const response = await api({ ...config, timeout: testTimeout });

    const [sessionCookie] = response.headers['set-cookie'] || [];
    if (sessionCookie) {
      testState.sessionCookie = sessionCookie;
    }

    if (typeof test.postTest === 'function') {
      const requestLogs = requestId
        ? server.getLogs().filter((log) => log.message.includes(requestId))
        : [];
      await test.postTest(response, testState, { requestId, logs: requestLogs });
    }

    let passed = true;
    const expectedResponse = test.response || {};
    const errors = [];

    if (expectedResponse.status !== undefined && response.status !== expectedResponse.status) {
      errors.push(`Status mismatch: expected ${expectedResponse.status}, got ${response.status}`);
      passed = false;
    }

    if (expectedResponse.status === 200 && !expectedResponse.json?.message && response.data.message) {
      errors.push(`⚠️ Unexpected status message: ${response.data.message}`);
    }

    if (expectedResponse.headers && Object.keys(expectedResponse.headers).length > 0) {
      Object.entries(expectedResponse.headers).forEach(([headerName, expectedValue]) => {
        const actualValue = response.headers[headerName.toLowerCase()];
        if (expectedValue === true) {
          if (typeof actualValue === 'undefined') {
            errors.push(`Header '${headerName}' not found`);
            passed = false;
          }
        } else if (actualValue !== expectedValue) {
          errors.push(`Header '${headerName}' mismatch: expected '${expectedValue}', got '${actualValue}'`);
          passed = false;
        }
      });
    }

    if (expectedResponse.json && Object.keys(expectedResponse.json).length > 0) {
      Object.entries(expectedResponse.json).forEach(([key, expectedValue]) => {
        const actualValue = response.data?.[key];
        if (typeof expectedValue === 'object' && expectedValue !== null) {
          if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
            errors.push(
              `Data property '${key}' mismatch: expected ${JSON.stringify(
                expectedValue
              )}, got ${JSON.stringify(actualValue)}`
            );
            passed = false;
          }
        } else if (actualValue !== expectedValue) {
          errors.push(
            `Data property '${key}' mismatch: expected ${JSON.stringify(
              expectedValue
            )}, got ${JSON.stringify(actualValue)}`
          );
          passed = false;
        }
      });
    }

    if (expectedResponse.schema) {
      const result = validateWithSchema(response.data, expectedResponse.schema);
      if (!result.success) {
        passed = false;
        errors.push(`Schema validation failed: ${result.errors.join(', ')}`);
      }
    }

    const latency = Date.now() - startTime;
    return {
      passed,
      error: errors.map((e) => `\n\t- ${e}`).join(';'),
      latency,
      requestId,
      testName: test.name,
      operationId: test.operationId,
      suiteName: test.suiteName,
      request: config,
      response: {
        status: response.status,
        headers: response.headers,
        data: response.data,
      },
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message);
    return {
      passed: false,
      error: isTimeout ? `Timeout after ${testTimeout}ms` : error.message,
      latency,
      requestId,
      testName: test.name,
      operationId: test.operationId,
      suiteName: test.suiteName,
      timedOut: isTimeout,
      request: error.config || undefined,
      response: error.response
        ? {
            status: error.response.status,
            headers: error.response.headers,
            data: error.response.data,
          }
        : undefined,
    };
  }
}

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

function filterTestsByFocus(tests) {
  const focused = tests.filter((t) => t.focus);
  if (focused.length > 0) {
    const skipped = tests.filter((t) => !t.focus);
    return { filtered: focused, skipped };
  }
  return { filtered: [...tests], skipped: [] };
}

function filterTestsByTags(tests, tags) {
  if (!tags || tags.length === 0) {
    return { filtered: [...tests], skipped: [] };
  }
  const normalizedTags = tags.map((t) => t.toLowerCase());
  const filtered = [];
  const skipped = [];
  tests.forEach((test) => {
    let rawTags = [];
    if (Array.isArray(test.tags)) {
      rawTags = test.tags;
    } else if (test.tags) {
      rawTags = [test.tags];
    }
    const testTags = rawTags.map((t) => String(t).toLowerCase());
    if (testTags.some((tag) => normalizedTags.includes(tag))) {
      filtered.push(test);
    } else {
      skipped.push(test);
    }
  });
  return { filtered, skipped };
}

function filterTestsByHappy(tests, happy) {
  if (!happy) {
    return { filtered: [...tests], skipped: [] };
  }
  const filtered = [];
  const skipped = [];
  tests.forEach((test) => {
    const status = typeof test.response?.status === 'number' ? test.response.status : 200;
    if (status >= 200 && status < 300) {
      filtered.push(test);
    } else {
      skipped.push(test);
    }
  });
  return { filtered, skipped };
}

function filterTestsByName(tests, pattern) {
  if (!pattern) {
    return { filtered: [...tests], skipped: [] };
  }
  const regex = new RegExp(pattern, 'i');
  const filtered = [];
  const skipped = [];
  tests.forEach((test) => {
    if (regex.test(test.name)) filtered.push(test);
    else skipped.push(test);
  });
  return { filtered, skipped };
}

function filterTestsByFailures(tests, snapshotPath) {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    return { filtered: [...tests], skipped: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const cases = Array.isArray(raw) ? raw : raw.cases || [];
    const failing = new Set(
      cases.filter((c) => c.status && c.status !== 'pass').map((c) => c.name)
    );
    const filtered = [];
    const skipped = [];
    tests.forEach((test) => {
      if (failing.has(test.name)) filtered.push(test);
      else skipped.push(test);
    });
    return { filtered, skipped };
  } catch {
    return { filtered: [...tests], skipped: [] };
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function runTests(tests: TestCase[], renderer, options = {}) {
  const { tags, randomize, happy, filter, snapshotFile } = options;
  const expanded = expandRepeats(tests);
  const focusResult = filterTestsByFocus(expanded);
  const tagResult = filterTestsByTags(focusResult.filtered, tags);
  let nameResult = { filtered: [...tagResult.filtered], skipped: [] };
  let happyFlag = happy;
  if (filter) {
    const lower = String(filter).toLowerCase();
    if (lower === 'happy') {
      happyFlag = true;
    } else if (lower === 'failures') {
      nameResult = filterTestsByFailures(tagResult.filtered, snapshotFile);
    } else {
      nameResult = filterTestsByName(tagResult.filtered, filter);
    }
  }
  const happyResult = filterTestsByHappy(nameResult.filtered, happyFlag);
  const filtered = happyResult.filtered.filter((t) => !t.skip);
  const skippedTests = [
    ...focusResult.skipped,
    ...tagResult.skipped,
    ...nameResult.skipped,
    ...happyResult.skipped,
    ...happyResult.filtered.filter((t) => t.skip),
  ];

  let runnableTests = [...filtered];
  if (randomize) {
    shuffle(runnableTests);
  }

  const opIdMap = new Map<string, any>();
  runnableTests.forEach((t) => {
    opIdMap.set(t.operationId, t);
    t.dependents = [];
    t.unresolvedDependencies = 0;
    t.__runtimeSkip = false;
  });

  const runtimeSkipped = new Set<any>();
  runnableTests.forEach((t) => {
    if (Array.isArray(t.dependsOn) && t.dependsOn.length > 0) {
      t.unresolvedDependencies = t.dependsOn.length;
      t.dependsOn.forEach((depId: string) => {
        const dep = opIdMap.get(depId);
        if (dep) {
          dep.dependents.push(t);
        } else {
          console.warn("Invalid dependency " + depId)
          t.__runtimeSkip = true;
          runtimeSkipped.add(t);
          t.unresolvedDependencies -= 1;
        }
      });
    }
  });

  const results: any[] = [];
  const scheduled = new Set<any>();
  function schedule(test: any): Promise<void> {
    if (scheduled.has(test) || test.__runtimeSkip) return Promise.resolve();
    scheduled.add(test);
    return runTest(test).then((result) => {
      results.push(result);
      if (result.passed) {
        if (!testState.completedCases[result.operationId]) {
          (testState.completedCases as any)[result.operationId] = {};
        }
        (testState.completedCases as any)[result.operationId].response = result.response;
      }
      if (!result.passed) {
        test.dependents.forEach((d: any) => {
          if (!d.__runtimeSkip) {
            d.__runtimeSkip = true;
            runtimeSkipped.add(d);
          }
        });
        return;
      }

      const readyDependents = test.dependents.filter((d: any) => {
        d.unresolvedDependencies -= 1;
        return d.unresolvedDependencies === 0 && !d.__runtimeSkip;
      });

      return Promise.all(readyDependents.map((d: any) => schedule(d))).then(() => {
        return;
      });
    });
  }

  const initialPromises = runnableTests
    .filter((t) => t.unresolvedDependencies === 0)
    .map((t) => schedule(t));

  await Promise.all(initialPromises);
  const skipped = [...runtimeSkipped];
  return { results, skippedTests: [...skippedTests, ...skipped] };
}

async function runAllTests(cfg, verbose = false, tags = []) {
  const renderer = new Renderer({ verbose });
  const progStart = Date.now();
  renderer.start(cfg.baseUrl);

  const suites = await discoverSuites(cfg);
  const tests: TestCase[] = suites.flatMap((suite) =>
    suite.tests.map((t) => ({ ...t, suiteName: suite.name }))
  );

  tests.forEach((t) => {
    if (!t.operationId) t.operationId = t.name;
  });

  validateTests(tests);

  // TODO: Do not proceed if tests array is empty.

  try {
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  console.log('📋 Running tests...');
  const testStart = Date.now();
  const { results: testResults, skippedTests } = await runTests(tests, renderer, {
    tags,
    randomize: cfg.randomize,
    happy: cfg.happy,
    filter: cfg.filter,
    snapshotFile: cfg.snapshotFile
  });
  const totalTestTime = Date.now() - testStart;
  const passed = testResults.filter((r) => r.passed).length;
  const total = testResults.length;
  console.log('='.repeat(50));
  console.log(`✨ Tests completed: ${passed}/${total} passed`);
  renderer.showSkippedTests(skippedTests);

  const serverLogs = server.getLogs();
  const resultsBySuite = testResults.reduce((acc: any, r: any) => {
    const s = r.suiteName || 'unknown';
    if (!acc[s]) acc[s] = [];
    acc[s].push(r);
    return acc;
  }, {} as Record<string, any[]>);

  renderer.showResults(resultsBySuite, serverLogs);
  renderer.showLatency(testResults);
  
  if (cfg.snapshotFile) {
    const snapshotCases = testResults.map((r) => ({
      name: r.testName,
      operationId: r.operationId,
      suite: r.suiteName,
      request: r.request,
      response: r.response,
      status: r.timedOut ? 'timeout' : r.passed ? 'pass' : 'fail',
      latency: r.latency,
    }));

    const snapshotPath = path.resolve(cfg.snapshotFile);
    let existing = { lastUpdate: '', cases: [] };
    if (existsSync(snapshotPath)) {
      try {
        const raw = JSON.parse(await readFile(snapshotPath, 'utf8'));
        if (Array.isArray(raw)) existing.cases = raw;
        else if (raw && Array.isArray(raw.cases)) existing = raw;
      } catch (err) {
        console.error('Failed to read existing snapshot, starting fresh.');
      }
    }

    const map = new Map(existing.cases.map((c) => [c.name, c]));
    snapshotCases.forEach((c) => {
      map.set(c.name, c);
    });

    const timestamp = new Date()
      .toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      })
      .replace(', ', ' ')
      .replace(/\s(\w+)$/, '$1');

    const merged = { lastUpdate: timestamp, cases: Array.from(map.values()) };

    try {
      await writeFile(snapshotPath, JSON.stringify(merged, null, 2));
      renderer.snapshotSaved(cfg.snapshotFile);
    } catch (err) {
      console.error('Failed to write snapshot:', err.message);
    }
  }

  await server.stop();
  if (rateLimiter) {
    rateLimiter.stop();
  }

  const totalTime = Date.now() - progStart;
  renderer.finalStats(passed, total, totalTestTime, totalTime);
  process.exit(passed === total ? 0 : 1);
}

if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))  {
  loadConfig(process.argv).then((cfg) => {
    setupEnvironment(cfg);
    const verbose = cfg.verbose || false;
    const tags = cfg.tags || [];
    runAllTests(cfg, verbose, tags).catch(console.error);
  });
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

export { runAllTests };
