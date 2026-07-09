<div align="center">
  <img alt="spectest logo" src="https://github.com/justiceo/spectest/blob/main/assets/spectest-logo.png?raw=true" width="800px" />

  <h1>Spectest</h1>
  <h3 style="font-family: monospace; font-weight: 200;">declarative API testing CLI for fast HTTP endpoint tests</h3><br>

[![Build](https://github.com/justiceo/spectest/actions/workflows/build.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/build.yml) 
[![Test](https://github.com/justiceo/spectest/actions/workflows/test.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/test.yml) 
[![NPM](http://img.shields.io/npm/v/spectest.svg)](https://www.npmjs.com/package/spectest) 
[![License](https://img.shields.io/npm/l/spectest.svg)](https://github.com/justiceo/spectest/blob/main/LICENSE)

</div>

Spectest is a lightweight API testing CLI for writing declarative HTTP endpoint tests in JavaScript, JSON, or YAML. Use it to verify REST APIs, assert status codes, headers, JSON payloads, and schemas, test multi-step API flows, replay recorded outbound HTTP calls, and run concurrency or load checks without a browser automation framework.

## Features

* **Declarative API tests**: describe requests and expected responses with a simple `*.spectest.*` file.
* **HTTP assertions**: validate status codes, response headers, partial JSON bodies, and Zod or JSON schemas.
* **OpenAPI loading**: run OpenAPI 3.0/3.1 operations directly with `--openapi`.
* **API flow testing**: chain login, setup, teardown, and dependent requests with shared response state.
* **Record and replay**: capture outbound `fetch`, `http`, `https`, and common Node library calls into reusable cassettes.
* **CLI-first workflow**: run tests with `npx spectest`, filter by tags or names, randomize ordering, and snapshot failures.
* **Concurrency and load checks**: send tests in parallel, rate-limit requests, or bombard endpoints to check API robustness.

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

export default tests;
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

### Running OpenAPI documents

Spectest can load OpenAPI 3.0 and 3.1 documents directly:

```bash
npx spectest --openapi ./examples/openapi/jsonplaceholder.yaml --base-url=https://jsonplaceholder.typicode.com
```

Generated tests stay in memory; Spectest does not write `.spectest` files for this workflow (see `spectest generate openapi-tests` below if you want a written scaffold instead). Spectest uses examples or schema defaults for required path/query/header/cookie parameters and required JSON request bodies. Operations that need missing values, unsupported media types, unsupported parameter serialization, unresolved external refs, unsupported schema constructs, or unavailable auth/hook lookups are generated as skipped tests with skip reasons.

When both `--openapi` and `testDir` are configured, Spectest loads OpenAPI-generated tests and hand-written suites into the same run and dependency graph — a hand-written suite can `dependsOn` a spec-generated `operationId`, and duplicate `operationId`s across the two sources fail fast via the same uniqueness check.

#### Multiple examples per operation

If a request body, parameter, or response defines an `examples` map (rather than a single `example`), Spectest generates one test per entry. Each generated test's `operationId` becomes `${operationId}+${exampleKey}` and its name gets a ` — ${exampleKey}` suffix.

The expected response for a given request example is resolved in order:
1. `x-spectest.status` declared on that example.
2. A response example under a documented non-2xx status sharing the same key as the request example.
3. The lowest documented `2xx` status (the v1 default).

An operation with no `examples` map behaves exactly as before (a single generated test, unsuffixed `operationId`).

#### `x-spectest` vendor extension

A single vendor extension, allowed on an operation and on an individual entry inside an `examples` map (example-level overrides operation-level):

```yaml
x-spectest:
  status: 400
  tags: [slow, real-backend]
  skip: true
  skipReason: "hits real registrar, run manually"
  phase: setup | main | teardown
  dependsOn: [operationId, "otherOperationId+exampleKey"]
  beforeSend: hookName        # looked up in cfg.openapiHooks
  postTest: hookName
  security: none | variantName
  generate:                   # dynamic values, see below
    orderId: uuid
    "product.domainName": shortId
```

#### Named hook registry

Add `openapiHooks` to `spectest.config.js` to give `x-spectest.beforeSend`/`postTest` something to resolve against:

```js
export default {
  openapiHooks: {
    extractOneTimeToken: {
      postTest: async (res, state, ctx) => { /* scrape ctx.logs, stash in state */ },
    },
  },
};
```

A name referenced by `x-spectest` that isn't in `openapiHooks` generates a skipped test with a reason, the same way a missing `openapiAuth` hook does — it never crashes the loader.

#### Dynamic example values

Use `{{uuid}}`, `{{timestamp}}`, or `{{shortId}}` as a literal example string to get a fresh value resolved once per generated test (stable across `repeat`/`bombard` reruns of that same test). For object bodies, `x-spectest.generate` is the path-keyed alternative — list which fields need freshness per run instead of rewriting the example. Both are opt-in; Spectest still never synthesizes data for a property that has no example.

#### Explicit non-default auth cases

`openapiAuth` entries can be either a single hook (as in v1) or a named-variant map, to let you deliberately generate a test with missing/expired credentials:

```js
export default {
  openapiAuth: {
    session: {
      valid: async (ctx) => ({ headers: { Cookie: 'session=...' } }),
      expired: async (ctx) => ({ headers: { Cookie: 'session=expired' } }),
      missing: async () => ({}),
    },
  },
};
```

Set `x-spectest.security: none` to bypass security application entirely for an example, or `x-spectest.security: expired` (etc.) to pick a variant. With no override, a variant map defaults to its `valid` entry.

#### Native `links` for chaining

Standard OpenAPI `responses.<status>.links` are honored for simple data-passing chains (e.g. register something, then fetch it using the `orderId` from the first response). When operation B has an unresolved parameter or request body and an earlier operation A declares a link targeting B by `operationId`, Spectest auto-generates `dependsOn: [A]` plus a `beforeSend` that reads the linked value from `state.completedCases[A]` via the link's runtime expression (`$response.body#/pointer` or `$response.header.<name>`). This only applies when A itself resolves to exactly one generated test; if A was split by multiple examples, use `x-spectest.dependsOn` + `beforeSend`/hooks instead.

#### Contract coverage reporting

```bash
npx spectest --openapi ./openapi.yaml --coverage-report
npx spectest --openapi ./openapi.yaml --coverage-report --coverage-report-file ./coverage.txt
```

After the run, prints one line per spec operation: `generated & passed`, `generated & failed`, `generated & skipped (<reason>)`, `covered by hand-written test <operationId>` (when a hand-written suite's request matches that operation's method/path but no generated test ran for it), or `uncovered`.

#### Scaffolding editable test files

```bash
npx spectest generate openapi-tests --openapi ./openapi.yaml --output ./test
```

Writes a `.spectest.js` file with the same generated tests Spectest would run in-memory, as an editable starting point for suites that will grow real `beforeSend`/`postTest` logic by hand. Anything expressible this way is already expressible via direct `--openapi` loading — this is a convenience/onboarding command, not a coverage unlock.

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
| `operationId` | Unique identifier for the operation | `name` |
| `phase` | Execution phase of the test (`setup`, `main`, or `teardown`) | `main` |
| `dependsOn` | Array of `operationId` strings that must pass before this test runs | none |
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
| `tags` | Tags used for filtering | none |
| `skip` | Skip the test case | `false` |
| `focus` | Run only focused tests when present | `false` |
| `repeat` | Extra sequential runs of the test | `0` |
| `bombard` | Additional simultaneous runs of the test | `0` |
| `delay` | Milliseconds to wait before running | none |
| `timeout` | Per-test timeout override | runtime `timeout` (60000ms) |
| `recording` | Per-test HTTP recording mode override (`off`, `replay`, or `record`) | runtime `recording` |

### Config options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `configFile` | Path to an extra config file | none |
| `baseUrl` | Base URL of the API | `http://localhost:3000` |
| `testDir` | Directory containing test suites | `./test` |
| `filePattern` | Regex for suite filenames | `\.spectest\.` |
| `startCmd` | Command to start the test server | `npm run start` |
| `buildCmd` | Command to build the test server | none |
| `runningServer` | Handling for an existing server (`reuse`, `fail`, or `kill`) | `reuse` |
| `serverStartupTimeout` | Max time (ms) to wait for a spawned server to become ready before failing | `30000` |
| `serverHealthCheckInterval` | Interval (ms) between server readiness health check attempts | `250` |
| `tags` | String list used for filtering tests | [] |
| `rps` | Requests per second rate limit | Infinity |
| `timeout` | Default request timeout in milliseconds | `60000` |
| `snapshotFile` | Path to write a snapshot file | none |
| `randomize` | Shuffle tests ordering before execution | `false` |
| `happy` | Run only tests expecting 2xx status. Quick filter for testing the happy path. | `false` |
| `filter` | Regex or smart filter to select tests (`happy`, `failures`) | none |
| `testOutput` | Executed test result detail (`summary` or `errors`). Use `errors` to include failed-test server logs and failure reasons in the report. | `summary` |
| `verbose` | Verbose spectest runner/program output. This is separate from test result detail. | `false` |
| `userAgent` | Browser User-Agent string to send or one of the predefined [user-agents](https://github.com/justiceo/spectest/blob/main/src/user-agents.ts). | `chrome_windows` |
| `recording` | HTTP recording mode for outbound Node SUT requests (`off`, `replay`, or `record`) | `off` |
| `recordingFile` | JSON cassette path used for HTTP recordings | `.spectest/cassette.json` |
| `missingRecordingBehavior` | Behavior when replay cannot find a cassette entry (`fail`, `record`, or `bypass`) | `fail` |
| `recordingExcludeUrls` | URL patterns that always bypass HTTP cassette handling | `[]` |
| `outboundThrottle` | Rate limit rules capping outbound requests the Node SUT process makes to matching backends | `[]` |
| `openapi` | Path to an OpenAPI 3.0/3.1 document to load directly | none |
| `openapiServer` | Server URL or index to select when an OpenAPI document has multiple `servers` entries | none |
| `openapiAuth` | Map of OpenAPI security scheme names to request mutation hooks, or to a named-variant map (`{ valid, expired, ... }`) | `{}` |
| `openapiHooks` | Map of hook names to `{ beforeSend?, postTest? }`, resolved by `x-spectest.beforeSend`/`postTest` | `{}` |
| `coverageReport` (`--coverage-report`) | Print an OpenAPI contract coverage report after the run | `false` |
| `coverageReportFile` (`--coverage-report-file`) | Write the coverage report to a file instead of stdout | none |
| `suiteFile` | Run only the specified suite file | none |
| `projectRoot` (`--dir`) | Root directory of the project | current working directory |

`testOutput` can also be set from the CLI with `--test-output=summary` or `--test-output=errors`. HTTP recording can be set with `--recording=off|replay|record`, `--recording-file=<path>`, and `--missing-recording-behavior=fail|record|bypass`. CLI values override `spectest.config.js`.


## API Testing Tips

### Setup and Teardown

For tests that need to run before all others (e.g., checking server status) or after all others (e.g., logging out), you can use the `phase` property. The `phase` can be set to `setup`, `main` (default), or `teardown`.

This is syntactic sugar for `dependsOn`, ensuring that `setup` tests block `main` and `teardown` tests, and `main` tests block `teardown` tests.

```js
export default [
  {
    name: 'Ping Server',
    endpoint: '/ping',
    response: { status: 200 },
    phase: 'setup',
  },
  {
    name: 'Main Test',
    endpoint: '/some-data',
    response: { status: 200 },
  },
  {
    name: 'Logout',
    endpoint: '/logout',
    response: { status: 200 },
    phase: 'teardown',
  },
];
```

Alternatively, you can structure your suite with `setup`, `tests`, and `teardown` properties:

```js
export default {
  name: 'My Suite',
  setup: [
    {
      name: 'Ping Server',
      endpoint: '/ping',
      response: { status: 200 },
    },
  ],
  tests: [
    {
      name: 'Main Test',
      endpoint: '/some-data',
      response: { status: 200 },
    },
  ],
  teardown: [
    {
      name: 'Logout',
      endpoint: '/logout',
      response: { status: 200 },
    },
  ],
};
```

### Making dynamic assertions

The responses from APIs are often dynamic, however we often know their structure. For example, expecting an API to return a timestamp but unable to assert on a timestamp without mocking. For these cases, use **[Zod](https://zod.dev/) schema** to describe the shape and properties of the data expected in the response.

The second example response above could have been written as:


```js
import { z } from 'zod';

const tests = [
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
      schema: z.object({
        id: z.number(),
        title: z.string(),
        body: z.literal('foo'),
        userId: z.number().min(1)
      }),
    },
  },
];

export default tests
```

With `schema`, you can describe the shape of the data while allowing it to take on different literal values. You can use both `json` and `schema` for assertions in the same test case. 

`schema` also accepts a raw JSON Schema (or OpenAPI 3.0/3.1 Schema Object) directly — no wrapper needed:

```js
response: {
  status: 201,
  schema: {
    type: 'object',
    required: ['id', 'title'],
    properties: {
      id: { type: 'integer' },
      title: { type: 'string' },
    },
  },
},
```

OpenAPI 3.0/3.1 Schema Objects work unmodified, including `nullable`, `example`, and boolean-style `exclusiveMinimum`/`exclusiveMaximum` — the same normalization the OpenAPI loader already applies to spec-generated tests applies here too.

### Controlling concurrency

By default, test requests are sent in parallel, if your API calls other APIs during test, this might result in unintentionally spamming that 3P backend.  To avoid this, set `rps` in `spectest.config.js` or pass `--rps=<number>` on the command line. A rate limiter ensures that no more than the configured number of requests are sent each second.

### Testing multi-step flows

Tests execute in parallel by default. After each **successful** test, its
response is saved under `state.completedCases[operationId].response`.  The
`beforeSend` hook of a later test can read that data to craft the next request.
To ensure strict sequencing, set `rps` to `1` or insert explicit `delay`
values.


```js
// auth.spectest.js

export default [
  {
    name: 'Login',
    operationId: 'login',
    endpoint: '/login',
    request: {
      method: 'POST',
      body: { username: 'admin', password: 'secret' }
    },
    response: { status: 200 }
  },
  {
    name: 'Fetch profile',
    dependsOn: ['login'],
    endpoint: '/profile',
    beforeSend: (req, state) => {
      const token = state.completedCases.login.response.data.token;
      req.headers = { ...req.headers, Authorization: `Bearer ${token}` };
    },
    response: { status: 200 }
  }
];
```

### Using proxies

The CLI uses the native fetch API which has proxy support from Node 24+. See https://nodejs.org/api/http.html#built-in-proxy-support for more information on how to set it up.

### Recording outbound HTTP calls

Spectest can record and replay outbound HTTP requests made by a Node-based server under test. Spectest still sends real requests to your local API, but the API process is started with a recording preload so its external `fetch`, `http`, `https`, and common library calls can be captured.

```js
// spectest.config.js

export default {
  baseUrl: 'http://localhost:3000',
  startCmd: 'npm run start',
  runningServer: 'kill',
  recording: 'replay',
  recordingFile: '.spectest/cassette.json',
  missingRecordingBehavior: 'fail',
  recordingExcludeUrls: [
    'https://telemetry.example.com/',
    /^https:\/\/metadata\.google\.internal\//,
    (url) => url.hostname.endsWith('.internal.example.com'),
  ],
};
```

To create or update a cassette:

```bash
npx spectest --recording=record
```

To replay from the cassette:

```bash
npx spectest --recording=replay
```

`missingRecordingBehavior` controls replay misses:

| Value | Behavior |
| ----- | -------- |
| `fail` | Fail the outbound request with a clear unmatched-recording error |
| `record` | Allow the real outbound request and save it to the cassette |
| `bypass` | Allow the real outbound request without saving it |

`recordingExcludeUrls` always bypasses cassette handling. String entries are canonical URL prefix matches, `RegExp` entries are tested against the canonical URL string, and predicate entries receive `(url, request)`.

Per-test `recording` can override only the mode. When it is unset, the test inherits the run-level `recording` mode.

```js
export default [
  {
    name: 'Health check bypasses cassette',
    endpoint: '/health',
    recording: 'off',
  },
];
```

Recording requires Spectest to start the Node server process. If an already-running server is reused, Spectest cannot reliably instrument outbound calls, so `runningServer: 'reuse'` is not compatible with recording.

You can also use the framework-agnostic helper in plain Node tests:

```js
import { useHttpRecordings } from 'spectest/recordings';

let recordings;

beforeAll(async () => {
  recordings = await useHttpRecordings({
    file: '.spectest/cassette.json',
    mode: 'replay',
    missingRecordingBehavior: 'fail',
    recordingExcludeUrls: ['https://telemetry.example.com/'],
  });
});

afterAll(async () => {
  await recordings.dispose();
});
```

### Throttling outbound backend calls

`rps` limits how fast *Spectest* sends requests to your SUT — it has no visibility into what the
SUT does internally. If an endpoint under test fans out to a rate-limited third party (e.g. a
domain-registration endpoint that makes several calls to a registrar API per request), running
tests concurrently can still burst well past that backend's own limit even with `rps` set.

`outboundThrottle` caps outbound requests the Node SUT process itself makes to a matching backend.
It works the same way as HTTP recording: the SUT process is started with a preload that
transparently intercepts its outbound `fetch`/`http`/`https`/XHR calls, so no application code
changes are needed. Matching requests are delayed until a token is available and then sent for
real — nothing is mocked or short-circuited.

```js
// spectest.config.js

export default {
  baseUrl: 'http://localhost:3000',
  startCmd: 'npm run start',
  runningServer: 'kill',
  outboundThrottle: [
    { match: 'api.openprovider.eu', rps: 5, name: 'openprovider' },
    { match: /^https:\/\/api\.example\.com\/v1\//, rps: 20 },
  ],
};
```

Each rule's `match` is tested against the full outbound request URL: a string is a substring test,
a `RegExp` is tested directly. The first matching rule applies; requests that don't match any rule
pass through unthrottled. Like recording, this requires Spectest to start the Node server process,
so `runningServer: 'reuse'` is not compatible with `outboundThrottle`.

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

Use the `timeout` option to limit how long each test case may run. Specify `timeout` in `spectest.config.js` or pass `--timeout=<milliseconds>` on the command line. The default is `60000` (30 seconds). Individual tests can override this by including a `timeout` property. When a request exceeds the effective timeout, the test fails with a `⏰` indicator in the summary.

### Check for robustness of API

* **Randomize tests**: Run tests with `--randomize` to uncover unexpected test order dependencies. This is especially useful for serverless functions that should be stateless.
* **Explicit dependencies**: Use the `dependsOn` array on a test case to run it only after the listed operations succeed. Independent tests run concurrently as their prerequisites complete.

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

Helpers are also available for recording mode overrides:

```js
import { recording } from 'spectest/helpers';

export default recording(suite, 'off');
```

And you can create your own helpers to reduce repetition of common request/response properties!

### Test formats

Test cases can be written in `.js`, plain `.json` and `.yaml` files, or `.mjs` for ESM and `.cjs` for CommonJs modules.

Typescript (`.ts`) files are not yet supported, you'd need to transpile them to any of the supported Js modules above.
