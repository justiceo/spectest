import path from 'path';
import { existsSync } from 'fs';
import defaultConfig from './default.config.js';
import type {
  MissingRecordingBehavior,
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

const HELP_OPTIONS: [string, string][] = [
  ['--config <file>', 'Path to an extra config file'],
  ['--base-url <url>', 'Base URL of the API (default: http://localhost:3000)'],
  ['--test-dir <dir>', 'Directory containing test suites (default: ./test)'],
  ['--file-pattern <regex>', 'Regex for suite filenames (default: \\.spectest\\.)'],
  ['--start-cmd <cmd>', 'Command to start the test server (default: npm run start)'],
  ['--build-cmd <cmd>', 'Command to build the test server'],
  ['--running-server <mode>', "Handling for an existing server: reuse, fail, kill (default: reuse)"],
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

Commands:
  generate openapi-tests --openapi <path> --output <dir>  Scaffold editable .spectest.js files from an OpenAPI document
`);
}

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
      if (typeof value === 'undefined') {
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
  const { projectRoot: _unused, ...restCliOpts } = cliOpts;
  cfg = { ...cfg, ...restCliOpts };
  cfg.projectRoot = projectRoot;
  cfg.runningServer = (cfg.runningServer as any) || 'reuse';
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
  if (cfg.recordingFile) {
    cfg.recordingFile = path.resolve(projectRoot, cfg.recordingFile);
  }
  if (cfg.openapi) {
    cfg.openapi = path.resolve(projectRoot, cfg.openapi);
  }
  if (cfg.coverageReportFile) {
    cfg.coverageReportFile = path.resolve(projectRoot, cfg.coverageReportFile);
  }

  return cfg;
}

export async function loadConfig(argv = process.argv): Promise<CliConfig> {
  return loadConfigFromCliOpts(parseArgs(argv));
}
