import { Command } from 'commander';
import path from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import defaultConfig from './fest.config.ts';

export interface CliConfig {
  configFile?: string;
  envFile?: string;
  baseUrl?: string;
  suitesDir?: string;
  testMatch?: string;
  startCmd?: string;
  runningServer?: string;
  tags?: string[];
  rps?: number;
  timeout?: number;
  snapshotFile?: string;
  bail?: boolean;
  randomize?: boolean;
  happy?: boolean;
  verbose?: boolean;
  suiteFile?: string;
  projectRoot?: string;
}

function createProgram() {
  const program = new Command();
  program
    .name('fest')
    .description('Fetch-inspired declarative API testing framework')
    .version('0.1.0')
    .option('-c, --config <path>', 'path to additional config file')
    .option('-e, --env <file>', 'path to .env file')
    .option('-u, --base-url <url>', 'base URL of the API')
    .option('-d, --suites-dir <dir>', 'directory containing test suites')
    .option('-m, --test-match <pattern>', 'regex pattern for suite files')
    .option('-s, --start-cmd <cmd>', 'command to start the test server')
    .option('-R, --running-server <mode>', 'existing server handling (reuse|fail|kill)')
    .option('-t, --tags <list>', 'comma separated list of tags to run')
    .option('-p, --rps <number>', 'requests per second rate limit')
    .option('-T, --timeout <ms>', 'request timeout in milliseconds')
    .option('-o, --snapshot <file>', 'write snapshot to file')
    .option('-b, --bail', 'stop on first failure')
    .option('-z, --randomize', 'randomize tests with the same order')
    .option('--happy', 'run only tests expecting 2xx status')
    .option('-v, --verbose', 'verbose output')
    .argument('[suiteFile]', 'run a specific suite file');
  return program;
}

function parseArgs(argv: string[]): CliConfig {
  const program = createProgram();
  program.parse(argv);
  const opts = program.opts();
  const suiteFile = program.processedArgs[0];
  const raw: CliConfig = {
    configFile: opts.config,
    envFile: opts.env,
    baseUrl: opts.baseUrl,
    suitesDir: opts.suitesDir,
    testMatch: opts.testMatch,
    startCmd: opts.startCmd,
    runningServer: opts.runningServer,
    tags: typeof opts.tags === 'string'
      ? opts.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : undefined,
    rps: typeof opts.rps !== 'undefined' ? parseInt(opts.rps, 10) : undefined,
    timeout: typeof opts.timeout !== 'undefined' ? parseInt(opts.timeout, 10) : undefined,
    snapshotFile: opts.snapshot,
    bail: opts.bail,
    randomize: opts.randomize,
    happy: opts.happy,
    verbose: opts.verbose,
    suiteFile,
  };

  const cleaned: CliConfig = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (value !== undefined) (cleaned as any)[key] = value;
  });

  return cleaned;
}

export async function loadConfig(argv = process.argv): Promise<CliConfig> {
  const cliOpts = parseArgs(argv);
  const projectRoot = process.cwd();
  let cfg: CliConfig = { ...defaultConfig } as CliConfig;

  try {
    const projectCfgPath = path.join(projectRoot, 'fest.config.js');
    if (existsSync(projectCfgPath)) {
      const mod = await import(projectCfgPath);
      cfg = { ...cfg, ...(mod.default || mod) };
    }
  } catch {
    // ignore project config load errors
  }

  if (cliOpts.configFile) {
    const mod = await import(path.resolve(cliOpts.configFile));
    cfg = { ...cfg, ...(mod.default || mod) };
  }

  cfg = { ...cfg, ...cliOpts };
  cfg.projectRoot = projectRoot;
  cfg.runningServer = (cfg.runningServer as any) || 'reuse';

  if (cfg.envFile) {
    dotenv.config({ path: path.resolve(projectRoot, cfg.envFile) });
  }

  return cfg;
}

export { createProgram };
