import { defineConfig, type UserConfig } from 'tsdown';

// Inherits format/dts/exports/publint/attw from the root tsdown.config.ts;
// only the extra `insler` entry point (the bin) is package-specific. The entry
// is named `insler.ts` so the auto-generated `bin` is the `insler` command.
const config: UserConfig = defineConfig({
  entry: ['./src/index.ts', './src/insler.ts'],
  // The package is `@insler/cli`, but the binary it ships is `insler`. The
  // object form pins the command name (tsdown otherwise derives it from the
  // package name, which would yield `cli`).
  exports: { devExports: '@insler/source', bin: { insler: './src/insler.ts' } },
});

export default config;
