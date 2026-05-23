import { BatchInterceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { HttpRecordingCassette, type MissingRecordingBehavior, type RecordingMode, type RecordingUrlExclusion, type SerializedHttpRequest, type SerializedHttpResponse } from './recording-cassette';

export interface UseHttpRecordingsOptions {
  file: string;
  mode: RecordingMode;
  missingRecordingBehavior?: MissingRecordingBehavior;
  recordingExcludeUrls?: RecordingUrlExclusion[];
  match?: unknown;
  redact?: unknown;
}

async function requestToSerialized(request: Request): Promise<SerializedHttpRequest> {
  const clone = request.clone();
  const body = ['GET', 'HEAD'].includes(request.method.toUpperCase())
    ? null
    : Buffer.from(await clone.arrayBuffer()).toString('base64');
  return {
    method: request.method,
    url: request.url,
    headers: Array.from(request.headers.entries()),
    body,
  };
}

async function responseToSerialized(response: Response): Promise<SerializedHttpResponse> {
  const clone = response.clone();
  const body = Buffer.from(await clone.arrayBuffer()).toString('base64');
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body,
  };
}

function responseFromSerialized(response: SerializedHttpResponse): Response {
  const body = response.status === 204 || response.status === 304
    ? null
    : Buffer.from(response.body || '', 'base64');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: replayHeaders(response.headers),
  });
}

function replayHeaders(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== 'content-encoding' && normalized !== 'content-length';
  });
}

async function getSpectestVersion(): Promise<string> {
  try {
    const packageJsonUrl = new URL('../package.json', import.meta.url);
    const raw = await readFile(packageJsonUrl, 'utf8');
    return JSON.parse(raw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function useHttpRecordings(options: UseHttpRecordingsOptions): Promise<{ dispose(): Promise<void> }> {
  const cassette = new HttpRecordingCassette({
    file: options.file,
    mode: options.mode,
    missingRecordingBehavior: options.missingRecordingBehavior,
    recordingExcludeUrls: options.recordingExcludeUrls,
    spectestVersion: await getSpectestVersion(),
  });
  await cassette.load();

  const interceptor = new BatchInterceptor({
    name: `spectest-recordings-helper-${randomUUID()}`,
    interceptors: [
      new ClientRequestInterceptor(),
      new XMLHttpRequestInterceptor(),
      new FetchInterceptor(),
    ],
  });
  const pending = new Map<string, SerializedHttpRequest>();

  interceptor.on('request', async ({ request, requestId, controller }) => {
    const serializedRequest = await requestToSerialized(request);
    const decision = cassette.decide(serializedRequest);
    if (decision.action === 'replay' && decision.response) {
      controller.respondWith(responseFromSerialized(decision.response));
      return;
    }
    if (decision.action === 'fail') {
      controller.errorWith(new Error(decision.error || 'No matching HTTP recording'));
      return;
    }
    if (decision.action === 'record') {
      pending.set(requestId, serializedRequest);
    }
  });

  interceptor.on('response', async ({ requestId, response }) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    cassette.record(request, await responseToSerialized(response));
  });

  interceptor.apply();

  return {
    async dispose() {
      interceptor.dispose();
      await cassette.save();
    },
  };
}

export type { MissingRecordingBehavior, RecordingMode, RecordingUrlExclusion };
