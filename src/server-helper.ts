import axios from 'axios';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';

let allowedOrigin = '';

let serverProcess = null;
let startedByHelper = false;
const serverLogs = [];
let startCommand = 'npm run start';
let serverUrl = 'http://localhost:8080';
let runningServer = 'reuse';

function setStartCommand(cmd) {
  if (cmd) startCommand = cmd;
}

function setServerUrl(url) {
  if (url) serverUrl = url;
}

function setConfig(cfg = {}) {
  if (cfg.allowedOrigin) allowedOrigin = cfg.allowedOrigin;
  if (cfg.startCommand) setStartCommand(cfg.startCommand);
  if (cfg.serverUrl) setServerUrl(cfg.serverUrl);
  if (cfg.runningServer) runningServer = cfg.runningServer;
}

function killProcessOnPort(port) {
  try {
    const pids =
      spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).stdout.trim();
    if (pids) {
      spawnSync('kill', ['-9', ...pids.split('\n')]);
      console.log(`🛑 Killed process(es) on port ${port}: ${pids}`);
    }
  } catch (err) {
    console.error(`Failed to kill process on port ${port}:`, err.message);
  }
}

async function stop() {
  if (serverProcess && startedByHelper) {
    console.log('📋 Stopping server...');
    serverProcess.kill('SIGTERM');

    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        console.log('📋 Force killing server...');
        serverProcess.kill('SIGKILL');
      }
    }, 5000);

    serverProcess = null;
    startedByHelper = false;
  }
}

async function isRunning() {
  try {
    const response = await axios.request({
      method: 'HEAD',
      url: serverUrl,
      timeout: 3000,
      validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function start() {
  if (await isRunning()) {
    if (runningServer === 'reuse') {
      console.log(`✅ Using existing server at ${serverUrl}`);
      startedByHelper = false;
      return Promise.resolve();
    }
    if (runningServer === 'fail') {
      throw new Error('Server already running');
    }
    if (runningServer === 'kill') {
      const port = new URL(serverUrl).port || '8080';
      killProcessOnPort(port);
    }
  }

  return new Promise((resolve, reject) => {
    console.log('🏗️  Building server...');
    const buildProcess = spawn('npm', ['run', 'build'], { stdio: 'pipe' });

    buildProcess.on('close', (buildCode) => {
      if (buildCode !== 0) {
        reject(new Error(`Build failed with code ${buildCode}`));
        return;
      }

      console.log('✅ Build completed, starting server...');
      startedByHelper = true;
      const [cmd, ...args] = startCommand.split(' ');
      serverProcess = spawn(cmd, args, {
        stdio: 'pipe',
        env: { ...process.env, PORT: '8080' },
      });

      serverProcess.stdout.on('data', (data) => {
        const logLine = data.toString();
        serverLogs.push({ timestamp: new Date().toISOString(), type: 'stdout', message: logLine.trim() });
      });

      serverProcess.stderr.on('data', (data) => {
        const logLine = data.toString();
        serverLogs.push({ timestamp: new Date().toISOString(), type: 'stderr', message: logLine.trim() });
      });

      serverProcess.on('close', (code) => {
        console.log(`🛑 Server process exited with code ${code}. Logs:\n${JSON.stringify(serverLogs, null, 2)}`);
      });

      // Wait for server to be ready
      setTimeout(async () => {
        try {
          if (await isRunning()) {
            console.log('✅ Server is ready');
            resolve();
          } else {
            await stop();
            reject(new Error('Server health check failed'));
          }
        } catch (error) {
          console.error('Server startup error:', error.message);
          await stop();
          reject(new Error(`Server startup failed: ${error.message}`));
        }
      }, 3000);
    });
  });
}

function getLogs() {
  return serverLogs;
}

export {
  start,
  stop,
  getLogs,
  isRunning,
  setStartCommand,
  setServerUrl,
  setConfig,
};
