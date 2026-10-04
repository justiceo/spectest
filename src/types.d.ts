export interface CaseRequest extends RequestInit {
  body?: any;
  headers?: HeadersInit;
}

export interface CaseResponse extends Partial<Response> {
  /** Expected JSON payload for assertion */
  json?: any;
  /** Zod schema, or a raw JSON Schema / OpenAPI Schema Object, to validate the response body */
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
  /** Why this test is skipped */
  skipReason?: string;
  /** Mark as focused */
  focus?: boolean;
  /** Requests per second override */
  rps?: number;
  /** Per-test timeout in milliseconds */
  timeout?: number;
  /** Per-test HTTP recording override */
  recording?: RecordingMode;
  /** Called before sending the request */
  beforeSend?: (req: any, state: any) => Promise<any> | any;
  /** Called after receiving the response */
  postTest?: (res: any, state: any, ctx: any) => Promise<any> | any;
  /** Provided by the runner */
  suiteName?: string;
  /**
   * Concrete values produced by `x-spectest.generate` for this case, keyed by
   * the generate-map path. Surfaced on the completed result so dependents can
   * reference them via a `$generated.<key>` link expression.
   */
  generatedValues?: Record<string, string>;
  /**
   * Custom assertions, run after the built-in status/header/json/schema checks.
   * Returned strings are reported as failures; unlike throwing from `postTest`,
   * the full response stays on the result.
   */
  assert?: (response: TestResponse, state: any, ctx: AssertContext) => AssertOutcome | Promise<AssertOutcome>;
  /** Re-run the whole send/assert cycle when it fails (or when `shouldRetry` says so). */
  retry?: RetryConfig;
  /**
   * Evaluated when the test becomes ready to run. Returning false (or
   * `{ skip: reason }`) skips it *without* failing its dependents: they are
   * released as if it had passed (a "pass-through" skip).
   */
  when?: (state: any) => WhenOutcome | Promise<WhenOutcome>;
  /** A test node that sends no HTTP request; its `assert` hook alone decides pass/fail. */
  virtual?: boolean;
  /** Leave this test out of results unless it actually ran (used for unrolled/conditional nodes). */
  quiet?: boolean;
  /** Provenance metadata set by loaders (e.g. `{ kind: 'arazzo', workflowId, stepId }`). */
  source?: TestSource;
}

export interface TestSource {
  kind: string;
  [key: string]: unknown;
}

export interface TestResponse {
  status: number;
  headers: Headers;
  data: any;
}

export interface AssertContext {
  /** 1-based attempt number when `retry` is configured. */
  attempt: number;
  /** Scratch object that persists across the attempts of one run of this test. */
  scratch: Record<string, any>;
  /** The request config that was sent (`url`, `method`, `headers`, `data`). */
  request: any;
  requestId: string | null;
  logs: ServerLog[];
}

export type AssertOutcome =
  | void
  | string[]
  | {
      errors?: string[];
      /** Informational message shown with the result (e.g. why a failure was tolerated). */
      note?: string;
      /** Ask the runner to retry (subject to `retry.limit`), or forbid a retry with `false`. */
      retry?: { delayMs?: number } | false;
      /** For `virtual` tests: the data to record as the result's response body. */
      data?: any;
    };

export interface RetryConfig {
  /** Maximum number of extra attempts. */
  limit: number;
  /** Delay between attempts in milliseconds (default 0). */
  delayMs?: number;
  /** Decide whether to retry; defaults to retrying while the result is `failed`. */
  shouldRetry?: (result: TestResult, attempt: number) => boolean | { delayMs?: number };
}

/** `quiet: true` hides this particular skip from results (like `TestCase.quiet`). */
export type WhenOutcome = boolean | { skip: string; quiet?: boolean };

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
export type RunningServerMode = 'reuse' | 'fail' | 'kill';
export type RecordingMode = 'off' | 'replay' | 'record';
export type MissingRecordingBehavior = 'fail' | 'record' | 'bypass';
export interface SerializedHttpRequest {
  id?: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string | null;
}
export type RecordingUrlExclusion =
  | string
  | RegExp
  | ((url: URL, request: SerializedHttpRequest) => boolean);

/**
 * Caps outbound requests the Node SUT process makes to a matching backend
 * (e.g. a rate-limited third party like Openprovider) at `rps` requests per
 * second. `match` is tested against the full outbound request URL: a string
 * is a substring match, a RegExp is tested directly. The first matching rule
 * applies; later rules are not consulted for a request that already matched.
 */
export interface OutboundThrottleRule {
  match: string | RegExp;
  rps: number;
  name?: string;
}

