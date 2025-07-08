# Fest 
## A fetch-inpsired declarative API testing frameowork

This is a framework for running end-to-end API tests in a declarative way.

## Development

Install dependencies and run the CLI tests:

```bash
npm install
npm test
```

The source code lives in `src/` and is bundled with [esbuild](https://esbuild.github.io/) into the `dist/` directory. The helpers can be imported separately via `fest/helpers` without pulling in the CLI itself.
