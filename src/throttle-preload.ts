import { BatchInterceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest';
import RateLimiter from './rate-limiter.js';
import { THROTTLE_CONFIG_ENV_VAR, deserializeThrottleRules, matchesRule } from './throttle-config.js';

const rules = deserializeThrottleRules(process.env[THROTTLE_CONFIG_ENV_VAR]);
const limiters = rules.map((rule) => new RateLimiter(rule.rps));
let interceptor: { dispose(): void } | undefined;

if (rules.length > 0) {
  const batchInterceptor = new BatchInterceptor({
    name: 'spectest-throttle-preload',
    interceptors: [
      new ClientRequestInterceptor(),
      new XMLHttpRequestInterceptor(),
      new FetchInterceptor(),
    ],
  });

  // No respondWith/errorWith call here: this only delays the real request
  // until a token is available, it never fakes or blocks the response.
  batchInterceptor.on('request', async ({ request }) => {
    for (let i = 0; i < rules.length; i += 1) {
      if (matchesRule(request.url, rules[i].match)) {
        await limiters[i].acquire();
        return;
      }
    }
  });

  batchInterceptor.apply();
  interceptor = batchInterceptor;
}

/**
 * Test-only escape hatch: unpatches the intercepted globals and stops the
 * rate limiters' internal timers so a process that imported this module
 * (e.g. a unit test, never a real spawned SUT) can exit cleanly.
 */
export function disposeThrottlePreload(): void {
  interceptor?.dispose();
  limiters.forEach((limiter) => limiter.stop());
}
