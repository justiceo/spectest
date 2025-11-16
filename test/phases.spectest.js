export default [
  {
    name: "Setup Test",
    endpoint: "https://jsonplaceholder.typicode.com/posts/1",
    response: {
      status: 200,
    },
    phase: "setup",
  },
  {
    name: "Main Test",
    endpoint: "https://jsonplaceholder.typicode.com/posts/2",
    response: {
      status: 200,
    },
  },
  {
    name: "Teardown Test",
    endpoint: "https://jsonplaceholder.typicode.com/posts/3",
    response: {
      status: 200,
    },
    phase: "teardown",
  },
];
