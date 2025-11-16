import type { SpectestPlugin, PluginBuild } from './plugin';
import type { Renderer } from './renderer';
import type { Suite, TestCase } from './types';

type OnLoadCallback = {
  filter: RegExp;
  callback: (path: string) => Promise<Suite | TestCase[]>;
};

type OnRenderCallback = (
  results: any,
  renderer: Renderer
) => Promise<void> | void;

export class PluginManager {
  private onLoadCallbacks: OnLoadCallback[] = [];
  private onRenderCallbacks: OnRenderCallback[] = [];

  constructor(private renderer: Renderer) {}

  loadPlugins(plugins: SpectestPlugin[]) {
    const build: PluginBuild = {
      onLoad: (filter, callback) => {
        this.onLoadCallbacks.push({ filter, callback });
      },
      onRender: (callback) => {
        this.onRenderCallbacks.push(callback);
      },
    };

    for (const plugin of plugins) {
      plugin.setup(build);
    }
  }

  async runOnLoadCallbacks(path: string): Promise<Suite | TestCase[] | null> {
    for (const { filter, callback } of this.onLoadCallbacks) {
      if (filter.test(path)) {
        return await callback(path);
      }
    }
    return null;
  }

  async runOnRenderCallbacks(results: any) {
    for (const callback of this.onRenderCallbacks) {
      await callback(results, this.renderer);
    }
  }
}
