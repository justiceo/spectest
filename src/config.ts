import path from 'path';
import { existsSync } from 'fs';
import defaultConfig from './default.config';

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
  userAgent?: string;
  proxy?: string;
  suiteFile?: string;
  projectRoot?: string;
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
        case 'user-agent':
          raw.userAgent = value;
          break;
        case 'ua':
          raw.userAgent = value;
          break;
        case 'proxy':
          raw.proxy = value;
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

