import type { Plugin } from '../plugin-api.js';
import type { TestCase, TestResult } from '../types.js';

function red(text: string): string {
  return `\u001b[31m${text}\u001b[39m`;
}

export const consoleReporterPlugin = (cfg: any): Plugin => ({
  name: 'console-reporter',
  setup(ctx) {
    let testStartTime: number;

    ctx.onRunStart(() => {
      console.log(`🚀 Starting E2E Tests against ${cfg.baseUrl}`);
      console.log('='.repeat(50));
      testStartTime = Date.now();
    });

    ctx.onTestEnd((test, result) => {
      if (!result) {
        console.log(`[❌] ${test.name} (0ms)`);
        console.log(red(`  Test failure reason: Test did not run`));
        return;
      }
      const icon = result.timedOut ? '⏰' : result.passed ? '✅' : '❌';
      console.log(`[${icon}] ${result.testName} (${result.latency}ms)`);
      if (!result.passed) {
        console.log(red(`  Test failure reason: ${result.error}`));
      }
    });

    ctx.onRunEnd((runResult) => {
      const { results, skippedTests } = runResult;
      const passed = results.filter((r) => r.passed).length;
      const total = results.length;

      if (skippedTests.length > 0) {
        console.log(`⏭️  Skipped ${skippedTests.length} tests:`);
        const skippedBySuite = skippedTests.reduce((acc, t) => {
          const s = t.suiteName || 'unknown';
          if (!acc[s]) {
            acc[s] = [];
          }
          acc[s].push(t);
          return acc;
        }, {} as Record<string, TestCase[]>);
        Object.entries(skippedBySuite).forEach(([suite, cases]) => {
          console.log(`  Suite: ${suite}`);
          cases.forEach((c) => {
            console.log(`    - ${c.name}`);
          });
        });
      }

      console.log('='.repeat(50));
      console.log(`✨ Tests completed: ${passed}/${total} passed`);

      if (results.length > 0) {
        const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
        const min = latencies[0];
        const max = latencies[latencies.length - 1];
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        console.log(`⏱️  Latency: min ${min}ms; avg ${Number(avg.toFixed(2))}ms; max ${max}ms`);
      }

      const totalTestTime = Date.now() - testStartTime;
      console.log(`⏱️  Testing time: ${(totalTestTime / 1000).toFixed(2)}s`);
    });
  },
});
