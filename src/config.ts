import { Command } from 'commander';
import path from 'path';
import { existsSync } from 'fs';
import defaultConfig from './default.config';

export interface CliConfig {
  configFile?: string;
  baseUrl?: string;
  testDir?: string;
  filePattern?: string;
  startCmd?: string;
  runningServer?: string;
  tags?: string[];
  rps?: number;
  timeout?: number;
  snapshotFile?: string;
  bail?: boolean;
  randomize?: boolean;
  happy?: boolean;
  filter?: string;
  verbose?: boolean;
  userAgent?: string;
  suiteFile?: string;
  projectRoot?: string;
}

function createProgram() {
  const program = new Command();
  program
    .name('spectest')
    .description('Fetch-inspired declarative API testing framework')
    .version('0.1.0')
    .option('-c, --config <path>', 'path to additional config file')
    .option('-u, --base-url <url>', 'base URL of the API')
    .option('-d, --test-dir <dir>', 'directory containing test suites')
    .option('-m, --file-pattern <pattern>', 'regex pattern for suite files')
    .option('-s, --start-cmd <cmd>', 'command to start the test server')
    .option('-R, --running-server <mode>', 'existing server handling (reuse|fail|kill)')
    .option('-t, --tags <list>', 'comma separated list of tags to run')
    .option('-p, --rps <number>', 'requests per second rate limit')
    .option('-T, --timeout <ms>', 'request timeout in milliseconds')
    .option('-o, --snapshot <file>', 'write snapshot to file')
    .option('-b, --bail', 'stop on first failure')
    .option('-z, --randomize', 'randomize tests with the same order')
    .option('--happy', 'run only tests expecting 2xx status')
    .option('-f, --filter <pattern>', 'filter tests by name or smart filter')
    .option('-v, --verbose', 'verbose output')
    .option('--user-agent <ua>', 'user agent to use for requests')
    .option('--ua <ua>', 'alias for --user-agent')
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
    baseUrl: opts.baseUrl,
    testDir: opts.testDir,
    filePattern: opts.filePattern,
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
    filter: opts.filter,
    verbose: opts.verbose,
    userAgent: opts.userAgent || opts.ua,
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
    const mod = await import(path.resolve(cliOpts.configFile));
    cfg = { ...cfg, ...(mod.default || mod) };
  }

  // then apply cli options over the configs.
  cfg = { ...cfg, ...cliOpts };
  cfg.projectRoot = projectRoot;
  cfg.runningServer = (cfg.runningServer as any) || 'reuse';

  return cfg;
}

export { createProgram };
