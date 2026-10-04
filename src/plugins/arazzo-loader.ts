import path from 'path';
import type { Plugin } from '../plugin-api.js';
import type { SpectestConfig } from '../types.js';
import { compileArazzo } from '../arazzo/compile.js';
import type { DocumentCache } from '../arazzo/document.js';

export const DEFAULT_ARAZZO_FILE_PATTERN = '\\.arazzo\\.(ya?ml|json)$';

/**
 * Loads Arazzo documents (explicit `--arazzo` paths and `*.arazzo.{yaml,yml,json}`
 * files discovered under testDir) and compiles each workflow into a chain of
 * test cases. Source descriptions shared by several documents are fetched once.
 */
export const arazzoLoaderPlugin = (cfg: SpectestConfig): Plugin => ({
  name: 'arazzo-loader',
  setup(ctx) {
    const cache: DocumentCache = new Map();
    ctx.onLoad({ filter: new RegExp(DEFAULT_ARAZZO_FILE_PATTERN, 'i'), source: 'arazzo' }, async ({ path: file }) => {
      const compiled = await compileArazzo(file, cfg, cache);
      const relative = path.relative(cfg.projectRoot || process.cwd(), file);
      const label = relative && !relative.startsWith('..') ? relative : file;
      for (const warning of compiled.program.warnings) {
        console.warn(`[spectest] arazzo ${label}: ${warning}`);
      }
      return { suites: [compiled.suite] };
    });
  },
});
