const suite = [
  {
    name: "Fetch TODO 1",
    endpoint: "/todos/1",
  },
  {
    name: "Create a post",
    endpoint: "/posts",
    request: {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: {
        title: "foo",
        body: "bar",
        userId: 1,
      },
    },
    response: {
      status: 201,
      body: {
        id: 101,
        title: "foo",
        body: "bar",
        userId: 1,
      },
    },
  }
];
export default suite;
