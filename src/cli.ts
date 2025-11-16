import { existsSync, realpathSync } from 'fs';
import { readdir } from 'fs/promises';
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
import type { Suite, TestCase, TestResult } from "./types";

async function runAllTests(cfg: any) {
  const server = new Server();
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
    timeout: cfg.timeout || 30000,
    pluginHost: host,
  });
  api.setHeader('User-Agent', resolveUserAgent(cfg.userAgent));

  server.setConfig({
    startCommand: cfg.startCmd,
    buildCmd: cfg.buildCmd,
    serverUrl: cfg.baseUrl,
    runningServer: cfg.runningServer,
  });

  const rateLimiter = new RateLimiter(cfg.rps || Infinity);

  const testDir = path.resolve(cfg.projectRoot || process.cwd(), cfg.testDir || './test');
  const files = await readdir(testDir);
  const pattern = new RegExp(cfg.filePattern || '\\.(suite|spectest)\\.');
  const suitePaths = files
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => path.join(testDir, f));

  let suites: Suite[] = [];
  for (const p of suitePaths) {
    const loaded = await host.loadSuites(p);
    suites.push(...loaded);
  }

  suites = await host.prepareSuites(suites);
  const tests = suites.flatMap((s) => s.tests.map(t => ({...t, suiteName: s.name})));

  try {
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  await host.dispatchRunStart(tests);
  
  const results: TestResult[] = [];
  const opIdMap = new Map<string, TestCase>();
  tests.forEach((t) => {
    opIdMap.set(t.operationId, t);
    (t as any).dependents = [];
    (t as any).unresolvedDependencies = 0;
    (t as any).__runtimeSkip = false;
  });

  const runtimeSkipped = new Set<any>();
  tests.forEach((t) => {
    if (Array.isArray(t.dependsOn) && t.dependsOn.length > 0) {
      (t as any).unresolvedDependencies = t.dependsOn.length;
      t.dependsOn.forEach((depId: string) => {
        const dep = opIdMap.get(depId);
        if (dep) {
          (dep as any).dependents.push(t);
        } else {
          console.warn("Invalid dependency " + depId)
          (t as any).__runtimeSkip = true;
          runtimeSkipped.add(t);
          (t as any).unresolvedDependencies -= 1;
        }
      });
    }
  });

  const scheduled = new Set<any>();
  async function schedule(test: TestCase): Promise<void> {
    if (scheduled.has(test) || (test as any).__runtimeSkip) return;
    scheduled.add(test);

    await host.dispatchTestStart(test);
    const result = await runTest(test, api, testState, server, rateLimiter);
    results.push(result);

    if (result.passed) {
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

    if (result.passed) {
      const readyDependents = (test as any).dependents.filter((d: any) => {
        d.unresolvedDependencies -= 1;
        return d.unresolvedDependencies === 0 && !d.__runtimeSkip;
      });
      await Promise.all(readyDependents.map((d: any) => schedule(d)));
    }
  }

  const initialPromises = tests
    .filter((t) => (t as any).unresolvedDependencies === 0)
    .map((t) => schedule(t));

  await Promise.all(initialPromises);

  await server.stop();
  rateLimiter.stop();

  await host.dispatchRunEnd({ results, skippedTests: Array.from(runtimeSkipped) });

  const passed = results.every((r) => r.passed);
  process.exit(passed ? 0 : 1);
}

async function runTest(test: TestCase, api: HttpClient, testState: any, server: Server, rateLimiter: RateLimiter): Promise<TestResult> {
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

    await rateLimiter.acquire();
    const response = await api.request({ ...config, timeout: testTimeout });

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
      request: {},
      response: {
          status: 0,
          headers: {},
          data: null
      }
    };
  }
}


if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  loadConfig(process.argv).then((cfg) => {
    runAllTests(cfg).catch(console.error);
  });
}
