import { AsyncLocalStorage } from 'async_hooks';
import http from 'http';
import https from 'https';
import { BatchInterceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest';
import type { RecordingContext, SerializedHttpRequest, SerializedHttpResponse } from './recording-cassette';

const storage = new AsyncLocalStorage<RecordingContext>();
const pending = new Map<string, SerializedHttpRequest>();
const decisions = new Map<string, (message: any) => void>();

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function contextFromIncoming(req: http.IncomingMessage): RecordingContext {
  return {
    caseId: headerValue(req, 'x-spectest-case-id'),
    testName: headerValue(req, 'x-spectest-test-name'),
    suiteName: headerValue(req, 'x-spectest-suite-name'),
    mode: headerValue(req, 'x-spectest-recording-mode') as RecordingContext['mode'],
    missingRecordingBehavior: headerValue(req, 'x-spectest-missing-recording-behavior') as RecordingContext['missingRecordingBehavior'],
  };
}

function patchServerEmit(proto: any): void {
  const originalEmit = proto.emit;
  if (originalEmit.__spectestPatched) return;

  function patchedEmit(this: http.Server, event: string | symbol, ...args: any[]) {
    if (event === 'request' && args[0]) {
      return storage.run(contextFromIncoming(args[0]), () => originalEmit.call(this, event, ...args));
    }
    return originalEmit.call(this, event, ...args);
  }
  patchedEmit.__spectestPatched = true;
  proto.emit = patchedEmit;
}

async function requestToSerialized(request: Request, requestId: string): Promise<SerializedHttpRequest> {
  const clone = request.clone();
  const body = ['GET', 'HEAD'].includes(request.method.toUpperCase())
    ? null
    : Buffer.from(await clone.arrayBuffer()).toString('base64');
  return {
    id: requestId,
    method: request.method,
    url: request.url,
    headers: Array.from(request.headers.entries()),
    body,
    context: storage.getStore(),
  };
}

async function responseToSerialized(response: Response): Promise<SerializedHttpResponse> {
  const clone = response.clone();
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: Buffer.from(await clone.arrayBuffer()).toString('base64'),
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

function send(message: any): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

patchServerEmit(http.Server.prototype);
patchServerEmit(https.Server.prototype);

process.on('message', (message: any) => {
  if (!message || message.type !== 'spectest:recording:decision') return;
  const resolve = decisions.get(message.requestId);
  if (!resolve) return;
  decisions.delete(message.requestId);
  resolve(message);
});

const interceptor = new BatchInterceptor({
  name: 'spectest-recording-preload',
  interceptors: [
    new ClientRequestInterceptor(),
    new XMLHttpRequestInterceptor(),
    new FetchInterceptor(),
  ],
});

interceptor.on('request', async ({ request, requestId, controller }) => {
  const serializedRequest = await requestToSerialized(request, requestId);
  send({ type: 'spectest:recording:request', requestId, request: serializedRequest });

  const decision: any = await new Promise((resolve) => {
    decisions.set(requestId, resolve);
  });

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
  send({
    type: 'spectest:recording:response',
    requestId,
    request,
    response: await responseToSerialized(response),
  });
});

interceptor.apply();
