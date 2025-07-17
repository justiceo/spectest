/* eslint-disable no-param-reassign */

function composeBeforeSend(...fns) {
  return (req, state) => fns.reduce((acc, fn) => fn(acc, state), req);
}

function composePostTest(...fns) {
  return async (response, state, ctx) => {
    await Promise.all(fns.map((fn) => fn(response, state, ctx)));
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

function seq(tests) {
  if (tests.length === 0) return tests;

  const first = tests[0];
  let lastBatch = typeof first.batch === "number" ? first.batch : 0;

  if (typeof first.batch !== "number") {
    first.batch = lastBatch;
  }

  for (let i = 1; i < tests.length; i += 1) {
    const test = tests[i];
    if (typeof test.batch === "number") {
      if (test.batch > lastBatch) {
        lastBatch = test.batch;
        // keep predefined batch if it maintains sequence
      } else {
        lastBatch += 1;
        test.batch = lastBatch;
      }
    } else {
      lastBatch += 1;
      test.batch = lastBatch;
    }
  }

  return tests;
}

function skip(tests) {
  return tests.map((test) => {
    test.skip = true;
    return test;
  });
}

export {
  composeBeforeSend,
  composePostTest,
  delay,
  focus,
  repeat,
  bombard,
  seq,
  skip,
};
