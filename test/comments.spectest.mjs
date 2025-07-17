const suite = {
  name: "Comments Tests",
  tests: [
    {
      name: "Fetch comment 1",
      operationId: "fetchComment1",
      endpoint: "/comments/1",
    },
    {
      name: "Fetch comment 2",
      operationId: "fetchComment2",
      dependsOn: ["fetchComment1"],
      endpoint: "/comments/2",
    },
  ],
};

export default suite;
