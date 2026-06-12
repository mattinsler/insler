import { describe, expect, test } from 'bun:test';

// Repo-level tests for the final ADR-0003 workspace globs: every config that
// enumerates packages resolves the nested subsystem layout
// (`packages/<subsystem>/<pkg>`) — including a future subsystem directory
// with no config change — and the transition-era flat depth is gone.

const rootPkg = await Bun.file(new URL('../package.json', import.meta.url)).json();

const NESTED_PKG = 'packages/serde/serde-json';
const FUTURE_SUBSYSTEM_PKG = 'packages/workflow/workflow';
const RETIRED_FLAT_PKG = 'packages/di';

function matchesAny(globs: string[], path: string): boolean {
  return globs.some((g) => new Bun.Glob(g).match(path));
}

describe('workspace declaration', () => {
  const globs: string[] = rootPkg.workspaces.packages;

  test('resolves packages at the nested subsystem depth', () => {
    expect(matchesAny(globs, NESTED_PKG)).toBe(true);
  });

  test('a future subsystem directory is picked up with no config change', () => {
    expect(matchesAny(globs, FUTURE_SUBSYSTEM_PKG)).toBe(true);
  });

  test('no flat-layout glob remains', () => {
    expect(matchesAny(globs, RETIRED_FLAT_PKG)).toBe(false);
  });

  test('keeps the examples workspace entry unchanged', () => {
    expect(globs).toContain('examples/*');
  });
});

describe('coverage-merge glob', () => {
  // The script is `lcov-result-merger '<glob>' <out> --ignore=...`; the first
  // quoted argument is the lcov source pattern.
  const script: string = rootPkg.scripts['coverage-merge'];
  const match = script.match(/'([^']*lcov\.info)'/);
  const glob = match?.[1];

  test('declares an lcov source pattern', () => {
    expect(glob).toBeDefined();
  });

  test('picks up lcov output from the nested subsystem depth only', () => {
    expect(new Bun.Glob(glob!).match(`${NESTED_PKG}/coverage/lcov.info`)).toBe(true);
    expect(new Bun.Glob(glob!).match(`${FUTURE_SUBSYSTEM_PKG}/coverage/lcov.info`)).toBe(true);
    expect(new Bun.Glob(glob!).match(`${RETIRED_FLAT_PKG}/coverage/lcov.info`)).toBe(false);
  });

  test('keeps ignoring node_modules', () => {
    expect(script).toContain("--ignore='**/node_modules/**'");
  });
});
