import path from 'path';
import { existsSync } from 'fs';
import defaultConfig from './default.config.js';
import type {
  ArazzoInputsConfig,
  ArazzoSourceOverride,
  MissingRecordingBehavior,
  OpenApiNegativeTestsConfig,
  OpenApiRequestMutator,
  OutboundThrottleRule,
  RecordingMode,
  RecordingUrlExclusion,
  RunningServerMode,
  TestOutputMode,
} from './types.js';

export interface CliConfig {
  configFile?: string;
  baseUrl?: string;
  testDir?: string;
  filePattern?: string;
  startCmd?: string;
  buildCmd?: string;
  runningServer?: string;
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
  openapiAuth?: Record<string, OpenApiRequestMutator>;
  coverageReport?: boolean;
  coverageReportFile?: string;
  negativeTests?: boolean;
  openapiNegativeTests?: OpenApiNegativeTestsConfig;
  arazzo?: string | string[];
  arazzoInputs?: ArazzoInputsConfig;
  arazzoInputsFile?: string;
  arazzoSources?: Record<string, string | ArazzoSourceOverride>;
  arazzoMaxIterations?: number;
  arazzoResponseValidation?: 'auto' | 'always' | 'never';
  arazzoStrict?: boolean;
  arazzoFilePattern?: string;
  workflows?: string[];
}

function parseTestOutput(value: string | undefined): TestOutputMode {
  if (value === 'summary' || value === 'errors') {
    return value;
  }
  console.error('error: --test-output must be "summary" or "errors"');
  process.exit(1);
}

function validateConfiguredTestOutput(value: unknown): asserts value is TestOutputMode {
  if (value === 'summary' || value === 'errors') {
    return;
  }
  console.error('error: testOutput must be "summary" or "errors"');
  process.exit(1);
}

function parseRecording(value: string | undefined): RecordingMode {
  if (value === 'off' || value === 'replay' || value === 'record') return value;
  console.error('error: --recording must be "off", "replay", or "record"');
  process.exit(1);
}

function validateConfiguredRecording(value: unknown): asserts value is RecordingMode {
  if (value === 'off' || value === 'replay' || value === 'record') return;
  console.error('error: recording must be "off", "replay", or "record"');
  process.exit(1);
}

function parseMissingRecordingBehavior(value: string | undefined): MissingRecordingBehavior {
  if (value === 'fail' || value === 'record' || value === 'bypass') return value;
  console.error('error: --missing-recording-behavior must be "fail", "record", or "bypass"');
  process.exit(1);
}

function parseRunningServer(value: string | undefined): RunningServerMode {
  if (value === 'reuse' || value === 'fail' || value === 'kill') return value;
  console.error('error: --running-server must be "reuse", "fail", or "kill"');
  process.exit(1);
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  const parsed = value ? Number(value) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.error(`error: ${flag} must be a positive number`);
  process.exit(1);
}

function validateConfiguredPositiveInt(key: string, value: unknown): asserts value is number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return;
  console.error(`error: ${key} must be a positive number`);
  process.exit(1);
}

function validateConfiguredMissingRecordingBehavior(value: unknown): asserts value is MissingRecordingBehavior {
  if (value === 'fail' || value === 'record' || value === 'bypass') return;
  console.error('error: missingRecordingBehavior must be "fail", "record", or "bypass"');
  process.exit(1);
}

function validateConfiguredRecordingExcludeUrls(value: unknown): asserts value is RecordingUrlExclusion[] {
  if (!Array.isArray(value)) {
    console.error('error: recordingExcludeUrls must be an array');
    process.exit(1);
  }
  const invalid = value.find((item) => {
    return typeof item !== 'string' && !(item instanceof RegExp) && typeof item !== 'function';
  });
  if (invalid !== undefined) {
    console.error('error: recordingExcludeUrls entries must be strings, RegExp objects, or functions');
    process.exit(1);
  }
}

function validateConfiguredOutboundThrottle(value: unknown): asserts value is OutboundThrottleRule[] {
  if (!Array.isArray(value)) {
    console.error('error: outboundThrottle must be an array');
    process.exit(1);
  }
  const invalid = value.find((item) => {
    if (!item || typeof item !== 'object') return true;
    const matchOk = typeof item.match === 'string' || item.match instanceof RegExp;
    const rpsOk = typeof item.rps === 'number' && item.rps > 0;
    return !matchOk || !rpsOk;
  });
  if (invalid !== undefined) {
    console.error('error: outboundThrottle entries must be { match: string | RegExp, rps: number > 0, name?: string }');
    process.exit(1);
  }
}

function parseArazzoResponseValidation(value: string | undefined): 'auto' | 'always' | 'never' {
  if (value === 'auto' || value === 'always' || value === 'never') return value;
  console.error('error: --arazzo-response-validation must be "auto", "always", or "never"');
  process.exit(1);
}

