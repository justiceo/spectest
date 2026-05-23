import { existsSync, realpathSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { HttpClient } from './http-client';
import { loadConfig } from './config';
import Server from './server';
import RateLimiter from './rate-limiter';
import { resolveUserAgent } from './user-agents';
import { PluginHost } from './plugin-host';
import { coreLoaderPlugin } from './plugins/core-loader';
import { coreFilterPlugin } from './plugins/core-filter';
import { consoleReporterPlugin } from './plugins/console-reporter';
import { HttpRecordingCassette, type MissingRecordingBehavior, type RecordingMode } from './recording-cassette';
import type { Suite, TestCase, TestResult } from "./types";

type SkipStatus = 'skipped' | 'failed-precondition';

async function runAllTests(cfg: any) {
  const server = new Server();
  const spectestVersion = await getSpectestVersion();
  const recordingEnabled = cfg.recording !== 'off';
  const recordingCassette = recordingEnabled
    ? new HttpRecordingCassette({
        file: cfg.recordingFile,
        mode: cfg.recording,
        missingRecordingBehavior: cfg.missingRecordingBehavior,
        recordingExcludeUrls: cfg.recordingExcludeUrls,
        spectestVersion,
      })
    : null;
  if (recordingCassette) {
    await recordingCassette.load();
  }
  const testState = {
    sessionCookie: null,
    completedCases: {} as Record<string, any>,
  };

  const host = new PluginHost([
    coreLoaderPlugin,
    coreFilterPlugin(cfg),
    consoleReporterPlugin(cfg),
  ]);
  await host.setup();

  const api = new HttpClient({
    baseURL: cfg.baseUrl,
    timeout: cfg.timeout,
    pluginHost: host,
  });
  api.setHeader('User-Agent', resolveUserAgent(cfg.userAgent));

  server.setConfig({
    startCommand: cfg.startCmd,
    buildCmd: cfg.buildCmd,
    serverUrl: cfg.baseUrl,
    runningServer: cfg.runningServer,
    recording: {
      enabled: recordingEnabled,
      preloadPath: fileURLToPath(new URL('./recording-preload.js', import.meta.url)),
      cassette: recordingCassette || undefined,
    },
  });

  const rateLimiter = new RateLimiter(cfg.rps || Infinity);

  const testDir = path.resolve(cfg.projectRoot || process.cwd(), cfg.testDir || './test');
  const entries = await readdir(testDir, { recursive: true, withFileTypes: true });
  const pattern = new RegExp(cfg.filePattern || '\\.(suite|spectest)\\.');
  const suitePaths = entries
    .filter((entry) => entry.isFile() && pattern.test(path.join(entry.parentPath, entry.name)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  console.log("[spectest] Found " + suitePaths.length + " matching test files");

  let suites: Suite[] = [];
  for (const p of suitePaths) {
    const loaded = await host.loadSuites(p);
    suites.push(...loaded);
  }

  suites = await host.prepareSuites(suites);
  const setupTests = suites.flatMap((s) => s.setup);
  const mainTests = suites.flatMap((s) => s.tests);
  const teardownTests = suites.flatMap((s) => s.teardown);

  const tests = [...setupTests, ...mainTests, ...teardownTests];

  try {
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  await host.dispatchRunStart(tests);

  const results: TestResult[] = [];
  const runtimeSkipped = new Set<any>();
  const executedTests = new Set<TestCase>();
  const testOrder = new Map<TestCase, number>();
  tests.forEach((test, index) => {
    testOrder.set(test, index);
  });

  async function runTests(testCases: TestCase[]): Promise<boolean> {
    const phaseResults: TestResult[] = [];
    const opIdMap = new Map<string, TestCase>();
    testCases.forEach((t) => {
      opIdMap.set(t.operationId, t);
      (t as any).dependents = [];
      (t as any).unresolvedDependencies = 0;
      (t as any).__runtimeSkip = false;
    });

    testCases.forEach((t) => {
      if (Array.isArray(t.dependsOn) && t.dependsOn.length > 0) {
        (t as any).unresolvedDependencies = t.dependsOn.length;
        t.dependsOn.forEach((depId: string) => {
          const dep = opIdMap.get(depId);
          if (dep) {
            (dep as any).dependents.push(t);
          } else {
            console.warn('Invalid dependency ' + depId);
            (t as any).__runtimeSkip = true;
            runtimeSkipped.add(t);
            (t as any).unresolvedDependencies -= 1;
          }
        });
      }
    });

    const scheduled = new Set<any>();
    async function schedule(test: TestCase): Promise<void> {
      if (test.skip || scheduled.has(test) || (test as any).__runtimeSkip) return;
      scheduled.add(test);

      await host.dispatchTestStart(test);
      const result = await runTest(test, api, testState, server, rateLimiter, cfg);
      results.push(result);
      phaseResults.push(result);
      executedTests.add(test);

      if (result.status === 'passed') {
        if (!testState.completedCases[result.operationId]) {
          testState.completedCases[result.operationId] = result;
        }
      } else {
        (test as any).dependents.forEach((d: any) => {
          if (!d.__runtimeSkip) {
            d.__runtimeSkip = true;
            runtimeSkipped.add(d);
          }
        });
      }

      await host.dispatchTestEnd(test, result);

      if (result.status === 'passed') {
        const readyDependents = (test as any).dependents.filter((d: any) => {
          d.unresolvedDependencies -= 1;
          return d.unresolvedDependencies === 0 && !d.__runtimeSkip;
        });
        await Promise.all(readyDependents.map((d: any) => schedule(d)));
      }
    }

    const initialPromises = testCases
      .filter((t) => (t as any).unresolvedDependencies === 0)
      .map((t) => schedule(t));

    await Promise.all(initialPromises);
    testCases.forEach((test) => {
      if (!test.skip && !executedTests.has(test)) {
        runtimeSkipped.add(test);
      }
    });
    return testCases.every((test) => {
      return test.skip || (executedTests.has(test) && !runtimeSkipped.has(test));
    }) && phaseResults.every((r) => r.status === 'passed');
  }

  try {
    const setupPassed = await runTests(setupTests);
    if (setupPassed) {
      await runTests(mainTests);
    } else {
      mainTests.forEach((test) => {
        if (!test.skip) {
          runtimeSkipped.add(test);
        }
      });
    }
  } finally {
    await runTests(teardownTests);
    await server.stop();
    if (recordingCassette) {
      await recordingCassette.save();
    }
    rateLimiter.stop();

    const explicitlySkipped = tests.filter((t) => t.skip && !executedTests.has(t));
    const skipResults = [
      ...explicitlySkipped.map((test) => createSkippedResult(test, 'skipped')),
      ...Array.from(runtimeSkipped)
        .filter((test) => !test.skip && !executedTests.has(test))
        .map((test) => createSkippedResult(test, 'failed-precondition')),
    ];
    const finalResults = [...results, ...skipResults].sort((a, b) => {
      return (resultOrder(a) ?? Number.MAX_SAFE_INTEGER) - (resultOrder(b) ?? Number.MAX_SAFE_INTEGER);
    });

    await host.dispatchRunEnd({
      results: finalResults,
      serverLogs: server.getLogs(),
    });

    const passed = finalResults.every((r) => r.status !== 'failed');
    process.exit(passed ? 0 : 1);
  }

  function resultOrder(result: TestResult): number | undefined {
    const test = tests.find((t) => t.operationId === result.operationId);
    return test ? testOrder.get(test) : undefined;
  }
}

function createSkippedResult(test: TestCase, status: SkipStatus): TestResult {
  return {
    status,
    latency: 0,
    requestId: null,
    testName: test.name,
    operationId: test.operationId,
    suiteName: test.suiteName,
    request: {},
    response: {
      status: 0,
      headers: {},
      data: null,
    },
  };
}

async function getSpectestVersion(): Promise<string> {
  try {
    const packageJsonUrl = new URL('../package.json', import.meta.url);
    const raw = await readFile(packageJsonUrl, 'utf8');
    return JSON.parse(raw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveRecordingMode(test: TestCase, cfg: any): RecordingMode {
  return test.recording || cfg.recording;
}

async function runTest(test: TestCase, api: HttpClient, testState: any, server: Server, rateLimiter: RateLimiter, cfg: any): Promise<TestResult> {
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
      : api.getTimeout();
  try {
    let config = {
      method: test.request?.method || 'GET',
      url: test.endpoint,
      // todo: rename data to body.
      data: test.request?.body,
      headers: { ...test.request?.headers } as Record<string, string>,
    };

    if (test.request?.credentials === 'include' && testState.sessionCookie) {
      config.headers.Cookie = testState.sessionCookie;
    }

    if (typeof test.beforeSend === 'function') {
      const immutableState = JSON.parse(JSON.stringify(testState));
      const updatedConfig = await test.beforeSend(config, immutableState);
      if (updatedConfig) config = updatedConfig;
    }

    if (cfg.recording !== 'off') {
      config.headers = { ...config.headers };
      config.headers['x-spectest-case-id'] = test.operationId || test.name;
      config.headers['x-spectest-test-name'] = test.name;
      config.headers['x-spectest-suite-name'] = test.suiteName || '';
      config.headers['x-spectest-recording-mode'] = resolveRecordingMode(test, cfg);
      config.headers['x-spectest-missing-recording-behavior'] = cfg.missingRecordingBehavior as MissingRecordingBehavior;
    }

    await rateLimiter.acquire();
    const response = await api.request({ ...config, timeout: testTimeout });

    const sessionCookie = response.headers.get('set-cookie') ?? "";
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
        const actualValue = response.headers.get(headerName.toLowerCase());
        if (expectedValue === true) {
          if (typeof actualValue === 'undefined') {
            errors.push(`Header '${headerName}' not found`);
            passed = false;
            console.log("headers " + JSON.stringify(Object.fromEntries(response.headers)));
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
      status: passed ? 'passed' : 'failed',
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
      status: 'failed',
      error: isTimeout ? `Timeout after ${testTimeout}ms` : error.message,
      latency,
      requestId,
      testName: test.name,
      operationId: test.operationId,
      suiteName: test.suiteName,
      timedOut: isTimeout,
      request: {},
      response: {
          status: 0,
          headers: {},
          data: null
      }
    };
  }
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


if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  loadConfig(process.argv).then((cfg) => {
    runAllTests(cfg).catch(console.error);
  });
}
