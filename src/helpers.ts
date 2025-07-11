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
  let lastOrder = typeof first.order === "number" ? first.order : 0;

  if (typeof first.order !== "number") {
    first.order = lastOrder;
  }

  for (let i = 1; i < tests.length; i += 1) {
    const test = tests[i];
    if (typeof test.order === "number") {
      if (test.order > lastOrder) {
        lastOrder = test.order;
        // keep predefined order if it maintains sequence
      } else {
        lastOrder += 1;
        test.order = lastOrder;
      }
    } else {
      lastOrder += 1;
      test.order = lastOrder;
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
