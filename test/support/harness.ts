// Shared helpers for tests that exercise the real runner: an in-process mock
// HTTP server and a way to run the CLI (from source, no build step) against it.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  json?: any;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

export type MockHandler = (req: RecordedRequest) => MockReply | Promise<MockReply>;

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = new URL(req.url || '/', 'http://localhost');
    const recorded: RecordedRequest = {
      method: req.method || 'GET',
      url: req.url || '/',
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: req.headers,
      body,
    };
    try {
      recorded.json = body ? JSON.parse(body) : undefined;
    } catch {
      recorded.json = undefined;
    }
    // Server-readiness probes from the runner hit `/`; don't record them.
    if (!((recorded.method === 'GET' || recorded.method === 'HEAD') && recorded.path === '/' && !body)) requests.push(recorded);
    let reply: MockReply;
    try {
      reply = await handler(recorded);
    } catch (error) {
      reply = { status: 500, json: { error: String((error as Error)?.message || error) } };
    }
    const headers: Record<string, string> = { ...(reply.headers || {}) };
    let payload = '';
    if (reply.json !== undefined) {
      payload = JSON.stringify(reply.json);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    } else if (reply.text !== undefined) {
      payload = reply.text;
    }
    res.writeHead(reply.status ?? 200, headers);
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const resolveTs = fileURLToPath(new URL('./resolve-ts.mjs', import.meta.url));

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', resolveTs, cliPath, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, opts.timeoutMs ?? 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Strip ANSI color codes so result lines can be matched literally.
export function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export type LineStatus = 'passed' | 'failed' | 'skipped' | 'failed-precondition' | 'cancelled' | 'timeout';

/** Parses `[icon] name (Nms)` summary lines into a name → status map (plus notes). */
export function parseResults(stdout: string): Map<string, { status: LineStatus; note?: string; attempts?: number }> {
  const results = new Map<string, { status: LineStatus; note?: string; attempts?: number }>();
  const lines = plain(stdout).split('\n');
  let last: { status: LineStatus; note?: string; attempts?: number } | undefined;
  for (const line of lines) {
    const match = /^\s+\[(.+?)\s*\] (.+) \((\d+)ms(?:, (\d+) attempts)?\)$/.exec(line);
    if (match) {
      const icon = match[1].trim();
      const status: LineStatus =
        icon === '✅'
          ? 'passed'
          : icon === '❌'
            ? 'failed'
            : icon.startsWith('⏭')
              ? 'skipped'
              : icon === '↷'
                ? 'failed-precondition'
                : icon === '⛔'
                  ? 'cancelled'
                  : 'timeout';
      last = { status, ...(match[4] ? { attempts: Number(match[4]) } : {}) };
      results.set(match[2], last);
      continue;
    }
    const note = /^\s+↳ (.*)$/.exec(line);
    if (note && last) last.note = note[1];
  }
  return results;
}
