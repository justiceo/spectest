<div align="center">
  <img alt="spectest logo" src="https://github.com/justiceo/spectest/blob/main/assets/spectest-logo.png?raw=true" width="800px" />

  <h3 style="font-family: monospace; font-weight: 200; margin-bottom:30px">api testing + truly declarative x lightning fast & absurdly simple </h3>

[![Build](https://github.com/justiceo/spectest/actions/workflows/build.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/build.yml) 
[![Test](https://github.com/justiceo/spectest/actions/workflows/test.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/test.yml) 
[![NPM](http://img.shields.io/npm/v/spectest.svg)](https://www.npmjs.com/package/spectest) 
[![License](https://img.shields.io/npm/l/spectest.svg)](https://github.com/justiceo/spectest/blob/main/LICENSE)

</div>

## Getting Started

A spectest is a collection of test cases. The only required properties of a test case are
 * `name` - used to identify the case
 * `endpoint` - the API endpoint under test.

Most test cases include a `request` property which mirrors the fetch [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request) schema, and a `response` property that is used for assertions. The `response` property also mirrors the fetch [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) schema.

### 1. Define the server environment

At the root of your project, create the file `spectest.config.js`. For the purposes of this guide, we'll be using https://jsonplaceholder.typicode.com, which provides "free fake and reliable API for testing and prototyping".

```js
// spectest.config.js

export default {
  baseUrl: 'https://jsonplaceholder.typicode.com',
  testDir: './test',
  filePattern: '\\.spectest\\.',
};
```

For actual testing, the `baseUrl` should be the hostname of your server like `http://localhost:3000` for Express servers. The CLI would search for and process files that match `filePattern` under the `testDir`. For more config options, see [Config reference](#config-options).

### 2. Create some spec test cases

Create the file `test/jsonpayload.spectest.js` and paste the code below in it. **Note:** the file name needs to match the pattern defined in the config above.

```js
// jsonpayload.spectest.js

const tests = [
  // This basic example fetches {baseUrl}/todos/1 and asserts response status is 'OK'.
  {
    name: "Fetch TODO 1",
    endpoint: "/todos/1",
  },

  // In this case, spectest would assert the actual response matches both status code and json body. 
  {
    name: "Create a post",
    endpoint: "/posts",
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: { title: "foo", body: "bar", userId: 1 },
    },
    response: {
      status: 201,
      json: { id: 101, title: "foo", body: "bar", userId: 1 },
    },
  },
];

export default { name: 'jsonpayload', tests };
```

A `*.spectest.js` file can have `classes`, `functions`, use `imports` and do anything you would with Javascript. The default export may be either an array of test cases or an object with a `tests` array and optional `name` property. For the full schema of a test case, see [Testcase reference](#test-case-options)

### 3. Run the test cases

You can run the test cases with:
```bash
$ npx spectest

# Run the cases in a specific file
$ npx spectest jsonpayload.spectest.js

# Set/override the configs in step 1
$ npx spectest --base-url="https://jsonplaceholder.typicode.com" jsonpayload.spectest.js
```

All three commands above will have the same output, and it would look like:

```
📊 Test Summary:
 [✅] Fetch TODO 1 (53ms)
 [✅] Create a post (108ms)

✅ 2/2 tests passed!
📋 Server logs captured: 0
⏱️ Latency: min 53ms; avg 80ms; max 108ms
⏱️ Testing time: 0.11s; Total time: 0.18s
```

## Why Spectest
While building an API, I kept running into the same frustrating loop: after writing comprehensive Jest tests, I still had to manually “verify” the API by running it through a frontend client.

Here’s why Jest alone wasn’t enough:

1. **Mocks obscure reality** – Jest enables mocking which simulate behavior but can hide real issues in production.

2. **Multi-step flows were painful** – Chaining flows like `login → verify → fetch` was hard to write and even harder to maintain.

3. **No browser-like behavior** – Jest couldn’t replicate real-world HTTP behavior like cookie persistence or automatic attachment.

4. **API-centric needs were missing** – Load testing, proxying, and concurrency checks weren’t feasible out of the box.

What I really needed was a way to **verify my API** contract the same way a frontend does—but **without** reaching for heavyweight tools like Selenium or Playwright.

That’s where Spectest was born—out of necessity.


## API Reference


### Test case options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `name` | Human readable test name | required |
| `endpoint` | Request path relative to the base URL | required |
| `request.method` | HTTP method | `GET` |
| `request.headers` | Additional request headers | none |
| `request.body` | Request payload | none |
| `request.*` | Other valid fetch [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request) option keys, e.g. `cache`, `mode`. | none |
| `response.status` | Expected HTTP status | `200` |
| `response.json` | Expected partial JSON body | none |
| `response.schema` | Zod or JSON schema for response | none |
| `response.headers` | Expected response headers | none |
| `response.*` | Other valid fetch [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) response keys e.g. `statusText`, `type`. | none |
| `beforeSend` | Function used to finalize the request | none |
| `postTest` | Function used to process response, usually to extract and save data. | none |
| `order` | Execution order for grouping tests | `0` |
| `tags` | Tags used for filtering | none |
| `skip` | Skip the test case | `false` |
| `focus` | Run only focused tests when present | `false` |
| `repeat` | Extra sequential runs of the test | `0` |
| `bombard` | Additional runs at the same order | `0` |
| `delay` | Milliseconds to wait before running | none |
| `timeout` | Per-test timeout override | runtime `timeout` (30000ms) |

### Config options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `configFile` | Path to an extra config file | none |
| `baseUrl` | Base URL of the API | `http://localhost:3000` |
| `testDir` | Directory containing test suites | `./test` |
| `filePattern` | Regex for suite filenames | `\.spectest\.` |
| `startCmd` | Command to start the test server | `npm run start` |
| `runningServer` | Handling for an existing server (`reuse`, `fail`, or `kill`) | `reuse` |
| `tags` | String list used for filtering tests | [] |
| `rps` | Requests per second rate limit | Infinity |
| `timeout` | Default request timeout in milliseconds | `30000` |
| `snapshotFile` | Path to write a snapshot file | none |
| `bail` | Stop after the first failure | `false` |
| `randomize` | Shuffle tests ordering before execution | `false` |
| `happy` | Run only tests expecting 2xx status. Quick filter for testing the happy path. | `false` |
| `filter` | Regex or smart filter to select tests (`happy`, `failures`) | none |
| `verbose` | Verbose output with logs | `false` |
| `userAgent` | Browser User-Agent string to send or one of the predefined [user-agents](https://github.com/justiceo/spectest/blob/main/src/user-agents.ts). | `chrome_windows` |
| `suiteFile` | Run only the specified suite file | none |
| `projectRoot` | Root directory of the project | current working directory |


## API Testing Tips

### Controlling concurrency

By default, test requests are sent in parallel, if your API calls other APIs during test, this might result in unintentionally spamming that 3P backend.  To avoid this, set `rps` in `spectest.config.js` or pass `--rps=<number>` on the command line. A rate limiter ensures that no more than the configured number of requests are sent each second.

### Testing multi-step flows

The `order` test case parameter forces tests to be executed in pre-defined order. By default all tests execute have `order` of `0`, a test case with `order > 0` will execute after all cases with `order == 0`.

The test case `postTest` function can be used to extract and save data from a test case.<br>
In a similar vein, the test case `beforeSend` function can be used make final runtime modifications to a request before send.


```js
// auth.spectest.js

let token;

export default [
  {
    name: 'Login',
    endpoint: '/login',
    request: {
      method: 'POST',
      body: { username: 'admin', password: 'secret' }
    },
    postTest: async ({ json }) => { token = json.token; },
    order: 0,
  },
  {
    name: 'Fetch profile',
    endpoint: '/profile',
    beforeSend: req => {
      req.headers = { ...req.headers, Authorization: `Bearer ${token}` };
    },
    response: { status: 200 }
    order: 1,
  }
];
```

### Filtering test cases

There are multiple strategies for filtering test cases


#### Filter by tag

If test cases are tagged, the tags can be used to filter them. A test case can have as many tags as possible.

```js
export default [
  {
    name: "Fetch TODOs",
    endpoint: "/todos/",
    tags: ['todo', 'collection']
  },
  {
    name: "Fetch TODO 1",
    endpoint: "/todos/1",
    tags: ['todo', 'item']
  },
  {
    name: "Fetch Comments",
    endpoint: "/comments/",
    tags: ['comments', 'collection']
  },
  {
    name: "Fetch Comment 1",
    endpoint: "/comments/1",
    tags: ['comments', 'item']
  },
];
```

You can run only todo tests with `npx spectest --tags=todo`, and can combine multiple tags `npx spectest --tags=todo,collections`.

#### Specify name of test file

`npx spectest sometest.spectest.js` will run only the suites in `sometest.spectest.js`

#### Specify pattern for a group of test files

`npx spectest --filePattern="auth*"` will run all tests in files with `auth` prefix.

#### Use smart filters

Use `--filter=<pattern>` to run tests whose names match `<pattern>`. Several smart
filters are provided:

`--filter=happy` filters to only the tests expecting a 2xx status, a quick way to verify the happy path.

`--filter=failures` reruns only the tests that failed in the snapshot from the previous run.

### Test timeout

Use the `timeout` option to limit how long each test case may run. Specify `timeout` in `spectest.config.js` or pass `--timeout=<milliseconds>` on the command line. The default is `30000` (30 seconds). Individual tests can override this by including a `timeout` property. When a request exceeds the effective timeout, the test fails with a `⏰` indicator in the summary.

### Check for robustness of API

* **Randomize tests**: Run tests with `--randomize` to uncover unexpected test order dependencies. Randomization doesn't affect tests with explicitly declared order, using `order`. This is especially useful for serverless functions, that should be stateless.

* **Load testing**: Use the `--bombard` parameter to literally bombard the API with requests. It can also be set at the individual test case level to determine how an API would handle a flooding of that endpoint.

* **Simulating request from mobile devices**: The `--user-agent` param can be used to set the request UserAgent to that of mobile devices. Spectest provides definitions for the user-agents of popular desktop and mobile devices.

### Updating tests from failed responses 

Use the `--snapshot=<file>` option to write the executed test cases to a JSON
file. Each case records the final request that was sent, the actual server response, in addition to the result status (`pass`, `fail`, or `timeout`) and other metadata.

You can easily update failed tests by copying the responses in the snapshot file into the test cases.

### Working with large test suites

The `spectest/helpers` module contain utility functions for batch modifying test cases. Most attributes that can be applied to a test case has a similarly named batch helper.

The collection below
```js
const suite = [
  {
    name: "Get todo list",
    endpoint: "/todos",
    delay: 500,
    focus: true,
  },
  {
    name: "Fetch TODO 1",
    endpoint: "/todos/1",
    delay: 500,
    focus: true,
  },
];
export default suite;
```

Is the same as 
```js
import {focus, delay} from 'spectest/helpers';

const suite = [
  {
    name: "Get todo list",
    endpoint: "/todos",
  },
  {
    name: "Fetch TODO 1",
    endpoint: "/todos/1",
  },
];
export default focus(delay(suite, 500));
```

And you can create your own helpers to reduce repetition of common request/response properties!

### Test formats

Test cases can be written in `.js`, plain `.json` files, or `.mjs` for ESM and `.cjs` for CommonJs modules.

Typescript (`.ts`) files are not yet supported, you'd need to transpile them to any of the supported Js modules above.


