import path from 'path';
import { existsSync } from 'fs';
import defaultConfig from './default.config';
import type { MissingRecordingBehavior, RecordingMode, RecordingUrlExclusion, TestOutputMode } from './types';

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

function parseArgs(argv: string[]): CliConfig {
  const args = argv.slice(2);
  const raw: CliConfig = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
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
          raw.runningServer = value;
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

export async function loadConfig(argv = process.argv): Promise<CliConfig> {
  const cliOpts = parseArgs(argv);
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
  validateConfiguredTestOutput(cfg.testOutput);
  validateConfiguredRecording(cfg.recording);
  validateConfiguredMissingRecordingBehavior(cfg.missingRecordingBehavior);
  validateConfiguredRecordingExcludeUrls(cfg.recordingExcludeUrls);
  if (cfg.recordingFile) {
    cfg.recordingFile = path.resolve(projectRoot, cfg.recordingFile);
  }

  return cfg;
}
