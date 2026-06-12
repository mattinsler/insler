import { describe, expect, test } from 'bun:test';

// Assembly contract of the @insler/platform umbrella (subsystem-layout issue
// 0004): /fleet, /generator, /reconciler entrypoints — each a separately
// compiled file — and a runtime dependency set with no third-party
// integration packages.

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();

const ENTRYPOINTS = ['.', './fleet', './generator', './reconciler'];

describe('@insler/platform exports map', () => {
  test('exposes exactly the layer entrypoints', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([...ENTRYPOINTS, './package.json'].sort());
  });

  test.each(ENTRYPOINTS)('%s resolves source, ESM, and CJS conditions', (entry) => {
    const conditions = pkg.exports[entry];
    expect(conditions['@insler/source']).toMatch(/^\.\/src\/.+\.ts$/);
    expect(conditions.import).toMatch(/^\.\/dist\/.+\.mjs$/);
    expect(conditions.require).toMatch(/^\.\/dist\/.+\.cjs$/);
  });

  test('entrypoints are separately compiled files (no two share an output)', () => {
    const targets = ENTRYPOINTS.map((entry) => pkg.exports[entry].import);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('@insler/platform dependency weight', () => {
  test('runtime dependencies are exactly the in-repo cores (no third-party integrations)', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@insler/rpc', '@insler/service']);
  });
});
