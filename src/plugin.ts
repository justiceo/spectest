import type { Renderer } from './renderer';
import type { Suite, TestCase } from './types';

export interface SpectestPlugin {
  name: string;
  setup: (build: PluginBuild) => void;
}

export interface PluginBuild {
  onLoad: (
    filter: RegExp,
    callback: (path: string) => Promise<Suite | TestCase[]>
  ) => void;

  onRender: (
    callback: (results: any, renderer: Renderer) => Promise<void> | void
  ) => void;
}
