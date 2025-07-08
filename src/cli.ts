import pc from 'picocolors';
import { readdir } from 'fs/promises';
import path from 'path';

import axios from 'axios';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import dotenv from 'dotenv';

import defaultConfig from './fest.config.ts';
import {
  start as startServerHelper,
  stop as stopServerHelper,
  getLogs as getServerLogs,
  setConfig as setServerHelperConfig,
} from './server-helper.ts';

let API_BASE_URL;
let ALLOWED_ORIGIN;
let api;

function parseArgs(argv) {
  const options = {};
  argv.forEach((arg) => {
    if (arg.startsWith('--config=')) {
      const [, val] = arg.split('=');
      options.configFile = val;
    } else if (arg.startsWith('--env=')) {
      const [, val] = arg.split('=');
      options.envFile = val;
    } else if (arg.startsWith('--baseUrl=')) {
      const [, val] = arg.split('=');
      options.baseUrl = val;
    } else if (arg.startsWith('--suitesDir=')) {
      const [, val] = arg.split('=');
      options.suitesDir = val;
    } else if (arg.startsWith('--testMatch=')) {
      const [, val] = arg.split('=');
      options.testMatch = val;
    } else if (arg.startsWith('--startCmd=')) {
      const [, val] = arg.split('=');
      options.startCmd = val;
    } else if (arg.startsWith('--runningServer=')) {
      const [, val] = arg.split('=');
      options.runningServer = val;
    } else if (arg.startsWith('--tags=')) {
      options.tags = arg
        .split('=')[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (!arg.startsWith('-') && !options.suiteFile) options.suiteFile = arg;
  });
  return options;
}

async function loadConfig() {
  const cliOpts = parseArgs(process.argv.slice(2));
  let cfg = { ...defaultConfig };

  if (cliOpts.configFile) {
    const mod = await import(path.resolve(cliOpts.configFile));
    cfg = { ...cfg, ...(mod.default || mod) };
  }

  cfg = { ...cfg, ...cliOpts };
  cfg.runningServer = cfg.runningServer || 'reuse';

  if (cfg.envFile) {
    dotenv.config({ path: cfg.envFile });
  }

  API_BASE_URL = cfg.baseUrl || process.env.API_BASE_URL;
  const [origin] = (process.env.ALLOWED_ORIGINS || '').split(',');
  ALLOWED_ORIGIN = origin;
  api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    validateStatus: () => true,
  });

  setServerHelperConfig({
    allowedOrigin: ALLOWED_ORIGIN,
    startCommand: cfg.startCmd,
    serverUrl: cfg.baseUrl,
    runningServer: cfg.runningServer,
  });

  return cfg;
}

async function discoverSuites(cfg) {
  if (cfg.suiteFile) {
    const suitePath = path.resolve(cfg.suiteFile);
    const mod = await import(suitePath);
    return Array.isArray(mod.default) ? [...mod.default] : [];
  }

  const suitesDir = path.resolve(cfg.suitesDir);
  const files = await readdir(suitesDir);
  const pattern = new RegExp(cfg.testMatch);
  const suiteFiles = files.filter((f) => pattern.test(f)).sort();
  const modules = await Promise.all(suiteFiles.map((file) => import(path.join(suitesDir, file))));
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
  const requestId = randomUUID().substring(0, 5);
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
      config = await test.beforeSend(config, immutableState);
    }

    const response = await api(config);

    const [sessionCookie] = response.headers['set-cookie'] || [];
    if (sessionCookie) {
      testState.sessionCookie = sessionCookie;
    }

    if (typeof test.postTest === 'function') {
      const requestLogs = getServerLogs().filter((log) => log.message.includes(requestId));
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
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    return {
      passed: false,
      error: error.message,
      latency,
      requestId,
      testName: test.name,
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
    const totalRuns = repeat + 1;
    const baseOrder = test.order ?? 0;
    return Array.from({ length: totalRuns }).map((_, idx) => {
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

async function runTestsInOrder(tests, options = {}) {
  const { tags } = options;
  const expanded = expandRepeats(tests);
  const focusResult = filterTestsByFocus(expanded);
  const tagResult = filterTestsByTags(focusResult.filtered, tags);
  const testGroups = groupTestsByOrder(tagResult.filtered);
  const skippedTests = [...focusResult.skipped, ...tagResult.skipped];
  const allResults = await Array.from(testGroups).reduce(async (accPromise, [order, testsInGroup]) => {
    const accumulator = await accPromise;
    const runnableTests = testsInGroup.filter((t) => !t.skip);
    const groupSkipped = testsInGroup.filter((t) => t.skip);
    skippedTests.push(...groupSkipped);
    console.log(`📋 Running tests with order ${order} (${runnableTests.length} tests)...`);
    const groupResults = await Promise.all(
      runnableTests.map(async (test) => {
        const result = await runTest(test);
        return result;
      })
    );
    return [...accumulator, ...groupResults];
  }, Promise.resolve([]));
  return { results: allResults, skippedTests };
}

async function runAllTests(cfg, verbose = false, tags = []) {
  const progStart = Date.now();
  console.log(`🚀 Starting E2E Tests against ${API_BASE_URL}`);
  console.log('='.repeat(50));

  const tests = await discoverSuites(cfg);

  try {
    await startServerHelper();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }

  console.log('📋 Running tests...');
  const testStart = Date.now();
  const { results: testResults, skippedTests } = await runTestsInOrder(tests, { tags });
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
  const serverLogs = getServerLogs();

  testResults.forEach((result) => {
    console.log(`[${result.passed ? '✅' : '❌'}] ${result.testName} (${result.latency}ms)`);

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

  await stopServerHelper();

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

if (import.meta.url === `file://${process.argv[1]}`) {
  loadConfig().then((cfg) => {
    const verbose = cfg.verbose || false;
    const tags = cfg.tags || [];
    runAllTests(cfg, verbose, tags).catch(console.error);
  });
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  await stopServerHelper();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  await stopServerHelper();
  process.exit(0);
});

export { runAllTests };