function validateConfiguredArazzo(cfg: CliConfig): void {
  if (cfg.arazzo !== undefined) {
    const list = Array.isArray(cfg.arazzo) ? cfg.arazzo : [cfg.arazzo];
    if (list.some((item) => typeof item !== 'string' || !item)) {
      console.error('error: arazzo must be a path or an array of paths');
      process.exit(1);
    }
  }
  if (cfg.arazzoResponseValidation !== undefined && !['auto', 'always', 'never'].includes(cfg.arazzoResponseValidation)) {
    console.error('error: arazzoResponseValidation must be "auto", "always", or "never"');
    process.exit(1);
  }
  if (cfg.arazzoMaxIterations !== undefined) {
    validateConfiguredPositiveInt('arazzoMaxIterations', cfg.arazzoMaxIterations);
  }
  if (cfg.arazzoInputs !== undefined && typeof cfg.arazzoInputs !== 'function' && (typeof cfg.arazzoInputs !== 'object' || cfg.arazzoInputs === null)) {
    console.error('error: arazzoInputs must be an object keyed by workflowId, or a function');
    process.exit(1);
  }
  if (cfg.arazzoSources !== undefined) {
    const invalid =
      typeof cfg.arazzoSources !== 'object' ||
      cfg.arazzoSources === null ||
      Object.values(cfg.arazzoSources).some((v) => typeof v !== 'string' && (typeof v !== 'object' || v === null));
    if (invalid) {
      console.error('error: arazzoSources must map source names to a url string or { url?, baseUrl?, server? }');
      process.exit(1);
    }
  }
  if (cfg.workflows !== undefined && (!Array.isArray(cfg.workflows) || cfg.workflows.some((w) => typeof w !== 'string'))) {
    console.error('error: workflows must be an array of workflowIds');
    process.exit(1);
  }
}

const HELP_OPTIONS: [string, string][] = [
  ['--config <file>', 'Path to an extra config file'],
  ['--base-url <url>', 'Base URL of the API (default: http://localhost:3000)'],
  ['--test-dir <dir>', 'Directory containing test suites (default: ./test)'],
  ['--file-pattern <regex>', 'Regex for suite filenames (default: \\.spectest\\.)'],
  ['--start-cmd <cmd>', 'Command to start the test server (default: npm run start)'],
  ['--build-cmd <cmd>', 'Command to build the test server'],
  ['--running-server <mode>', "Handling for an existing server: reuse, fail, kill (default: reuse)"],
  ['--server-startup-timeout <ms>', 'Max time to wait for a spawned server to become ready (default: 30000)'],
  ['--server-health-check-interval <ms>', 'Interval between server readiness health checks (default: 250)'],
  ['--tags <tag1,tag2>', 'Comma-separated tags used for filtering tests'],
  ['--rps <number>', 'Requests per second rate limit (default: Infinity)'],
  ['--timeout <ms>', 'Default request timeout in milliseconds (default: 60000)'],
  ['--snapshot <file>', 'Path to write a snapshot file'],
  ['--randomize', 'Shuffle test ordering before execution'],
  ['--happy', 'Run only tests expecting a 2xx status'],
  ['--filter <pattern>', 'Regex or smart filter to select tests (happy, failures)'],
  ['--test-output <mode>', 'Test result detail: summary or errors (default: summary)'],
  ['--verbose', 'Verbose spectest runner/program output'],
  ['--user-agent, --ua <name>', 'Browser User-Agent string or predefined name (default: chrome_windows)'],
  ['--proxy <url>', 'Proxy URL to route requests through'],
  ['--recording <mode>', 'HTTP recording mode: off, replay, record (default: off)'],
  ['--recording-file <path>', 'JSON cassette path for HTTP recordings (default: .spectest/cassette.json)'],
  ['--missing-recording-behavior <mode>', "Behavior when replay can't find a cassette entry: fail, record, bypass (default: fail)"],
  ['--openapi <path>', 'Path to an OpenAPI 3.0/3.1 document to load directly'],
  ['--openapi-server <url|index>', 'Server URL or index to select from an OpenAPI document'],
  ['--coverage-report', 'Print a per-operation OpenAPI contract coverage report after the run'],
  ['--coverage-report-file <path>', 'Write the coverage report to a file instead of stdout'],
  ['--negative-tests', 'Enable schema-derived negative test generation for OpenAPI operations (default: off)'],
  ['--arazzo <path[,path]>', 'Arazzo document(s) to run (also discovered as *.arazzo.{yaml,yml,json} under the test dir)'],
  ['--arazzo-inputs <file>', 'JSON/YAML file of workflow inputs keyed by workflowId'],
  ['--workflow <id[,id]>', 'Only run these Arazzo workflows (plus the workflows they depend on)'],
  ['--arazzo-max-iterations <n>', 'Loop bound for workflows that jump back to earlier steps (default: 10)'],
  ['--arazzo-response-validation <mode>', 'Check step responses against the OpenAPI schema: auto, always, never (default: auto)'],
  ['--arazzo-strict', 'Fail an Arazzo document that does not conform to the Arazzo JSON Schema'],
  ['--dir <path>', 'Root directory of the project (default: current working directory)'],
  ['-h, --help', 'Show this help message and exit'],
];

