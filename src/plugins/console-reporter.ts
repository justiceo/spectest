import type { Plugin } from '../plugin-api.js';
import type { TestCase, TestResult } from '../types.js';

function red(text: string): string {
  return `\u001b[31m${text}\u001b[39m`;
}

function green(text: string): string {
  return `\u001b[32m${text}\u001b[39m`;
}

function drawProgressBar(passed: number, failed: number, total: number, width: number = 30): string {
  const passedWidth = Math.round((passed / total) * width) || 0;
  const failedWidth = Math.round((failed / total) * width) || 0;
  const pendingWidth = width - passedWidth - failedWidth;

  const passedBar = green('█'.repeat(passedWidth));
  const failedBar = red('█'.repeat(failedWidth));
  const pendingBar = '░'.repeat(pendingWidth);

  return `[${passedBar}${failedBar}${pendingBar}]`;
}

export const consoleReporterPlugin = (cfg: any): Plugin => ({
  name: 'console-reporter',
  setup(ctx) {
    let testStartTime: number;
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    ctx.onRunStart((tests) => {
      console.log(`🚀 Starting E2E Tests against ${cfg.baseUrl}`);
      console.log('='.repeat(50));
      testStartTime = Date.now();
      totalTests = tests.length;
    });

    ctx.onTestEnd((test, result) => {
      if (result?.passed) {
        passedTests++;
      } else {
        failedTests++;
      }
      const progress = passedTests + failedTests;
      const bar = drawProgressBar(passedTests, failedTests, totalTests);
      const percentage = ((progress / totalTests) * 100).toFixed(0);
      process.stdout.write(`  Progress: ${bar} ${percentage}% (${progress}/${totalTests})\r`);
    });

    ctx.onRunEnd((runResult) => {
      process.stdout.write('\n'); // Clear progress bar line

      const { results, skippedTests } = runResult;
      const passed = results.filter((r) => r.passed).length;
      const total = results.length;

      const resultsBySuite = results.reduce((acc, r) => {
        const suiteName = r.suiteName || 'unknown';
        if (!acc[suiteName]) {
          acc[suiteName] = [];
        }
        acc[suiteName].push(r);
        return acc;
      }, {} as Record<string, TestResult[]>);

      console.log('\n📊 Test Summary:');
      Object.entries(resultsBySuite).forEach(([suite, suiteResults]) => {
        console.log(`\n🗂️  Suite: ${suite}`);
        suiteResults.forEach((result) => {
          const icon = result.timedOut ? '⏰' : result.passed ? '✅' : '❌';
          console.log(`  [${icon}] ${result.testName} (${result.latency}ms)`);
          if (!result.passed) {
            console.log(red(`    Test failure reason: ${result.error}`));
          }
        });
      });

      if (skippedTests.length > 0) {
        console.log(`\n⏭️  Skipped ${skippedTests.length} tests:`);
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

      console.log('\n' + '='.repeat(50));
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
