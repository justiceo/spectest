/* eslint-disable no-param-reassign */

function composeBeforeSend(...fns) {
  return (req, state) => fns.reduce((acc, fn) => fn(acc, state), req);
}

function composePostTest(...fns) {
  return async (response, state, ctx) => {
    for (const fn of fns) {
      await fn(response, state, ctx);
    }
  };
}

function delay(tests, delayMs) {
  return tests.map((test) => {
    test.delay = delayMs;
    return test;
  });
}

function focus(tests) {
  return tests.map((test) => {
    test.focus = true;
    return test;
  });
}

function repeat(tests, count) {
  tests.forEach((test) => {
    test.repeat = count;
  });
  return tests;
}

function bombard(tests, count) {
  tests.forEach((test) => {
    test.bombard = count;
  });
  return tests;
}


function skip(tests) {
  return tests.map((test) => {
    test.skip = true;
    return test;
  });
}

function setup(tests) {
  return tests.map(test => {
    test.phase = 'setup';
    return test
  })
}

function teardown(tests) {
  return tests.map(test => {
    test.phase = 'teardown';
    return test
  })
}

function recording(tests, mode) {
  return tests.map((test) => {
    test.recording = mode;
    return test;
  });
}

// Mirrors openapi-loader's GENERATORS/GENERATOR_PLACEHOLDER: a `beforeSend`
// hook that re-rolls `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` tokens in a
// request's url/headers/data right before each send. `spectest generate
// openapi-tests` wires this into any scaffolded test whose example still
// contains one of these tokens, so re-running the same generated file
// produces a fresh value each time instead of replaying whatever was baked
// in at generation time (which breaks "must not already exist" endpoints
// like signup on the second run).
const PLACEHOLDER_GENERATORS = {
  uuid: () => crypto.randomUUID(),
  timestamp: () => String(Date.now()),
  shortId: () => Math.random().toString(36).slice(2, 10),
};

const PLACEHOLDER_PATTERN = /\{\{(uuid|timestamp|shortId)\}\}/g;

function resolvePlaceholders(value) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_PATTERN, (_match, name) => PLACEHOLDER_GENERATORS[name]());
  }
  if (Array.isArray(value)) {
    return value.map(resolvePlaceholders);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = resolvePlaceholders(nested);
    }
    return result;
  }
  return value;
}

function regenerateExampleData(config) {
  return {
    ...config,
    url: resolvePlaceholders(config.url),
    headers: resolvePlaceholders(config.headers),
    data: resolvePlaceholders(config.data),
  };
}

export {
  composeBeforeSend,
  composePostTest,
  delay,
  focus,
  repeat,
  bombard,
  skip,
  setup,
  teardown,
  recording,
  regenerateExampleData,
};
