import { build } from 'esbuild';

const external = [
  'axios',
  'dotenv',
  'picocolors',
  'commander',
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
    entryPoints: ['src/spectest-helpers.ts'],
    outfile: 'dist/spectest-helpers.js',
  }),
  build({
    ...common,
    entryPoints: ['src/generate-openapi.ts'],
    outfile: 'dist/generate-openapi.js',
  }),
]);
