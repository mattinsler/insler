import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { defineConfig, type UserConfig } from 'tsdown';

const ENTRYPOINTS = [
  './src/index.ts',
  './src/contract/index.ts',
  './src/context/index.ts',
  './src/client/index.ts',
  './src/client/test.ts',
  './src/client/dev.ts',
  './src/host/index.ts',
  './src/host/test.ts',
  './src/host/dev.ts',
  './src/transport-memory/index.ts',
];

// Inherits format/dts/exports/publint/attw from the root tsdown.config.ts.
// Each umbrella entrypoint is a separately compiled file (importing one
// loads no code from the others); the nested dev/test entries preserve the
// merged packages' secondary entrypoints under their layer.
//
// `unbundle` keeps every source module a distinct dist module instead of
// letting the bundler split shared code into chunks — per-module output is
// what guarantees one runtime copy of shared classes across entrypoints
// (instanceof identity) by construction.
//
// `treeshake: false` works around a rolldown bug: with two entrypoints
// exporting the same public name (client's and host's composeMiddleware),
// treeshaking intermittently drops the import binding from one entry facade,
// emitting a module that fails to parse. Unbundled output mirrors source
// modules 1:1, so treeshaking buys nothing here anyway.
//
// `onSuccess` loads every built entrypoint under both module systems and
// asserts cross-entrypoint identity — publint and attw both miss that
// broken-facade failure mode, so this fails the build instead of the first
// consumer.
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
    const client = esm['./src/client/index.ts']!;
    const contract = esm['./src/contract/index.ts']!;
    const host = esm['./src/host/index.ts']!;
    if (!Object.is(root['ContractError'], client['ContractError'])) {
      throw new Error('@insler/rpc dist: ContractError identity broken across entrypoints');
    }
    if (!Object.is(root['Contract'], contract['Contract'])) {
      throw new Error('@insler/rpc dist: Contract identity broken across entrypoints');
    }
    if (typeof client['composeMiddleware'] !== 'function') {
      throw new Error('@insler/rpc dist: client entrypoint lost its composeMiddleware export');
    }
    if (typeof host['composeMiddleware'] !== 'function') {
      throw new Error('@insler/rpc dist: host entrypoint lost its composeMiddleware export');
    }
  },
});

export default config;
