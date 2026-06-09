import { defineConfig, type UserConfig } from 'tsdown';

// Inherits format/dts/exports/publint/attw from the root tsdown.config.ts;
// only the extra entry points are package-specific.
const config: UserConfig = defineConfig({
  entry: ['./src/index.ts', './src/test.ts', './src/dev.ts'],
});

export default config;
