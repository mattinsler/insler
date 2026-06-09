import { defineConfig, type UserConfig } from 'tsdown';

// Shared build config for every workspace package under packages/*.
// Individual packages may add their own tsdown.config.ts to override a
// single field (e.g. `entry`); those configs are merged on top of this one.
const config: UserConfig = defineConfig({
  workspace: 'packages/*',
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // Generate each package's `exports` from the build outputs. The string form
  // adds an `@insler/source` condition pointing at TS source (for in-repo dev),
  // while `import`/`require` resolve to the built dist for published consumers.
  exports: { devExports: '@insler/source' },
  publint: true,
  // `node16` profile ignores legacy node10 resolution, which can't read
  // `exports` subpaths (e.g. `@insler/rpc-client/test`) at all — irrelevant for
  // packages that require Node >=18.
  attw: { profile: 'node16' },
});

export default config;
