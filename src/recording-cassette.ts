import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

export type RecordingMode = 'off' | 'replay' | 'record';
export type MissingRecordingBehavior = 'fail' | 'record' | 'bypass';

export interface RecordingOptions {
  file: string;
  mode: RecordingMode;
  missingRecordingBehavior?: MissingRecordingBehavior;
  recordingExcludeUrls?: RecordingUrlExclusion[];
}

export interface RecordingContext {
  caseId?: string;
  testName?: string;
  suiteName?: string;
  mode?: RecordingMode;
  missingRecordingBehavior?: MissingRecordingBehavior;
}

export interface SerializedHttpRequest {
  id?: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string | null;
  context?: RecordingContext;
}

export type RecordingUrlExclusion =
  | string
  | RegExp
  | ((url: URL, request: SerializedHttpRequest) => boolean);

export interface SerializedHttpResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body?: string | null;
}

export interface CassetteBody {
  contentType?: string;
  byteLength: number;
  sha256: string;
  base64: string;
}

export interface CassetteEntry {
  id: string;
  matchKey: string;
  request: {
    method: string;
    url: string;
    headers: Array<[string, string]>;
    body: CassetteBody;
  };
  response: {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    body: CassetteBody;
  };
  timings: {
    recordedAt: string;
  };
  test?: {
    caseId?: string;
    name?: string;
    suiteName?: string;
  };
}

export interface CassetteFile {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  spectestVersion: string;
  entries: CassetteEntry[];
}

export interface RecordingDecision {
  action: 'replay' | 'record' | 'bypass' | 'fail';
  response?: SerializedHttpResponse;
  error?: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
]);

const SPECTEST_HEADERS = new Set([
  'x-spectest-case-id',
  'x-spectest-test-name',
  'x-spectest-suite-name',
  'x-spectest-recording-mode',
  'x-spectest-missing-recording-behavior',
]);

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeBase64(value?: string | null): string {
  return value || '';
}

function bodyFromBase64(base64?: string | null, contentType?: string): CassetteBody {
  const normalized = normalizeBase64(base64);
  const buffer = Buffer.from(normalized, 'base64');
  return {
    contentType,
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    base64: normalized,
  };
}

function canonicalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  return url.toString();
}

function headerContentType(headers: Array<[string, string]>): string | undefined {
  const header = headers.find(([name]) => name.toLowerCase() === 'content-type');
  return header?.[1];
}

export function normalizeHeaders(headers: Array<[string, string]>): Array<[string, string]> {
  return headers
    .filter(([name]) => {
      const normalized = name.toLowerCase();
      return !HOP_BY_HOP_HEADERS.has(normalized) && !SPECTEST_HEADERS.has(normalized);
    })
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .sort(([aName, aValue], [bName, bValue]) => {
      const byName = aName.localeCompare(bName);
      return byName || aValue.localeCompare(bValue);
    });
}

export function createMatchKey(request: SerializedHttpRequest): string {
  const body = bodyFromBase64(request.body, headerContentType(request.headers));
  const parts = {
    method: request.method.toUpperCase(),
    url: canonicalUrl(request.url),
    bodySha256: body.sha256,
    headers: normalizeHeaders(request.headers),
  };
  return sha256(JSON.stringify(parts));
}

function serializeResponse(entry: CassetteEntry): SerializedHttpResponse {
  return {
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers: entry.response.headers,
    body: entry.response.body.base64,
  };
}

function emptyCassette(version: string): CassetteFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    spectestVersion: version,
    entries: [],
  };
}

export class HttpRecordingCassette {
  private file: string;
  private mode: RecordingMode;
  private missingRecordingBehavior: MissingRecordingBehavior;
  private recordingExcludeUrls: RecordingUrlExclusion[];
  private version: string;
  private cassette: CassetteFile;

