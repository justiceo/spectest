import type { Suite, TestCase, TestResult, TestRunResult } from './types';

export interface SpectestContext {
  // Discovery Phase
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ suites: Suite[] } | null>): void;

  // Preparation Phase: Modify/Filter suites before running
  onPrepare(callback: (suites: Suite[]) => Promise<Suite[]> | Suite[]): void;

  // Network Phase: Transform the native Request object before execution
  onFetch(callback: (req: Request) => Promise<Request> | Request): void;

  // Execution Lifecycle
  onRunStart(callback: () => Promise<void> | void): void;
  onRunEnd(callback: (result: TestRunResult) => Promise<void> | void): void;

  // Test Granularity
  onTestStart(callback: (test: TestCase) => void): void;
  onTestEnd(callback: (test: TestCase, result: TestResult) => void): void;
}

export interface Plugin {
  name: string;
  setup: (ctx: SpectestContext) => void | Promise<void>;
}