function printHelp(): void {
  const columnWidth = Math.max(...HELP_OPTIONS.map(([flag]) => flag.length)) + 2;
  const optionLines = HELP_OPTIONS.map(([flag, desc]) => `  ${flag.padEnd(columnWidth)}${desc}`).join('\n');
  console.log(`Usage: spectest [options] [suiteFile]

Declarative API testing CLI for fast HTTP endpoint and REST API tests.

Options:
${optionLines}

Examples:
  spectest --base-url=https://api.example.com
  spectest --openapi ./openapi.yaml --base-url=https://api.example.com
  spectest --tags=smoke,auth ./test/auth.spectest.js
  spectest --openapi ./openapi.yaml --coverage-report
  spectest --arazzo ./checkout.arazzo.yaml --arazzo-inputs ./inputs.json --base-url=https://api.example.com

Commands:
  generate openapi-tests --openapi <path> --output <dir>  Scaffold editable .spectest.js files from an OpenAPI document
  generate arazzo-tests --arazzo <path> --output <dir>    Scaffold editable .spectest.js files from an Arazzo document
`);
}

// Flags that never take a value, so a following positional argument (e.g. a suite file) is never
// mistaken for one. Without this, `--happy ./test/foo.spectest.js` silently swallows the suite file
// because parseArgs' token consumption runs before the switch below and can't tell a boolean flag
// from a value-taking one.
const NO_VALUE_FLAGS = new Set(['happy', 'randomize', 'verbose', 'coverage-report', 'negative-tests', 'arazzo-strict']);

function parseArgs(argv: string[]): CliConfig {
  const args = argv.slice(2);
  const raw: CliConfig = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      let [key, value] = arg.slice(2).split('=');
      if (typeof value === 'undefined' && !NO_VALUE_FLAGS.has(key)) {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          value = next;
          i += 1;
        }
      }
      switch (key) {
        case 'config':
          raw.configFile = value;
          break;
        case 'base-url':
          raw.baseUrl = value;
          break;
        case 'test-dir':
          raw.testDir = value;
          break;
        case 'file-pattern':
          raw.filePattern = value;
          break;
        case 'start-cmd':
          raw.startCmd = value;
          break;
        case 'build-cmd':
          raw.buildCmd = value;
          break;
        case 'running-server':
          raw.runningServer = parseRunningServer(value);
          break;
        case 'server-startup-timeout':
          raw.serverStartupTimeout = parsePositiveInt('--server-startup-timeout', value);
          break;
        case 'server-health-check-interval':
          raw.serverHealthCheckInterval = parsePositiveInt('--server-health-check-interval', value);
          break;
        case 'tags':
          raw.tags = value ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
          break;
        case 'rps':
          raw.rps = value ? parseInt(value, 10) : undefined;
          break;
        case 'timeout':
          raw.timeout = value ? parseInt(value, 10) : undefined;
          break;
        case 'snapshot':
          raw.snapshotFile = value;
          break;
        case 'randomize':
          raw.randomize = true;
          break;
        case 'happy':
          raw.happy = true;
          break;
        case 'filter':
          raw.filter = value;
          break;
        case 'verbose':
          raw.verbose = true;
          break;
        case 'test-output':
          raw.testOutput = parseTestOutput(value);
          break;
        case 'user-agent':
          raw.userAgent = value;
          break;
        case 'ua':
          raw.userAgent = value;
          break;
        case 'proxy':
          raw.proxy = value;
          break;
        case 'recording':
          raw.recording = parseRecording(value);
          break;
        case 'recording-file':
          raw.recordingFile = value;
          break;
        case 'missing-recording-behavior':
          raw.missingRecordingBehavior = parseMissingRecordingBehavior(value);
          break;
        case 'openapi':
          raw.openapi = value;
          break;
        case 'openapi-server':
          raw.openapiServer = value;
          break;
        case 'coverage-report':
          raw.coverageReport = true;
          break;
        case 'coverage-report-file':
          raw.coverageReportFile = value;
          break;
        case 'negative-tests':
          raw.negativeTests = true;
          break;
        case 'arazzo': {
          const paths = value ? value.split(',').map((p) => p.trim()).filter(Boolean) : [];
          const existing = Array.isArray(raw.arazzo) ? raw.arazzo : raw.arazzo ? [raw.arazzo] : [];
          raw.arazzo = [...existing, ...paths];
          break;
        }
        case 'arazzo-inputs':
          raw.arazzoInputsFile = value;
          break;
        case 'workflow':
        case 'workflows':
          raw.workflows = [...(raw.workflows || []), ...(value ? value.split(',').map((w) => w.trim()).filter(Boolean) : [])];
          break;
        case 'arazzo-max-iterations':
          raw.arazzoMaxIterations = parsePositiveInt('--arazzo-max-iterations', value);
          break;
        case 'arazzo-response-validation':
          raw.arazzoResponseValidation = parseArazzoResponseValidation(value);
          break;
        case 'arazzo-strict':
          raw.arazzoStrict = true;
          break;
        case 'dir':
          raw.projectRoot = value;
          break;
        default:
          console.error("error: unknown key " + key);
          process.exit(1)
      }
    } else if (!raw.suiteFile) {
      raw.suiteFile = arg;
    }
    i += 1;
  }

  const cleaned: CliConfig = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (value !== undefined) (cleaned as any)[key] = value;
  });

  return cleaned;
}

