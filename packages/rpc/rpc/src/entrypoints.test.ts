import { describe, expect, test } from 'bun:test';

// Assembly contract of the @insler/rpc umbrella (subsystem-layout issue
// 0003): five layer entrypoints plus the nested secondary entrypoints the
// merged packages already had, each a separately compiled file, with the
// runtime dependency set capped at zod + @insler/serde.

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();

const ENTRYPOINTS = [
  '.',
  './client',
  './client/dev',
  './client/test',
  './context',
  './contract',
  './host',
  './host/dev',
  './host/test',
  './transport-memory',
];

describe('@insler/rpc exports map', () => {
  test('exposes exactly the layer entrypoints and their nested secondaries', () => {
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

describe('@insler/rpc dependency weight', () => {
  test('runtime dependencies are exactly zod + @insler/serde', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@insler/serde', 'zod']);
  });
});
