import pc from 'picocolors';
import { readdir, writeFile, readFile } from 'fs/promises';
import { existsSync, realpathSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import axios from 'axios';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { loadConfig } from './config';
import Server from './server';
import RateLimiter from './rate-limiter';
import { resolveUserAgent } from './user-agents';


let API_BASE_URL;
let ALLOWED_ORIGIN;
let api;
let rateLimiter;
const server = new Server();

function setupEnvironment(cfg) {
  API_BASE_URL = cfg.baseUrl || process.env.API_BASE_URL;
  const [origin] = (process.env.ALLOWED_ORIGINS || '').split(',');
  ALLOWED_ORIGIN = origin;
  api = axios.create({
    baseURL: API_BASE_URL,
    timeout: cfg.timeout || 30000,
    validateStatus: () => true,
  });
  api.defaults.headers.common['User-Agent'] = resolveUserAgent(cfg.userAgent);

  server.setConfig({
    allowedOrigin: ALLOWED_ORIGIN,
    startCommand: cfg.startCmd,
    serverUrl: cfg.baseUrl,
    runningServer: cfg.runningServer,
  });

  rateLimiter = new RateLimiter(cfg.rps || Infinity);
}

async function discoverSuites(cfg) {
  if (cfg.suiteFile) {
    const suitePath = path.resolve(cfg.projectRoot || process.cwd(), cfg.suiteFile);
    const mod = await import(suitePath);
    return Array.isArray(mod.default) ? [...mod.default] : [];
  }

  const testDir = path.resolve(cfg.projectRoot || process.cwd(), cfg.testDir);
  const files = await readdir(testDir);
  const pattern = new RegExp(cfg.filePattern);
  const suiteFiles = files.filter((f) => pattern.test(f)).sort();
  const modules = await Promise.all(suiteFiles.map((file) => import(path.join(testDir, file))));
  return modules.reduce((all, mod) => {
    if (Array.isArray(mod.default)) {
      all.push(...mod.default);
    }
    return all;
  }, []);
}

const testState = {
  sessionToken: null,
  sessionCookie: null,
  userId: null,
  paymentIntentId: null,
  testUserEmail: null,
  oneTimeToken: null,
  ticketId: null,
};

function convertJsonSchemaToZod(schema) {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }
  if (schema.safeParse) {
    return schema;
  }
  switch (schema.type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      if (schema.pattern) s = s.regex(new RegExp(schema.pattern));
      return s;
    }
    case 'number':
    case 'integer': {
      let n = z.number();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const itemSchema = convertJsonSchemaToZod(schema.items || {});
      let a = z.array(itemSchema);
      if (typeof schema.minItems === 'number') a = a.min(schema.minItems);
      if (typeof schema.maxItems === 'number') a = a.max(schema.maxItems);
      return a;
    }
    case 'object':
    default: {
      const shape = {};
      const properties = schema.properties || {};
      Object.entries(properties).forEach(([key, propSchema]) => {
        let prop = convertJsonSchemaToZod(propSchema);
        if (!schema.required || !schema.required.includes(key)) {
          prop = prop.optional();
        }
        shape[key] = prop;
      });
      let obj = z.object(shape);
      if (schema.additionalProperties) obj = obj.passthrough();
      else obj = obj.strict();
      return obj;
    }
  }
}

function validateWithSchema(data, schema) {
  const zodSchema = convertJsonSchemaToZod(schema);
  const result = zodSchema.safeParse(data);
  return {
    success: result.success,
    errors: result.success ? [] : result.error.issues.map((i) => i.message),
  };
}

