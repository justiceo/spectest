export interface RendererOptions {
  verbose?: boolean;
}

export default class Renderer {
  private verbose: boolean;

  constructor(options: RendererOptions = {}) {
    this.verbose = !!options.verbose;
  }

  red(text: string): string {
    return `\u001b[31m${text}\u001b[39m`;
  }

  start(baseUrl: string): void {
    console.log(`🚀 Starting E2E Tests against ${baseUrl}`);
    console.log('='.repeat(50));
  }

  runningOrder(order: number, count: number): void {
    console.log(`📋 Running tests with order ${order} (${count} tests)...`);
  }

  showSkippedTests(skipped: any[]): void {
    if (skipped.length === 0) return;
    console.log(`⏭️  Skipped ${skipped.length} tests:`);
    const skippedBySuite = skipped.reduce((acc: any, t: any) => {
      const s = t.suiteName || 'unknown';
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {} as Record<string, any[]>);
    Object.entries(skippedBySuite).forEach(([suite, cases]) => {
      console.log(`  Suite: ${suite}`);
      (cases as any[]).forEach((c) => {
        console.log(`    - ${c.name}`);
      });
    });
  }

  showResults(resultsBySuite: Record<string, any[]>, serverLogs: any[]): void {
    console.log('\n📊 Test Summary:');
    Object.entries(resultsBySuite).forEach(([suite, results]) => {
      console.log(`\n🗂️  Suite: ${suite}`);
      (results as any[]).forEach((result) => {
        const icon = result.timedOut ? '⏰' : result.passed ? '✅' : '❌';
        console.log(`[${icon}] ${result.testName} (${result.latency}ms)`);

        if (this.verbose || !result.passed) {
          const requestLogs = serverLogs.filter((log) => log.message.includes(result.requestId));
          if (requestLogs.length > 0) {
            requestLogs.forEach((entry) => {
              const message = entry.type === 'stderr'
                ? this.red(`  ${entry.timestamp}: ${entry.message}`)
                : `  ${entry.timestamp}: ${entry.message}`;
              console.log(message);
            });
          } else {
            console.log(`  No server logs found for request ID: ${result.requestId}`);
          }

          if (result.error) {
            console.log(this.red(`  Test failure reason: ${result.error}`));
          }

          console.log('');
        }
      });
    });
    console.log(`📋 Total server logs captured: ${serverLogs.length}`);
  }

  showLatency(testResults: any[]): void {
    if (testResults.length === 0) return;
    const latencies = testResults.map((r) => r.latency).sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const mid = Math.floor(latencies.length / 2);
    const median = latencies.length % 2 === 0 ? (latencies[mid - 1] + latencies[mid]) / 2 : latencies[mid];

    if (this.verbose) {
      console.log('\n⏱️  Latency Summary:');
      console.table([
        { Metric: 'Min (ms)', Value: min },
        { Metric: 'Median (ms)', Value: median },
        { Metric: 'Average (ms)', Value: Number(avg.toFixed(2)) },
        { Metric: 'Max (ms)', Value: max },
      ]);

      const slowCount = 5; // TODO: Move to config
      const slowTests = [...testResults].sort((a, b) => b.latency - a.latency).slice(0, slowCount);
      if (slowTests.length > 0) {
        console.log(`\n🐢 Slowest ${slowTests.length} Tests:`);
        console.table(slowTests.map((t) => ({ Test: t.testName, 'Latency (ms)': t.latency })));
      }
    } else {
      console.log(`\n⏱️  Latency: min ${min}ms; avg ${Number(avg.toFixed(2))}ms; max ${max}ms`);
    }
  }

  finalStats(passed: number, total: number, testTime: number, totalTime: number): void {
    console.log(`⏱️  Testing time: ${(testTime / 1000).toFixed(2)}s; Total time: ${(totalTime / 1000).toFixed(2)}s`);
    if (passed === total) {
      console.log(`✅  ${passed}/${total} tests passed!`);
    } else {
      console.log(`⚠️  ${passed}/${total} tests passed`);
    }
  }

  snapshotSaved(file: string): void {
    console.log(`📸 Snapshot saved to ${file}`);
  }
}
