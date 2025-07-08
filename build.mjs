import { build } from 'esbuild';

const external = [
  'axios',
  'dotenv',
  'picocolors',
  'zod',
  'fs',
  'path',
  'child_process',
  'crypto',
  'util',
  'stream',
  'events',
  'os',
];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
  build({
    ...common,
    entryPoints: ['src/fest-helpers.ts'],
    outfile: 'dist/fest-helpers.js',
  }),
  build({
    ...common,
    entryPoints: ['src/server-helper.ts'],
    outfile: 'dist/server-helper.js',
  }),
  build({
    ...common,
    entryPoints: ['src/fest.config.ts'],
    outfile: 'dist/fest.config.js',
  }),
]);
