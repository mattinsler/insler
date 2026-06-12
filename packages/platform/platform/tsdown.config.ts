import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { defineConfig, type UserConfig } from 'tsdown';

const ENTRYPOINTS = [
  './src/index.ts',
  './src/fleet/index.ts',
  './src/generator/index.ts',
  './src/reconciler/index.ts',
];

// Inherits format/dts/exports/publint/attw from the root tsdown.config.ts.
// Each umbrella entrypoint is a separately compiled file (importing one
// loads no code from the others).
//
// `unbundle` + `treeshake: false` + the `onSuccess` smoke check mirror the
// @insler/rpc umbrella (see packages/rpc/rpc/tsdown.config.ts): per-module
// output guarantees one runtime copy of shared code across entrypoints, and
// loading every built entrypoint under both module systems catches the
// rolldown facade emission bug that publint and attw both miss.
const config: UserConfig = defineConfig({
  unbundle: true,
  treeshake: false,
  entry: ENTRYPOINTS,
  onSuccess: async (resolved) => {
    const dist = (entry: string, ext: string): string =>
      entry.replace('./src/', `${resolved.cwd}/dist/`).replace(/\.ts$/, ext);

    const require = createRequire(import.meta.url);
    const esm: Record<string, Record<string, unknown>> = {};
    for (const entry of ENTRYPOINTS) {
      esm[entry] = await import(pathToFileURL(dist(entry, '.mjs')).href);
      require(dist(entry, '.cjs'));
    }

    const root = esm['./src/index.ts']!;
    const fleet = esm['./src/fleet/index.ts']!;
    if (!Object.is(root['buildFleetManifest'], fleet['buildFleetManifest'])) {
      throw new Error(
        '@insler/platform dist: buildFleetManifest identity broken across entrypoints'
      );
    }
  },
});

export default config;