  constructor(options: RecordingOptions & { spectestVersion?: string }) {
    this.file = path.resolve(options.file);
    this.mode = options.mode;
    this.missingRecordingBehavior = options.missingRecordingBehavior || 'fail';
    this.recordingExcludeUrls = options.recordingExcludeUrls || [];
    this.version = options.spectestVersion || 'unknown';
    this.cassette = emptyCassette(this.version);
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) {
      this.cassette = emptyCassette(this.version);
      return;
    }
    const raw = await readFile(this.file, 'utf8');
    const parsed = JSON.parse(raw);
    this.cassette = {
      schemaVersion: 1,
      createdAt: parsed.createdAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || parsed.createdAt || new Date().toISOString(),
      spectestVersion: parsed.spectestVersion || this.version,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  }

  decide(request: SerializedHttpRequest): RecordingDecision {
    const mode = request.context?.mode || this.mode;
    const missingRecordingBehavior = request.context?.missingRecordingBehavior || this.missingRecordingBehavior;

    if (mode === 'off') {
      return { action: 'bypass' };
    }

    if (this.isExcluded(request)) {
      return { action: 'bypass' };
    }

    const entry = this.find(request);
    if (entry) {
      if (mode === 'replay') {
        return { action: 'replay', response: serializeResponse(entry) };
      }
      return { action: 'record' };
    }

    if (mode === 'record') {
      return { action: 'record' };
    }

    if (missingRecordingBehavior === 'record') {
      return { action: 'record' };
    }
    if (missingRecordingBehavior === 'bypass') {
      return { action: 'bypass' };
    }

    return {
      action: 'fail',
      error: `No HTTP recording matched ${request.method.toUpperCase()} ${request.url}`,
    };
  }

  record(request: SerializedHttpRequest, response: SerializedHttpResponse): void {
    if (this.isExcluded(request)) {
      return;
    }

    const matchKey = createMatchKey(request);
    const now = new Date().toISOString();
    const entry: CassetteEntry = {
      id: `rec_${matchKey.slice(0, 16)}_${randomUUID().slice(0, 8)}`,
      matchKey,
      request: {
        method: request.method.toUpperCase(),
        url: canonicalUrl(request.url),
        headers: normalizeHeaders(request.headers),
        body: bodyFromBase64(request.body, headerContentType(request.headers)),
      },
      response: {
        status: response.status,
        statusText: response.statusText || '',
        headers: response.headers,
        body: bodyFromBase64(response.body, headerContentType(response.headers)),
      },
      timings: {
        recordedAt: now,
      },
      test: {
        caseId: request.context?.caseId,
        name: request.context?.testName,
        suiteName: request.context?.suiteName,
      },
    };

    const existingIndex = this.cassette.entries.findIndex((candidate) => candidate.matchKey === matchKey);
    if (existingIndex >= 0) {
      entry.id = this.cassette.entries[existingIndex].id;
      this.cassette.entries[existingIndex] = entry;
    } else {
      this.cassette.entries.push(entry);
    }
    this.cassette.updatedAt = now;
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.cassette, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  private find(request: SerializedHttpRequest): CassetteEntry | undefined {
    const matchKey = createMatchKey(request);
    return this.cassette.entries.find((entry) => entry.matchKey === matchKey);
  }

  private isExcluded(request: SerializedHttpRequest): boolean {
    if (this.recordingExcludeUrls.length === 0) {
      return false;
    }

    const url = new URL(request.url);
    const normalizedUrl = canonicalUrl(request.url);

    return this.recordingExcludeUrls.some((exclusion) => {
      if (typeof exclusion === 'string') {
        return normalizedUrl.startsWith(canonicalExclusionPrefix(exclusion));
      }
      if (exclusion instanceof RegExp) {
        exclusion.lastIndex = 0;
        return exclusion.test(normalizedUrl);
      }
      if (typeof exclusion === 'function') {
        return exclusion(url, request);
      }
      return false;
    });
  }
}

function canonicalExclusionPrefix(pattern: string): string {
  try {
    return canonicalUrl(pattern);
  } catch {
    return pattern;
  }
}
