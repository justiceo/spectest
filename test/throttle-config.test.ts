import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deserializeThrottleRules, matchesRule, serializeThrottleRules } from '../src/throttle-config.js';
import type { OutboundThrottleRule } from '../src/types.js';

test('serializeThrottleRules/deserializeThrottleRules round-trips string and RegExp match rules', () => {
  const rules: OutboundThrottleRule[] = [
    { match: 'openprovider.eu', rps: 5, name: 'openprovider' },
    { match: /api\.example\.com\/v[12]\//i, rps: 2 },
  ];

  const roundTripped = deserializeThrottleRules(serializeThrottleRules(rules));

  assert.equal(roundTripped.length, 2);
  assert.equal(roundTripped[0].match, 'openprovider.eu');
  assert.equal(roundTripped[0].rps, 5);
  assert.equal(roundTripped[0].name, 'openprovider');

  assert.ok(roundTripped[1].match instanceof RegExp);
  assert.equal((roundTripped[1].match as RegExp).source, 'api\\.example\\.com\\/v[12]\\/');
  assert.equal((roundTripped[1].match as RegExp).flags, 'i');
  assert.equal(roundTripped[1].rps, 2);
});

test('deserializeThrottleRules returns an empty array for undefined input', () => {
  assert.deepEqual(deserializeThrottleRules(undefined), []);
});

test('matchesRule treats a string match as a substring test against the full URL', () => {
  assert.equal(matchesRule('https://api.openprovider.eu/v1/domains', 'openprovider.eu'), true);
  assert.equal(matchesRule('https://api.example.com/v1/domains', 'openprovider.eu'), false);
});

test('matchesRule tests a RegExp match directly and resets lastIndex for reused global regexes', () => {
  const pattern = /openprovider\.eu/g;
  assert.equal(matchesRule('https://api.openprovider.eu/v1/domains', pattern), true);
  // A prior test() call on a global regex advances lastIndex; matchesRule must reset it
  // so repeated calls against fresh URLs aren't affected by where the last match left off.
  assert.equal(matchesRule('https://api.openprovider.eu/v1/customers', pattern), true);
});
