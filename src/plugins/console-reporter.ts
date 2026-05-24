import type { Plugin } from '../plugin-api.js';
import type { SpectestConfig, TestResult, TestResultStatus } from '../types.js';

function red(text: string): string {
  return `\u001b[31m${text}\u001b[39m`;
}

function green(text: string): string {
  return `\u001b[32m${text}\u001b[39m`;
}

function yellow(text: string): string {
  return `\u001b[33m${text}\u001b[39m`;
}

function gray(text: string): string {
  return `\u001b[90m${text}\u001b[39m`;
}

function drawProgressBar(passed: number, failed: number, cancelled: number, total: number, width: number = 30): string {
  if (total === 0) {
    const pendingBar = '░'.repeat(width);
    return `[${pendingBar}]`;
  }
  const completed = passed + failed + cancelled;
  const completedWidth = Math.round((completed / total) * width);
  const passedWidth = Math.round((passed / total) * width);
  const failedWidth = Math.min(completedWidth - passedWidth, Math.round((failed / total) * width));
  const cancelledWidth = completedWidth - passedWidth - failedWidth;
  const pendingWidth = width - completedWidth;

  const passedBar = green('█'.repeat(passedWidth));
  const failedBar = red('█'.repeat(failedWidth));
  const cancelledBar = yellow('█'.repeat(cancelledWidth));
  const pendingBar = '░'.repeat(pendingWidth);

  return `[${passedBar}${failedBar}${cancelledBar}${pendingBar}]`;
}

function resultIcon(result: TestResult): string {
  if (result.timedOut) return '⏰';

  const icons: Record<TestResultStatus, string> = {
    passed: '✅',
    failed: '❌',
    skipped: yellow('⏭️ '),
    'failed-precondition': gray('↷ '),
    cancelled: yellow('⛔'),
  };
  return icons[result.status];
}

function shouldShowFailureDetails(cfg: SpectestConfig, result: TestResult): boolean {
  return cfg.testOutput === 'errors' && result.status === 'failed';
}

export const consoleReporterPlugin = (cfg: SpectestConfig): Plugin => ({
  name: 'console-reporter',
  setup(ctx) {
    let testStartTime: number;
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let cancelledTests = 0;

    ctx.onRunStart((tests) => {
      console.log(`🚀 Starting E2E Tests against ${cfg.baseUrl}`);
      console.log('='.repeat(50));
      testStartTime = Date.now();
      totalTests = tests.length;
    });

    ctx.onTestEnd((test, result) => {
      if (result.status === 'passed') {
        passedTests++;
      } else if (result.status === 'failed') {
        failedTests++;
      } else if (result.status === 'cancelled') {
        cancelledTests++;
      }
      const progress = passedTests + failedTests + cancelledTests;
      const bar = drawProgressBar(passedTests, failedTests, cancelledTests, totalTests);
      const percentage = ((progress / totalTests) * 100).toFixed(0);
      process.stdout.write(`  Progress: ${bar} ${percentage}% (${progress}/${totalTests})\r`);
    });

    ctx.onRunEnd((runResult) => {
      process.stdout.write('\n'); // Clear progress bar line

      const { results, serverLogs } = runResult;
      const passed = results.filter((r) => r.status === 'passed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const failedPreconditions = results.filter((r) => r.status === 'failed-precondition').length;
      const cancelled = results.filter((r) => r.status === 'cancelled').length;
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
          const icon = resultIcon(result);
          console.log(`  [${icon}] ${result.testName} (${result.latency}ms)`);
          if (shouldShowFailureDetails(cfg, result)) {
            const requestLogs = result.requestId
              ? serverLogs.filter((log) => log.message.includes(result.requestId!))
              : [];
            if (requestLogs.length > 0) {
              requestLogs.forEach((entry) => {
                const message =
                  entry.type === 'stderr'
                    ? red(`    ${entry.timestamp}: ${entry.message}`)
                    : `    ${entry.timestamp}: ${entry.message}`;
                console.log(message);
              });
            } else if (result.requestId) {
              console.log(`    No server logs found for request ID: ${result.requestId}`);
            }

            if (result.error) {
              console.log(red(`    Test failure reason: ${result.error}`));
            }
          }
        });
      });

      console.log('\n' + '='.repeat(50));
      const totalTestTime = Date.now() - testStartTime;
      const skipSummary = failedPreconditions > 0
        ? `${skipped} skipped, ${failedPreconditions} failed precondition`
        : `${skipped} skipped`;
      console.log(`✨ Tests completed: ${passed}/${total} passed, ${cancelled} cancelled, ${skipSummary} in ${(totalTestTime / 1000).toFixed(2)}s`);

      if (results.length > 0) {
        const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
        const min = latencies[0];
        const max = latencies[latencies.length - 1];
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        console.log(`⏱️  Latency: min ${min}ms; avg ${Number(avg.toFixed(2))}ms; max ${max}ms`);
      }
    });
  },
});
