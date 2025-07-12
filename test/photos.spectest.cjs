const suite = {
  name: "Photo Tests",
  tests: [
    {
      name: "Fetch album 1",
      endpoint: "/albums/1",
    },
    {
      name: "Fetch photo 1",
      endpoint: "/photos/1",
    },
  ],
};

module.exports = suite;