export async function loadConfigFromCliOpts(cliOpts: CliConfig): Promise<CliConfig> {
  const projectRoot = cliOpts.projectRoot
    ? path.resolve(cliOpts.projectRoot)
    : process.cwd();
  // first load default config.
  let cfg: CliConfig = { ...defaultConfig } as CliConfig;

  // then load project config.
  try {
    const projectCfgPath = path.join(projectRoot, 'spectest.config.js');
    if (existsSync(projectCfgPath)) {
      const mod = await import(projectCfgPath);
      cfg = { ...cfg, ...(mod.default || mod) };
    }
  } catch {
  }

  // then load invocation-time project config.
  if (cliOpts.configFile) {
    const mod = await import(path.resolve(projectRoot, cliOpts.configFile));
    cfg = { ...cfg, ...(mod.default || mod) };
  }

  // then apply cli options over the configs.
  const { projectRoot: _unused, negativeTests, ...restCliOpts } = cliOpts;
  cfg = { ...cfg, ...restCliOpts };
  cfg.projectRoot = projectRoot;
  if (negativeTests) {
    cfg.openapiNegativeTests = { ...cfg.openapiNegativeTests, enabled: true };
  }
  cfg.runningServer = (cfg.runningServer as any) || 'reuse';
  cfg.serverStartupTimeout = cfg.serverStartupTimeout || 30000;
  cfg.serverHealthCheckInterval = cfg.serverHealthCheckInterval || 250;
  cfg.recording = (cfg.recording as any) || 'off';
  cfg.recordingFile = cfg.recordingFile || '.spectest/cassette.json';
  cfg.missingRecordingBehavior = (cfg.missingRecordingBehavior as any) || 'fail';
  cfg.recordingExcludeUrls = cfg.recordingExcludeUrls || [];
  cfg.outboundThrottle = cfg.outboundThrottle || [];
  validateConfiguredTestOutput(cfg.testOutput);
  validateConfiguredRecording(cfg.recording);
  validateConfiguredMissingRecordingBehavior(cfg.missingRecordingBehavior);
  validateConfiguredRecordingExcludeUrls(cfg.recordingExcludeUrls);
  validateConfiguredOutboundThrottle(cfg.outboundThrottle);
  validateConfiguredPositiveInt('serverStartupTimeout', cfg.serverStartupTimeout);
  validateConfiguredPositiveInt('serverHealthCheckInterval', cfg.serverHealthCheckInterval);
  validateConfiguredArazzo(cfg);
  if (cfg.recordingFile) {
    cfg.recordingFile = path.resolve(projectRoot, cfg.recordingFile);
  }
  if (cfg.openapi) {
    cfg.openapi = path.resolve(projectRoot, cfg.openapi);
  }
  if (cfg.coverageReportFile) {
    cfg.coverageReportFile = path.resolve(projectRoot, cfg.coverageReportFile);
  }
  if (cfg.arazzo) {
    cfg.arazzo = (Array.isArray(cfg.arazzo) ? cfg.arazzo : [cfg.arazzo]).map((p) => path.resolve(projectRoot, p));
  }
  if (cfg.arazzoInputsFile) {
    cfg.arazzoInputsFile = path.resolve(projectRoot, cfg.arazzoInputsFile);
  }

  return cfg;
}

export async function loadConfig(argv = process.argv): Promise<CliConfig> {
  return loadConfigFromCliOpts(parseArgs(argv));
}
