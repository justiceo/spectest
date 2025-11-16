import { spawn, spawnSync } from 'child_process';

class Server {
  private serverProcess: ReturnType<typeof spawn> | null = null;
  private startedByHelper = false;
  private serverLogs: Array<{ timestamp: string; type: 'stdout' | 'stderr'; message: string }> = [];
  private buildCommand?: string;
  private startCommand = 'npm run start';
  private serverUrl = 'http://localhost:8080';
  private runningServer: 'reuse' | 'fail' | 'kill' = 'reuse';

  setStartCommand(cmd?: string): void {
    if (cmd) this.startCommand = cmd;
  }

  setServerUrl(url?: string): void {
    if (url) this.serverUrl = url;
  }

  setBuildCommand(cmd?: string): void {
    if (cmd) this.buildCommand = cmd;
  }

  setConfig(cfg: {
    startCommand?: string;
    buildCmd?: string;
    serverUrl?: string;
    runningServer?: 'reuse' | 'fail' | 'kill';
  } = {}): void {
    if (cfg.startCommand) this.setStartCommand(cfg.startCommand);
    if (cfg.buildCmd) this.setBuildCommand(cfg.buildCmd);
    if (cfg.serverUrl) this.setServerUrl(cfg.serverUrl);
    if (cfg.runningServer) this.runningServer = cfg.runningServer;
  }

  private killProcessOnPort(port: string): void {
    try {
      const isWindows = process.platform === 'win32';
      let pids: string[] = [];

      if (isWindows) {
        const { stdout } = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
        stdout
          .split('\n')
          .forEach((line) => {
            if (line.includes(`:${port}`)) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && pid !== '0') pids.push(pid);
            }
          });

        // Kill found pids using taskkill
        [...new Set(pids)].forEach((pid) => {
          spawnSync('taskkill', ['/PID', pid, '/F', '/T']);
        });
      } else {
        const { stdout } = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
        pids = stdout.trim().split('\n').filter(Boolean);

        pids.forEach((pid) => {
          try {
            process.kill(parseInt(pid, 10), 'SIGKILL');
          } catch {
            // ignore if unable to kill
          }
        });
      }

      if (pids.length) {
        console.log(`🛑 Killed process(es) on port ${port}: ${pids.join(', ')}`);
      }
    } catch (err: any) {
      console.error(`Failed to kill process on port ${port}:`, err.message);
    }
  }

  async stop(): Promise<void> {
    if (this.serverProcess && this.startedByHelper) {
      console.log('📋 Stopping server...');
      this.serverProcess.kill('SIGTERM');

      setTimeout(() => {
        if (this.serverProcess && !this.serverProcess.killed) {
          console.log('📋 Force killing server...');
          this.serverProcess.kill('SIGKILL');
        }
      }, 5000);

      this.serverProcess = null;
      this.startedByHelper = false;
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 3000);
      const response = await fetch(this.serverUrl, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (await this.isRunning()) {
      if (this.runningServer === 'reuse') {
        console.log(`✅ Using existing server at ${this.serverUrl}`);
        this.startedByHelper = false;
        return Promise.resolve();
      }
      if (this.runningServer === 'fail') {
        throw new Error('Server already running');
      }
      if (this.runningServer === 'kill') {
        const port = new URL(this.serverUrl).port || '8080';
        this.killProcessOnPort(port);
      }
    }

    return new Promise((resolve, reject) => {
      const startServer = () => {
        console.log('✅ Starting server...');
        this.startedByHelper = true;
        const [cmd, ...args] = this.startCommand.split(' ');
        this.serverProcess = spawn(cmd, args, {
          stdio: 'pipe',
          env: { ...process.env, PORT: '8080' },
        });

        this.serverProcess.stdout.on('data', (data: Buffer) => {
          const logLine = data.toString();
          this.serverLogs.push({ timestamp: new Date().toISOString(), type: 'stdout', message: logLine.trim() });
        });

        this.serverProcess.stderr.on('data', (data: Buffer) => {
          const logLine = data.toString();
          this.serverLogs.push({ timestamp: new Date().toISOString(), type: 'stderr', message: logLine.trim() });
        });

        this.serverProcess.on('close', (code) => {
          console.log(`🛑 Server process exited with code ${code}. Logs:\n${JSON.stringify(this.serverLogs, null, 2)}`);
        });

        // Wait for server to be ready
        setTimeout(async () => {
          try {
            if (await this.isRunning()) {
              console.log('✅ Server is ready');
              resolve();
            } else {
              await this.stop();
              reject(new Error('Server health check failed'));
            }
          } catch (error: any) {
            console.error('Server startup error:', error.message);
            await this.stop();
            reject(new Error(`Server startup failed: ${error.message}`));
          }
        }, 3000);
      };

      if (this.buildCommand) {
        console.log('🏗️  Building server...');
        const [cmd, ...args] = this.buildCommand.split(' ');
        const buildProcess = spawn(cmd, args, { stdio: 'pipe' });

        buildProcess.on('close', (buildCode) => {
          if (buildCode !== 0) {
            reject(new Error(`Build failed with code ${buildCode}`));
            return;
          }
          console.log('✅ Build completed, starting server...');
          startServer();
        });
      } else {
        startServer();
      }
    });
  }

  getLogs() {
    return this.serverLogs;
  }
}

export default Server;
