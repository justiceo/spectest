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
};
