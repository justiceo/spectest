# Fest - Fast Declarative API Testing

This project is a small Node.js CLI written in TypeScript for running end-to-end API tests.

## Development

Install dependencies and run the CLI tests:

```bash
npm install
npm test
```

The source code lives in `src/` and is bundled with [esbuild](https://esbuild.github.io/) into the `dist/` directory. The helpers can be imported separately via `fest/helpers` without pulling in the CLI itself.
