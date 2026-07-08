import { existsSync, realpathSync } from 'fs';
import { readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { HttpClient } from './http-client';
import { loadConfig } from './config';
import Server from './server';
import RateLimiter from './rate-limiter';
import { resolveUserAgent } from './user-agents';
import { PluginHost } from './plugin-host';
import { coreLoaderPlugin } from './plugins/core-loader';
import { openApiLoaderPlugin } from './plugins/openapi-loader';
import { coreFilterPlugin } from './plugins/core-filter';
import { consoleReporterPlugin } from './plugins/console-reporter';
import { buildCoverageReport, formatCoverageReport } from './coverage-report';
import { HttpRecordingCassette, type MissingRecordingBehavior, type RecordingMode } from './recording-cassette';
import type { Suite, TestCase, TestResult } from "./types";
import { runGenerateCommand } from './generate-command';

type SkipStatus = 'skipped' | 'failed-precondition';
type ExecutionStatus = 'not-started' | 'running' | 'completed' | 'skipped' | 'cancelled';

class CancellationError extends Error {
  constructor(message = 'Test run cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

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
    coreLoaderPlugin(cfg),
    openApiLoaderPlugin(cfg),
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
  const pattern = new RegExp(cfg.filePattern || '\\.(suite|spectest)\\.');
  const entries = existsSync(testDir)
    ? await readdir(testDir, { recursive: true, withFileTypes: true })
    : [];
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
  if (cfg.openapi) {
    const loaded = await host.loadSuites(cfg.openapi, { source: 'openapi' });
    suites.push(...loaded);
  }
  validateUniqueOperationIds(suites.flatMap((s) => [...s.setup, ...s.tests, ...s.teardown]));

  suites = await host.prepareSuites(suites);
  const setupTests = suites.flatMap((s) => s.setup);
  const mainTests = suites.flatMap((s) => s.tests);
  const teardownTests = suites.flatMap((s) => s.teardown);

  const tests = [...setupTests, ...mainTests, ...teardownTests];

  try {
    debugLog(cfg, 'server start begin');
    await server.start();
    debugLog(cfg, 'server start complete');
  } catch (error) {
    debugLog(cfg, 'server start failed', { error: error?.message });
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  await host.dispatchRunStart(tests);

  const results: TestResult[] = [];
  const runtimeSkipped = new Set<any>();
  const executedTests = new Set<TestCase>();
  const testStatuses = new Map<TestCase, ExecutionStatus>();
  const testStartTimes = new Map<TestCase, number>();
  const testOrder = new Map<TestCase, number>();
  tests.forEach((test, index) => {
    testOrder.set(test, index);
    testStatuses.set(test, test.skip ? 'skipped' : 'not-started');
  });
  const runAbortController = new AbortController();
  let interrupted = false;
  let sigintCount = 0;
  let firstSigintAt: number | null = null;
  const duplicateSigintWindowMs = 500;
  const sigintHandler = () => {
    const now = Date.now();
    sigintCount += 1;
    const msSinceFirstSigint = firstSigintAt === null ? null : now - firstSigintAt;
    debugLog(cfg, 'SIGINT received', {
      count: sigintCount,
      alreadyInterrupted: interrupted,
      signalAborted: runAbortController.signal.aborted,
      msSinceFirstSigint,
    });
    if (interrupted) {
      if (msSinceFirstSigint !== null && msSinceFirstSigint < duplicateSigintWindowMs) {
        return;
      }
      process.exit(130);
    }
    interrupted = true;
    firstSigintAt = now;
    runAbortController.abort(new CancellationError());
  };

  process.on('SIGINT', sigintHandler);

  async function runTests(phaseName: string, testCases: TestCase[], signal?: AbortSignal): Promise<boolean> {
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
      if (test.skip || scheduled.has(test) || (test as any).__runtimeSkip) {
        return;
      }
      if (signal?.aborted) {
        return;
      }
      scheduled.add(test);

      testStatuses.set(test, 'running');
      testStartTimes.set(test, Date.now());
      await host.dispatchTestStart(test);
      if (signal?.aborted) {
        const result = createCancelledResult(test, Date.now() - (testStartTimes.get(test) || Date.now()));
        results.push(result);
        phaseResults.push(result);
        executedTests.add(test);
        testStatuses.set(test, 'cancelled');
        await host.dispatchTestEnd(test, result);
        return;
      }

      const result = await runTest(test, api, testState, server, rateLimiter, cfg, signal);
      results.push(result);
      phaseResults.push(result);
      executedTests.add(test);
      testStatuses.set(test, result.status === 'cancelled' ? 'cancelled' : 'completed');

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

      if (result.status === 'passed' && !signal?.aborted) {
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
      if (!test.skip && !executedTests.has(test) && !signal?.aborted) {
        runtimeSkipped.add(test);
      }
    });
    if (signal?.aborted) {
      debugLog(cfg, 'synthesizing cancellations after aborted phase', {
        phase: phaseName,
      });
      await synthesizeCancelledResults(testCases);
    }
    const phasePassed = testCases.every((test) => {
      return test.skip || (executedTests.has(test) && !runtimeSkipped.has(test));
    }) && phaseResults.every((r) => r.status === 'passed');
    return phasePassed;
  }

  try {
    const setupPassed = await runTests('setup', setupTests, runAbortController.signal);
    if (setupPassed && !runAbortController.signal.aborted) {
      await runTests('main', mainTests, runAbortController.signal);      
    } else {
      mainTests.forEach((test) => {
        if (!test.skip && !runAbortController.signal.aborted) {
          runtimeSkipped.add(test);
        }
      });
      if (runAbortController.signal.aborted) {
        debugLog(cfg, 'synthesizing main cancellations because setup/main signal aborted');
        await synthesizeCancelledResults(mainTests);
      }
    }
  } finally {
    await runTests('teardown', teardownTests);
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

    if (cfg.coverageReport) {
      await emitCoverageReport(cfg, tests, finalResults);
    }

    process.off('SIGINT', sigintHandler);
    const passed = finalResults.every((r) => r.status !== 'failed');
    process.exit(interrupted ? 130 : passed ? 0 : 1);
  }

  async function synthesizeCancelledResults(testCases: TestCase[]): Promise<void> {
    let synthesized = 0;
    for (const test of testCases) {
      const status = testStatuses.get(test);
      if (test.skip || executedTests.has(test) || status === 'completed' || status === 'cancelled') {
        continue;
      }
      const startedAt = testStartTimes.get(test);
      const result = createCancelledResult(test, startedAt ? Date.now() - startedAt : 0);
      results.push(result);
      executedTests.add(test);
      testStatuses.set(test, 'cancelled');
      synthesized += 1;
      await host.dispatchTestEnd(test, result);
    }
  }

  function resultOrder(result: TestResult): number | undefined {
    const test = tests.find((t) => t.operationId === result.operationId);
    return test ? testOrder.get(test) : undefined;
  }
}

function createSkippedResult(test: TestCase, status: SkipStatus): TestResult {
  return {
    status,
    error: test.skipReason,
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

function validateUniqueOperationIds(tests: TestCase[]): void {
  const seen = new Map<string, TestCase>();
  for (const test of tests) {
    if (!test.operationId) continue;
    const existing = seen.get(test.operationId);
    if (existing) {
      throw new Error(
        `Duplicate operationId '${test.operationId}' in '${test.name}' and '${existing.name}'`
      );
    }
    seen.set(test.operationId, test);
  }
}

function createCancelledResult(test: TestCase, latency: number): TestResult {
  return {
    status: 'cancelled',
    error: 'Cancelled by user',
    latency,
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

async function emitCoverageReport(cfg: any, tests: TestCase[], results: TestResult[]): Promise<void> {
  if (!cfg.openapi) {
    console.error('[spectest] --coverage-report requires --openapi to be set; skipping');
    return;
  }
  try {
    const rows = await buildCoverageReport(cfg.openapi, tests, results);
    const report = formatCoverageReport(rows);
    if (cfg.coverageReportFile) {
      await writeFile(cfg.coverageReportFile, `${report}\n`, 'utf8');
      console.log(`[spectest] Coverage report written to ${cfg.coverageReportFile}`);
    } else {
      console.log(`\n[spectest] OpenAPI contract coverage:\n${report}`);
    }
  } catch (error) {
    console.error('[spectest] Failed to generate coverage report:', (error as Error).message);
  }
}

function debugLog(cfg: any, message: string, details?: Record<string, any>): void {
  if (!cfg?.verbose) return;
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.error(`[spectest:debug] ${new Date().toISOString()} ${message}${suffix}`);
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

async function runTest(test: TestCase, api: HttpClient, testState: any, server: Server, rateLimiter: RateLimiter, cfg: any, signal?: AbortSignal): Promise<TestResult> {
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
    throwIfCancelled(signal);
    if (typeof test.delay === 'number' && test.delay > 0) {
      await abortableDelay(test.delay, signal);
    }
    throwIfCancelled(signal);

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
    throwIfCancelled(signal);

    if (cfg.recording !== 'off') {
      config.headers = { ...config.headers };
      config.headers['x-spectest-case-id'] = test.operationId || test.name;
      config.headers['x-spectest-test-name'] = test.name;
      config.headers['x-spectest-suite-name'] = test.suiteName || '';
      config.headers['x-spectest-recording-mode'] = resolveRecordingMode(test, cfg);
      config.headers['x-spectest-missing-recording-behavior'] = cfg.missingRecordingBehavior as MissingRecordingBehavior;
    }

    await rateLimiter.acquire(signal);
    throwIfCancelled(signal);
    const response = await api.request({ ...config, timeout: testTimeout, signal });

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
    throwIfCancelled(signal);

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
    if (isCancellationError(error, signal)) {
      return createCancelledResult(test, latency);
    }
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CancellationError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(new CancellationError());
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancellationError();
  }
}

function isCancellationError(error: any, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted &&
      (error instanceof CancellationError ||
        error?.name === 'AbortError' ||
        /cancelled|canceled/i.test(error?.message || ''))
  );
}

function validateWithSchema(data, schema) {
  if (schema?.__spectestJsonSchema) {
    return validateWithJsonSchema(data, schema.schema, schema.openapiVersion);
  }
  if (typeof schema.safeParse !== 'function') {
    return { success: false, errors: ['response schema is not a valid zod schema'] };
  }
  const result = schema.safeParse(data);
  return {
    success: result.success,
    errors: result.success ? [] : result.error.issues.map((i) => i.message),
  };
}

function validateWithJsonSchema(data, schema, openapiVersion?: string) {
  try {
    const jsonSchema = normalizeOpenApiSchema(schema);
    const ajv = String(openapiVersion || '').startsWith('3.1.')
      ? new Ajv2020({ allErrors: true, strict: false })
      : new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(jsonSchema);
    const success = validate(data);
    return {
      success: Boolean(success),
      errors: success ? [] : (validate.errors || []).map((error) => {
        const path = error.instancePath || '/';
        return `${path} ${error.message || 'failed validation'}`;
      }),
    };
  } catch (error) {
    return { success: false, errors: [error.message || 'invalid JSON schema'] };
  }
}

function normalizeOpenApiSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeOpenApiSchema(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === 'nullable' ||
      key === 'example' ||
      key === 'examples' ||
      key === 'discriminator' ||
      key === 'xml' ||
      key === 'externalDocs' ||
      key === 'deprecated' ||
      key === 'readOnly' ||
      key === 'writeOnly'
    ) {
      continue;
    }
    result[key] = normalizeOpenApiSchema(value);
  }

  if (schema.nullable === true) {
    const type = result.type;
    if (Array.isArray(type)) {
      result.type = [...new Set([...type, 'null'])];
    } else if (typeof type === 'string') {
      result.type = [type, 'null'];
    } else {
      const nonNullSchema = { ...result };
      result.anyOf = [...(Array.isArray(nonNullSchema.anyOf) ? nonNullSchema.anyOf : [nonNullSchema]), { type: 'null' }];
      delete result.type;
    }
  }

  return result;
}


if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv[2] === 'generate') {
    runGenerateCommand(process.argv).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  } else {
    loadConfig(process.argv).then((cfg) => {
      runAllTests(cfg).catch(console.error);
    });
  }
}
