# Spectest
[![Build](https://github.com/justiceo/spectest/actions/workflows/build.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/build.yml)
[![Test](https://github.com/justiceo/spectest/actions/workflows/test.yml/badge.svg)](https://github.com/justiceo/spectest/actions/workflows/test.yml)
## A fetch-inpsired declarative API testing frameowork

This is a framework for running end-to-end API tests in a declarative way.

## Development

Install dependencies and run the CLI tests:

```bash
npm install
npm test
```

To generate an OpenAPI schema from the available test suites run:

```bash
npm run generate:openapi > openapi.json
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


The source code lives in `src/` and is bundled with [esbuild](https://esbuild.github.io/) into the `dist/` directory. The helpers can be imported separately via `spectest/helpers` without pulling in the CLI itself.

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


