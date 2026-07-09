import type { OutboundThrottleRule } from './types.js';

/** Env var used to hand throttle rules to the spawned SUT process's preload. */
export const THROTTLE_CONFIG_ENV_VAR = 'SPECTEST_THROTTLE_CONFIG';

type SerializedMatch =
  | { kind: 'string'; value: string }
  | { kind: 'regexp'; source: string; flags: string };

interface SerializedThrottleRule {
  match: SerializedMatch;
  rps: number;
  name?: string;
}

/** RegExp doesn't survive JSON.stringify, so rules travel through the env var as this shape. */
export function serializeThrottleRules(rules: OutboundThrottleRule[]): string {
  const serialized: SerializedThrottleRule[] = rules.map((rule) => ({
    match:
      rule.match instanceof RegExp
        ? { kind: 'regexp', source: rule.match.source, flags: rule.match.flags }
        : { kind: 'string', value: rule.match },
    rps: rule.rps,
    name: rule.name,
  }));
  return JSON.stringify(serialized);
}

export function deserializeThrottleRules(json: string | undefined): OutboundThrottleRule[] {
  if (!json) return [];
  const parsed: SerializedThrottleRule[] = JSON.parse(json);
  return parsed.map((entry) => ({
    match: entry.match.kind === 'regexp' ? new RegExp(entry.match.source, entry.match.flags) : entry.match.value,
    rps: entry.rps,
    name: entry.name,
  }));
}

export function matchesRule(url: string, match: string | RegExp): boolean {
  if (typeof match === 'string') {
    return url.includes(match);
  }
  match.lastIndex = 0;
  return match.test(url);
}
