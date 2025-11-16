export default {
  name: 'Suite Phases',
  setup: [
    {
      name: 'Suite Setup Test',
      endpoint: 'https://jsonplaceholder.typicode.com/posts/1',
      response: {
        status: 200,
      },
    },
  ],
  tests: [
    {
      name: 'Suite Main Test',
      endpoint: 'https://jsonplaceholder.typicode.com/posts/2',
      response: {
        status: 200,
      },
    },
  ],
  teardown: [
    {
      name: 'Suite Teardown Test',
      endpoint: 'https://jsonplaceholder.typicode.com/posts/3',
      response: {
        status: 200,
      },
    },
  ],
};
