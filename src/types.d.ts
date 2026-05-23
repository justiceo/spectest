export interface CaseRequest extends RequestInit {
  body?: any;
  headers?: HeadersInit;
}

export interface CaseResponse extends Partial<Response> {
  /** Expected JSON payload for assertion */
  json?: any;
  /** Zod or JSON schema to validate the response body */
  schema?: any;
  /** Expected headers. If the value is boolean true, header presence is asserted */
  headers?: Record<string, string | boolean>;
}

export interface TestCase {
  /** Unique name for the test */
  name: string;
  /** Endpoint path relative to the base url */
  endpoint: string;
  /** Optional operation identifier */
  operationId?: string;
  /** Tags used for filtering */
  tags?: string | string[];
  /** Test dependencies */
  dependsOn?: string[];
  /** Execution phase */
  phase?: 'setup' | 'main' | 'teardown';
  /** Request options */
  request?: CaseRequest;
  /** Expected response assertions */
  response?: CaseResponse;
  /** Delay in milliseconds before execution */
  delay?: number;
  /** Number of extra times to repeat the test */
  repeat?: number;
  /** Number of bombard runs */
  bombard?: number;
  /** Skip this test completely */
  skip?: boolean;
  /** Mark as focused */
  focus?: boolean;
  /** Requests per second override */
  rps?: number;
  /** Per-test timeout in milliseconds */
  timeout?: number;
  /** Called before sending the request */
  beforeSend?: (req: any, state: any) => Promise<any> | any;
  /** Called after receiving the response */
  postTest?: (res: any, state: any, ctx: any) => Promise<any> | any;
  /** Provided by the runner */
  suiteName?: string;
}

export interface Suite {
  name: string;
  tests: TestCase[];
  /** Path the suite was loaded from */
  loadPath?: string;
  /** Setup tests */
  setup: TestCase[];
  /** Teardown tests */
  teardown: TestCase[];
}

export type RuntimeTestCase = TestCase & {
  dependents: RuntimeTestCase[];
  unresolvedDependencies: number;
  failedPrecondition: boolean;
};

export type TestOutputMode = 'summary' | 'errors';

export interface SpectestConfig {
  configFile?: string;
  baseUrl?: string;
  testDir?: string;
  filePattern?: string;
  startCmd?: string;
  buildCmd?: string;
  runningServer?: string;
  tags?: string[];
  rps?: number;
  timeout?: number;
  snapshotFile?: string;
  randomize?: boolean;
  happy?: boolean;
  filter?: string;
  verbose?: boolean;
  testOutput?: TestOutputMode;
  userAgent?: string;
  proxy?: string;
  suiteFile?: string;
  projectRoot?: string;
}

export type TestResultStatus = 'passed' | 'failed' | 'skipped' | 'failed-precondition';

export interface TestResult {
  status: TestResultStatus;
  error?: string;
  latency: number;
  requestId?: string | null;
  testName: string;
  operationId: string;
  suiteName: string;
  timedOut?: boolean;
  request: any;
  response: {
    status: number;
    headers: any;
    data: any;
  };
}

export interface TestRunResult {
  results: TestResult[];
  serverLogs: ServerLog[];
}

export interface ServerLog {
  timestamp: string;
  message: string;
  type: 'stdout' | 'stderr';
}
