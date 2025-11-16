import type { PluginHost } from './plugin-host';

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
    const body =
      typeof options.data === 'object'
        ? JSON.stringify(options.data)
        : options.data;

    const initialRequest = new Request(url.toString(), {
      method: options.method,
      headers: { ...this.headers, ...options.headers },
      body,
    });

    const transformedRequest = await this.pluginHost.transformRequest(
      initialRequest
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => {
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
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
