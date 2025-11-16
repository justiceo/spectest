import type { Plugin, SpectestContext } from './plugin-api.js';
import type { Suite, TestCase, TestResult, TestRunResult } from './types.js';

type Noop = (...args: any[]) => void;

const noop = () => {};

export class PluginHost {
  private plugins: Plugin[] = [];

  // Callbacks
  private onLoadCb: ((args: { path: string }) => Promise<{ suites: Suite[] } | null>) | Noop = noop;
  private onPrepareCbs: ((suites: Suite[]) => Promise<Suite[]> | Suite[])[] = [];
  private onFetchCbs: ((req: Request) => Promise<Request> | Request)[] = [];
  private onRunStartCbs: (() => Promise<void> | void)[] = [];
  private onRunEndCbs: ((result: TestRunResult) => Promise<void> | void)[] = [];
  private onTestStartCbs: ((test: TestCase) => void)[] = [];
  private onTestEndCbs: ((test: TestCase, result: TestResult) => void)[] = [];

  public context: SpectestContext = {
    onLoad: (options, callback) => {
      this.onLoadCb = callback;
    },
    onPrepare: (callback) => {
      this.onPrepareCbs.push(callback);
    },
    onFetch: (callback) => {
      this.onFetchCbs.push(callback);
    },
    onRunStart: (callback) => {
      this.onRunStartCbs.push(callback);
    },
    onRunEnd: (callback) => {
      this.onRunEndCbs.push(callback);
    },
    onTestStart: (callback) => {
      this.onTestStartCbs.push(callback);
    },
    onTestEnd: (callback) => {
      this.onTestEndCbs.push(callback);
    },
  };

  constructor(plugins: Plugin[]) {
    this.plugins = plugins;
  }

  public async setup(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(this.context);
    }
  }

  public async loadSuites(path: string): Promise<Suite[]> {
    if (this.onLoadCb === noop) return [];
    const result = await this.onLoadCb({ path });
    return result?.suites || [];
  }

  public async prepareSuites(suites: Suite[]): Promise<Suite[]> {
    let result = suites;
    for (const cb of this.onPrepareCbs) {
      result = await cb(result);
    }
    return result;
  }

  public async transformRequest(req: Request): Promise<Request> {
    let result = req;
    for (const cb of this.onFetchCbs) {
      result = await cb(result);
    }
    return result;
  }

  public async dispatch(event: 'onRunStart'): Promise<void>;
  public async dispatch(event: 'onRunEnd', arg: TestRunResult): Promise<void>;
  public async dispatch(event: 'onTestStart', arg: TestCase): Promise<void>;
  public async dispatch(event: 'onTestEnd', arg1: TestCase, arg2: TestResult): Promise<void>;
  public async dispatch(event: string, ...args: any[]): Promise<void> {
    switch (event) {
      case 'onRunStart':
        for (const cb of this.onRunStartCbs) await cb();
        break;
      case 'onRunEnd':
        for (const cb of this.onRunEndCbs) await cb(args[0]);
        break;
      case 'onTestStart':
        for (const cb of this.onTestStartCbs) await cb(args[0]);
        break;
      case 'onTestEnd':
        for (const cb of this.onTestEndCbs) await cb(args[0], args[1]);
        break;
      default:
        break;
    }
  }
}
