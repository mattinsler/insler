import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverWorkspacePackages } from './workspace-packages.ts';

// ADR-0003's umbrella weight invariant, automated (subsystem-layout issue
// 0005). Each subsystem core's runtime dependency set must equal this
// explicit allowlist — utility deps are tolerated by decision, third-party
// integrations are not (they become adapter packages instead). Adding a
// dependency to a core means consciously editing this allowlist in the same
// change; that edit is the review moment the ADR calls for.

const ALLOWED_RUNTIME_DEPS: Record<string, string[]> = {
  '@insler/di': ['debug', 'object-hash'],
  '@insler/platform': ['@insler/rpc', '@insler/service'],
  '@insler/rpc': ['@insler/serde', 'zod'],
  '@insler/serde': [],
  '@insler/service': ['@insler/rpc', 'std-env'],
};

const repoRoot = new URL('..', import.meta.url).pathname;

describe('umbrella weight invariant', () => {
  test('every subsystem core is covered by the allowlist', async () => {
    const coreNames = new Set<string>();
    for (const dir of discoverWorkspacePackages(repoRoot)) {
      const pkg = await Bun.file(join(repoRoot, dir, 'package.json')).json();
      const [, subsystem, unscoped] = dir.split('/');
      if (subsystem === unscoped) coreNames.add(pkg.name);
    }
    expect([...coreNames].sort()).toEqual(Object.keys(ALLOWED_RUNTIME_DEPS).sort());
  });

  test.each(Object.entries(ALLOWED_RUNTIME_DEPS))(
    '%s runtime dependencies equal the allowlist',
    async (name, allowed) => {
      const unscoped = name.replace(/^@insler\//, '');
      const manifestPath = join(repoRoot, 'packages', unscoped, unscoped, 'package.json');
      const pkg = await Bun.file(manifestPath).json();
      expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...allowed].sort());
    }
  );
});
