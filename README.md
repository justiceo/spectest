# Fest 
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

The source code lives in `src/` and is bundled with [esbuild](https://esbuild.github.io/) into the `dist/` directory. The helpers can be imported separately via `fest/helpers` without pulling in the CLI itself.

### Controlling request rate

To avoid overwhelming your server during test runs, Fest supports a **requests per second (rps)** option. Set `rps` in `fest.config.js` or pass `--rps=<number>` on the command line. A simple token bucket limiter ensures that no more than the configured number of requests are sent each second.

### Test timeout

Use the `timeout` option to limit how long each test case may run. Specify `timeout` in `fest.config.js` or pass `--timeout=<milliseconds>` on the command line. The default is `30000` (30 seconds). Individual tests can override this by including a `timeout` property. When a request exceeds the effective timeout, the test fails with a `⏰` indicator in the summary.

### Randomizing test order

Use the `--randomize` flag or set `randomize: true` in `fest.config.js` to shuffle tests that share the same `order` value. This helps catch hidden dependencies without changing the overall order of distinct groups.

### Bailing on first failure

Pass the `--bail` flag or set `bail: true` in `fest.config.js` to stop executing
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

Use the `--happy` flag or set `happy: true` in `fest.config.js` to run only
tests whose expected `response.status` falls between 200 and 299. If a test
omits `response.status` it is treated as `200` for this check.

### Setting the User-Agent

All requests use a browser-like **User-Agent** header. Specify a custom agent
using `--user-agent=<name>` (or `--ua=<name>`) or set `userAgent` in
`fest.config.js`. The value may be one of the pre-defined names from
`chrome_windows`, `chrome_mac`, `chrome_android`, `chrome_ios`, `edge_windows`,
`safari_mac`, `safari_ios`, `firefox_windows`, `firefox_mac`, or
`opera_windows`. Any other value is used literally.


