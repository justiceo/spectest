const suite = [
  {
    name: "Health Check",
    endpoint: "/v1/ping",
    request: {
      method: "GET",
      headers: {
        "x-requested-width": "XMLHttpRequest",
      },
    },
    response: {
      status: 200,
      json: { message: "pong" },
    },
  },
];
export default suite;