async function runTest(test) {
  if (typeof test.delay === 'number' && test.delay > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, test.delay);
    });
  }
  const startTime = Date.now();
  let providedId;
  if (test.request?.headers) {
    for (const [h, v] of Object.entries(test.request.headers)) {
      if (h.toLowerCase() === 'x-request-id') {
        providedId = String(v);
        break;
      }
    }
  }
  const requestId = providedId || randomUUID().substring(0, 5);
  const testTimeout =
    typeof test.timeout === 'number' && !Number.isNaN(test.timeout)
      ? test.timeout
      : api.defaults.timeout;
  try {
    let config = {
      method: test.request?.method || 'GET',
      url: test.endpoint,
      data: test.request?.body,
      headers: {
        'x-request-id': requestId,
        Origin: ALLOWED_ORIGIN,
        'X-Requested-With': 'XMLHttpRequest',
        ...(test.request?.headers || {}),
      },
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
      const requestLogs = server.getLogs().filter((log) => log.message.includes(requestId));
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

    if (expectedResponse.jsonSchema) {
      const result = validateWithSchema(response.data, expectedResponse.jsonSchema);
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

function groupTestsByOrder(tests) {
  const testGroups = new Map();
  tests.forEach((test) => {
    const order = test.order ?? 0;
    if (!testGroups.has(order)) {
      testGroups.set(order, []);
    }
    testGroups.get(order).push(test);
  });
  return new Map([...testGroups.entries()].sort(([a], [b]) => a - b));
}

function expandRepeats(tests) {
  return tests.flatMap((test) => {
    const repeat = Number.isFinite(Number(test.repeat)) ? Number(test.repeat) : 0;
    const bombard = Number.isFinite(Number(test.bombard)) ? Number(test.bombard) : 0;
    const totalRuns = repeat + 1;
    const baseOrder = test.order ?? 0;

    const repeated = Array.from({ length: totalRuns }).map((_, idx) => {
      if (idx === 0) {
        // eslint-disable-next-line no-param-reassign
        test.order = baseOrder;
        return test;
      }
      const clone = Object.assign(Object.create(Object.getPrototypeOf(test)), test);
      clone.name = `(Run ${idx + 1}) ${test.name}`;
      clone.order = baseOrder + idx;
      return clone;
    });

    return repeated.flatMap((t) => {
      const totalBombs = bombard + 1;
      return Array.from({ length: totalBombs }).map((_, bIdx) => {
        if (bIdx === 0) return t;
        const clone = Object.assign(Object.create(Object.getPrototypeOf(t)), t);
        clone.name = `(Bombard ${bIdx + 1}) ${t.name}`;
        clone.order = t.order;
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

async function runTestsInOrder(tests, options = {}) {
  const { tags, randomize, bail, happy, filter, snapshotFile } = options;
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
  const testGroups = groupTestsByOrder(happyResult.filtered);
  const skippedTests = [
    ...focusResult.skipped,
    ...tagResult.skipped,
    ...nameResult.skipped,
    ...happyResult.skipped,
  ];
  const initial = Promise.resolve({ results: [], bail: false });
  const final = await Array.from(testGroups).reduce(async (accPromise, [order, testsInGroup]) => {
    const accumulator = await accPromise;
    if (accumulator.bail) {
      skippedTests.push(...testsInGroup);
      return accumulator;
    }

    const runnableTests = testsInGroup.filter((t) => !t.skip);
    const groupSkipped = testsInGroup.filter((t) => t.skip);
    skippedTests.push(...groupSkipped);
    if (randomize) {
      shuffle(runnableTests);
    }
    console.log(`📋 Running tests with order ${order} (${runnableTests.length} tests)...`);
    const groupResults = await Promise.all(
      runnableTests.map(async (test) => {
        const result = await runTest(test);
        return result;
      })
    );
    const failed = groupResults.some((r) => !r.passed);
    return {
      results: [...accumulator.results, ...groupResults],
      bail: bail && failed,
    };
  }, initial);
  return { results: final.results, skippedTests };
}

async function runAllTests(cfg, verbose = false, tags = []) {
  const progStart = Date.now();
  console.log(`🚀 Starting E2E Tests against ${API_BASE_URL}`);
  console.log('='.repeat(50));

  const tests = await discoverSuites(cfg);

  // TODO: Do not proceed if tests array is empty.

  try {
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  console.log('📋 Running tests...');
  const testStart = Date.now();
  const { results: testResults, skippedTests } = await runTestsInOrder(tests, {
    tags,
    randomize: cfg.randomize,
    bail: cfg.bail,
    happy: cfg.happy,
    filter: cfg.filter,
    snapshotFile: cfg.snapshotFile
  });
  const totalTestTime = Date.now() - testStart;
  const passed = testResults.filter((r) => r.passed).length;
  const total = testResults.length;
  const skipped = skippedTests.length;

  console.log('='.repeat(50));
  console.log(`✨ Tests completed: ${passed}/${total} passed`);
  if (skipped > 0) {
    console.log(`⏭️  Skipped ${skipped} tests:`);
    skippedTests.forEach((t) => {
      console.log(`  - ${t.name}`);
    });
  }

  console.log('\n📊 Test Summary:');
  const serverLogs = server.getLogs();

  testResults.forEach((result) => {
    const icon = result.timedOut ? '⏰' : result.passed ? '✅' : '❌';
    console.log(`[${icon}] ${result.testName} (${result.latency}ms)`);

    if (verbose || !result.passed) {
      const requestLogs = serverLogs.filter((log) => log.message.includes(result.requestId));
      if (requestLogs.length > 0) {
        requestLogs.forEach((entry) => {
          const message =
            entry.type === 'stderr'
              ? pc.red(`  ${entry.timestamp}: ${entry.message}`)
              : `  ${entry.timestamp}: ${entry.message}`;
          console.log(message);
        });
      } else {
        console.log(`  No server logs found for request ID: ${result.requestId}`);
      }

      if (result.error) {
        console.log(pc.red(`  Test failure reason: ${result.error}`));
      }

      console.log('');
    }
  });

  console.log(`📋 Total server logs captured: ${serverLogs.length}`);

  if (testResults.length > 0) {
    const latencies = testResults.map((r) => r.latency).sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const mid = Math.floor(latencies.length / 2);
    const median = latencies.length % 2 === 0 ? (latencies[mid - 1] + latencies[mid]) / 2 : latencies[mid];

    console.log('\n⏱️  Latency Summary:');
    console.table([
      { Metric: 'Min (ms)', Value: min },
      { Metric: 'Median (ms)', Value: median },
      { Metric: 'Average (ms)', Value: Number(avg.toFixed(2)) },
      { Metric: 'Max (ms)', Value: max },
    ]);

    const slowCount = parseInt(process.env.SLOW_TEST_COUNT || '5', 10);
    const slowTests = [...testResults].sort((a, b) => b.latency - a.latency).slice(0, slowCount);
    if (slowTests.length > 0) {
      console.log(`\n🐢 Slowest ${slowTests.length} Tests:`);
      console.table(slowTests.map((t) => ({ Test: t.testName, 'Latency (ms)': t.latency })));
    }
  }
  
  if (cfg.snapshotFile) {
    const snapshotCases = testResults.map((r) => ({
      name: r.testName,
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
      console.log(`\uD83D\uDCF8 Snapshot saved to ${cfg.snapshotFile}`);
    } catch (err) {
      console.error('Failed to write snapshot:', err.message);
    }
  }

  await server.stop();
  if (rateLimiter) {
    rateLimiter.stop();
  }

  const totalTime = Date.now() - progStart;
  console.log(`⏲️  Testing time: ${(totalTestTime / 1000).toFixed(2)}s`);
  console.log(`⏲️  Elapsed time (incl. server startup/teardown): ${(totalTime / 1000).toFixed(2)}s`);

  if (passed === total) {
    console.log(`🎉  ${passed}/${total} tests passed!`);
    process.exit(0);
  } else {
    console.log(`⚠️  ${passed}/${total} tests passed`);
    process.exit(1);
  }
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
