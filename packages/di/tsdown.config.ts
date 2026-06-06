import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  publint: true,
  dts: true,
  format: ['esm', 'cjs'],
});
