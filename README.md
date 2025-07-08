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

### Randomizing test order

Use the `--randomize` flag or set `randomize: true` in `fest.config.js` to shuffle tests that share the same `order` value. This helps catch hidden dependencies without changing the overall order of distinct groups.

### Bailing on first failure

Pass the `--bail` flag or set `bail: true` in `fest.config.js` to stop executing
lower-order test groups once a failure is detected. Any remaining tests are
marked as skipped in the summary.
