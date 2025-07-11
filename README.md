<div align="center">
  <img alt="spectest logo" src="https://github.com/justiceo/spectest/blob/3a53b5ed4673c2f54ba2452da7fb1da392c57a25/spectest-logo.png?raw=true" width="600px" />

  <h3 style="font-family: monospace; font-weight: 200">api testing + truly declarative x lightning fast & absurdly simple </h3>

[![Build](https://github.com/justiceo/spectest/actions/workflows/build.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/build.yml) 
[![Test](https://github.com/justiceo/spectest/actions/workflows/test.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/test.yml) 
[![NPM](http://img.shields.io/npm/v/spectest.svg)](https://www.npmjs.com/package/spectest) 
[![License](https://img.shields.io/npm/l/spectest.svg)](https://github.com/justiceo/spectest/blob/main/LICENSE)

</div>

## Get started

A spectest is a collection of request and response pairs. <br>
With spectest, you declare requests the way you would pass them to the [fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). Spectest mirrors the [request](https://developer.mozilla.org/en-US/docs/Web/API/Request) and [response](https://developer.mozilla.org/en-US/docs/Web/API/Response) schemas of normal browser/nodejs fetch requests.

#### 1. Define your request and response

```js
// file:jsonpayload.suite.js

const suite = [
  {
    name: "Fetch TODO 1",
    endpoint: "https://jsonplaceholder.typicode.com/todos/1",
  },
  {
    name: "Create a post",
    endpoint: "https://jsonplaceholder.typicode.com/posts",
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
export default suite;

```

#### 2. Run the test

```bash
$ npx spectest jsonpayload.suite.js

--------- ouput --------

📊 Test Summary:
 [✅] Fetch TODO 1 (53ms)
 [✅] Create a post (108ms)

🎉 2/2 tests passed!
📋 Server logs captured: 0
⏱️ Latency: min 53ms; avg 80ms; max 108ms
⏲️ Testing time: 0.11s
⏲️ Elapsed time: 0.18s
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


## Spectest config

To define common behavior for how and when requests, create a `spectest.config.js` file at the project root.
Below is the default config:

```js
export default {
  envFile: '.env',
  startCmd: 'npm run start',
  baseUrl: 'https://localhost:8080',
  suitesDir: './spec',
  testMatch: '\\.(suite|suites)\\.js$',
  rps: Infinity,
  timeout: 30000,
  randomize: false,
  bail: false,
  happy: false,
  runningServer: 'reuse',
  userAgent: 'chrome_windows',
};
```



## Test case options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `name` | Human readable test name | required |
| `endpoint` | Request path relative to the base URL | required |
| `order` | Execution order for grouping tests | `0` |
| `tags` | Tags used for filtering | none |
| `skip` | Skip the test case | `false` |
| `focus` | Run only focused tests when present | `false` |
| `repeat` | Extra sequential runs of the test | `0` |
| `bombard` | Additional runs at the same order | `0` |
| `delay` | Milliseconds to wait before running | none |
| `timeout` | Per-test timeout override | runtime `timeout` (30000ms) |
| `request.method` | HTTP method | `GET` |
| `request.headers` | Additional request headers | none |
| `request.body` | Request payload | none |
| `request.credentials` | `'include'` to send cookies | none |
| `response.status` | Expected HTTP status | `200` |
| `response.json` | Expected partial JSON body | none |
| `response.jsonSchema` | Zod or JSON schema for response | none |
| `response.headers` | Expected response headers | none |
| `beforeSend` | Function to modify the request | none |
| `postTest` | Function called after the response | none |

## Runtime options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `configFile` | Path to an extra config file | none |
| `envFile` | `.env` file to load before tests | `.env` |
| `baseUrl` | Base URL of the API | `https://jsonplaceholder.typicode.com` |
| `suitesDir` | Directory containing test suites | `./spec` |
| `testMatch` | Regex for suite filenames | `\.(suite|suites)\.js$` |
| `startCmd` | Command to start the test server | `npm run start` |
| `runningServer` | Handling for an existing server (`reuse`, `fail`, or `kill`) | `reuse` |
| `tags` | Only run tests with these tags | none |
| `rps` | Requests per second rate limit | `5` |
| `timeout` | Default request timeout in milliseconds | `30000` |
| `snapshotFile` | Path to write a snapshot file | none |
| `bail` | Stop after the first failure | `false` |
| `randomize` | Shuffle tests with the same order | `false` |
| `happy` | Run only tests expecting 2xx status | `false` |
| `verbose` | Verbose output with logs | `false` |
| `userAgent` | Browser User-Agent string to send | `chrome_windows` |
| `suiteFile` | Run only the specified suite file | none |
| `projectRoot` | Root directory of the project | current working directory |


### Controlling request rate

To avoid overwhelming your server during test runs, Spectest supports a **requests per second (rps)** option. Set `rps` in `spectest.config.js` or pass `--rps=<number>` on the command line. A simple token bucket limiter ensures that no more than the configured number of requests are sent each second.

### Test timeout

Use the `timeout` option to limit how long each test case may run. Specify `timeout` in `spectest.config.js` or pass `--timeout=<milliseconds>` on the command line. The default is `30000` (30 seconds). Individual tests can override this by including a `timeout` property. When a request exceeds the effective timeout, the test fails with a `⏰` indicator in the summary.

### Randomizing test order

Use the `--randomize` flag or set `randomize: true` in `spectest.config.js` to shuffle tests that share the same `order` value. This helps catch hidden dependencies without changing the overall order of distinct groups.

### Bailing on first failure

Pass the `--bail` flag or set `bail: true` in `spectest.config.js` to stop executing
lower-order test groups once a failure is detected. Any remaining tests are
marked as skipped in the summary.

### Saving snapshots

Use the `--snapshot=<file>` option to write the executed test cases to a JSON
file. The snapshot contains a `lastUpdate` timestamp and a `cases` array. Each
case records the final request that was sent, the actual server response, the
result status (`pass`, `fail`, or `timeout`), and the latency in milliseconds.
If a snapshot file already exists, only the cases that were executed are
overwritten so skipped tests keep their previous data.

### Happy path filtering

Use the `--happy` flag or set `happy: true` in `spectest.config.js` to run only
tests whose expected `response.status` falls between 200 and 299. If a test
omits `response.status` it is treated as `200` for this check.

### Setting the User-Agent

All requests use a browser-like **User-Agent** header. Specify a custom agent
using `--user-agent=<name>` (or `--ua=<name>`) or set `userAgent` in
`fest.config.js`. The value may be one of the pre-defined names from
`chrome_windows`, `chrome_mac`, `chrome_android`, `chrome_ios`, `edge_windows`,
`safari_mac`, `safari_ios`, `firefox_windows`, `firefox_mac`, or
`opera_windows`. Any other value is used literally.


