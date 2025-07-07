function composeBeforeSend(...fns) {
  return (req, state) => fns.reduce((acc, fn) => fn(acc, state), req);
}

function composePostTest(...fns) {
  return async (response, state, ctx) => {
    await Promise.all(fns.map((fn) => fn(response, state, ctx)));
  };
}

function focus(tests) {
  return tests.map((test) => {
    test.focus = true;
    return test;
  });
}

function skip(tests) {
  return tests.map((test) => {
    test.skip = true;
    return test;
  });
}

export { composeBeforeSend, composePostTest, focus, skip };
