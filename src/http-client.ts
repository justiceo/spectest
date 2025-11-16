import http from 'http';
import https from 'https';

export async function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const protocol = url.protocol === 'https:' ? https : http;

    const requestOptions = {
      method: options.method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      timeout: options.timeout,
      headers: options.headers,
    };

    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          resolve({
            status: res.statusCode,
            data: parsedData,
            headers: res.headers,
          });
        } catch (error) {
          resolve({
            status: res.statusCode,
            data,
            headers: res.headers,
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.data) {
      if (typeof options.data === 'object') {
        req.write(JSON.stringify(options.data));
      } else {
        req.write(options.data);
      }
    }

    req.end();
  });
}

export class HttpClient {
  private baseURL: string;
  private timeout: number;
  private headers: Record<string, string>;
  private proxy: any;

  constructor(config) {
    this.baseURL = config.baseURL;
    this.timeout = config.timeout;
    this.headers = {};
    this.proxy = config.proxy;
  }

  public setHeader(key, value) {
    this.headers[key] = value;
  }

  public getTimeout() {
    return this.timeout;
  }

  public async request(options) {
    const url = new URL(options.url, this.baseURL);
    const finalOptions = {
      ...options,
      url: url.toString(),
      timeout: options.timeout || this.timeout,
      headers: {
        ...this.headers,
        ...options.headers,
      },
      proxy: this.proxy,
    };
    return httpRequest(finalOptions);
  }
}