export type OpenApiRequestMutation = {
  headers?: HeadersInit;
  query?: Record<string, string>;
  cookies?: Record<string, string>;
  /**
   * Set to 'include' to have the generated request send the ambient session
   * cookie captured from any earlier response in the run (the same
   * mechanism hand-written `credentials: 'include'` test cases use) instead
   * of a static cookie value baked in at suite-load time. Needed for auth
   * schemes whose valid value can only be obtained by actually running a
   * login flow (e.g. magic-link), since openapiAuth hooks execute before
   * the server under test has been started.
   */
  credentials?: RequestCredentials;
};

export type OpenApiRequestMutator = (ctx: {
  schemeName: string;
  scheme: unknown;
  operation: unknown;
  method: string;
  path: string;
}) => Promise<OpenApiRequestMutation | void> | OpenApiRequestMutation | void;

/** A single scheme entry: either the default hook, or a named-variant map (e.g. valid/expired/missing) */
export type OpenApiAuthEntry = OpenApiRequestMutator | Record<string, OpenApiRequestMutator>;

export type OpenApiBeforeSendHook = (req: any, state: any) => Promise<any> | any;
export type OpenApiPostTestHook = (res: any, state: any, ctx: any) => Promise<any> | any;

export interface OpenApiHookEntry {
  beforeSend?: OpenApiBeforeSendHook;
  postTest?: OpenApiPostTestHook;
}

export interface SpectestConfig {
  configFile?: string;
  baseUrl?: string;
  testDir?: string;
  filePattern?: string;
  startCmd?: string;
  buildCmd?: string;
  runningServer?: RunningServerMode;
  serverStartupTimeout?: number;
  serverHealthCheckInterval?: number;
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
  recording?: RecordingMode;
  recordingFile?: string;
  missingRecordingBehavior?: MissingRecordingBehavior;
  recordingExcludeUrls?: RecordingUrlExclusion[];
  outboundThrottle?: OutboundThrottleRule[];
  openapi?: string;
  openapiServer?: string | number;
  openapiAuth?: Record<string, OpenApiAuthEntry>;
  openapiHooks?: Record<string, OpenApiHookEntry>;
  coverageReport?: boolean;
  coverageReportFile?: string;
  openapiNegativeTests?: OpenApiNegativeTestsConfig;
  /** Arazzo document(s) to run, in addition to any `*.arazzo.{yaml,yml,json}` found under testDir. */
  arazzo?: string | string[];
  /** Workflow inputs, keyed by workflowId (or a function returning them). */
  arazzoInputs?: ArazzoInputsConfig;
  /** JSON/YAML file of workflow inputs keyed by workflowId (`--arazzo-inputs`); takes precedence over arazzoInputs. */
  arazzoInputsFile?: string;
  /** Per-sourceDescription overrides, keyed by the source's `name`. A string replaces its `url`. */
  arazzoSources?: Record<string, string | ArazzoSourceOverride>;
  /** Upper bound on loop iterations for workflows that jump backwards (`goto` to an earlier step, retry-with-target). Default 10. */
  arazzoMaxIterations?: number;
  /**
   * Validate step responses against the source OpenAPI response schema:
   * `auto` (default) only for steps without `successCriteria`, `always`, or `never`.
   */
  arazzoResponseValidation?: 'auto' | 'always' | 'never';
  /** Treat Arazzo schema-validation problems as fatal for the document instead of warnings. */
  arazzoStrict?: boolean;
  /** Regex for Arazzo documents discovered under testDir (default `\.arazzo\.(ya?ml|json)$`; '' disables discovery). */
  arazzoFilePattern?: string;
  /** Only run these Arazzo workflows (by workflowId), plus whatever they depend on. */
  workflows?: string[];
}

export type ArazzoInputsConfig =
  | Record<string, Record<string, unknown>>
  | ((workflowId: string, ctx: { file: string; title?: string }) => Record<string, unknown> | undefined);

export interface ArazzoSourceOverride {
  /** Replacement location (file path or URL) for the source description document. */
  url?: string;
  /** Base URL to send this source's operations to, instead of the run's baseUrl. */
  baseUrl?: string;
  /** OpenAPI server URL or index to take the path prefix from (like `openapiServer`). */
  server?: string | number;
}

export interface OpenApiNegativeTestsConfig {
  enabled?: boolean;
  maxCasesPerOperation?: number;
  /** Operations tagged with any of these (via x-spectest.tags) never get negative tests, even when enabled. */
  excludeTags?: string[];
}

export type TestResultStatus = 'passed' | 'failed' | 'skipped' | 'failed-precondition' | 'cancelled';

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
  /** Concrete `x-spectest.generate` values used, for `$generated.<key>` links. */
  generatedValues?: Record<string, string>;
  /** Informational message (e.g. a tolerated failure, or why a conditional test was skipped). */
  note?: string;
  /** Number of attempts made when the test was retried. */
  attempts?: number;
  /** Set on a conditional (`when`) skip, which releases dependents instead of failing them. */
  passThrough?: boolean;
  /** @internal retry request from an `assert` hook */
  retryHint?: { delayMs?: number } | false;
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
