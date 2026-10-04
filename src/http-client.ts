import type { PluginHost } from './plugin-host';

// Plain objects and arrays are sent as JSON; fetch-native bodies (form data,
// URLSearchParams, Blobs, buffers, streams) pass through untouched.
function isJsonSerializable(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  if (typeof FormData !== 'undefined' && data instanceof FormData) return false;
  if (data instanceof URLSearchParams) return false;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return false;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return false;
  if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) return false;
  return true;
}

export class HttpClient {
  private baseURL: string;
  private timeout: number;
  private headers: Record<string, string>;
  private pluginHost: PluginHost;

  constructor(config: {
    baseURL: string;
    timeout: number;
    pluginHost: PluginHost;
  }) {
    this.baseURL = config.baseURL;
    this.timeout = config.timeout;
    this.pluginHost = config.pluginHost;
    this.headers = {};
  }

  public setHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  public getTimeout(): number {
    return this.timeout;
  }

  public async request(options: any): Promise<any> {
    const url = new URL(options.url, this.baseURL);
    const requestHeaders: Record<string, string> = { ...this.headers, ...options.headers };
    let requestBody = options.data;

    if (isJsonSerializable(options.data)) {
      requestBody = JSON.stringify(options.data);
      // Keep an explicit content type (e.g. application/merge-patch+json); setting a
      // second, differently-cased key would make fetch join the two values.
      const hasContentType = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type');
      if (!hasContentType) requestHeaders['Content-Type'] = 'application/json';
    }

    const initialRequest = new Request(url.toString(), {
      method: options.method,
      headers: requestHeaders,
      body: requestBody,
      // 'manual' surfaces a 3xx response itself instead of following it.
      ...(options.redirect ? { redirect: options.redirect } : {}),
    });

    const transformedRequest = await this.pluginHost.transformRequest(
      initialRequest
    );

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let externalAbortHandler: (() => void) | undefined;

    if (options.signal?.aborted) {
      externallyAborted = true;
      controller.abort();
    } else if (options.signal) {
      externalAbortHandler = () => {
        externallyAborted = true;
        controller.abort();
      };
      options.signal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeout || this.timeout);

    try {
      const response = await fetch(transformedRequest, {
        signal: controller.signal,
      });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = text;
      }

      return {
        status: response.status,
        data,
        headers: response.headers,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        if (externallyAborted && !timedOut) {
          const cancellationError = new Error('Request cancelled');
          cancellationError.name = 'AbortError';
          throw cancellationError;
        }
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (options.signal && externalAbortHandler) {
        options.signal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
