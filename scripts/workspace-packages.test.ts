import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverBuildableWorkspacePackages,
  discoverWorkspacePackages,
} from './workspace-packages.ts';

// Fixture test for the shared build config's package discovery
// (tsdown.config.ts → scripts/workspace-packages.ts). tsdown's own workspace
// globs do not filter by package.json presence, so the build config discovers
// package directories itself: every directory carrying a package.json at the
// nested subsystem depth (`packages/<subsystem>/<pkg>`) — any subsystem
// directory, including future ones — and nothing else.

let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'workspace-packages-'));
  await mkdir(join(fixture, 'packages/flat-pkg/src'), { recursive: true });
  await writeFile(join(fixture, 'packages/flat-pkg/package.json'), '{"name":"flat-pkg"}');
  await mkdir(join(fixture, 'packages/sub/nested-pkg'), { recursive: true });
  await writeFile(join(fixture, 'packages/sub/nested-pkg/package.json'), '{"name":"nested-pkg"}');
  // private (website/integration-style) packages join the workspace but are
  // never tsdown-built or published:
  await mkdir(join(fixture, 'packages/sub/private-pkg'), { recursive: true });
  await writeFile(
    join(fixture, 'packages/sub/private-pkg/package.json'),
    '{"name":"private-pkg","private":true}'
  );
  // junk that must never be discovered:
  await mkdir(join(fixture, 'packages/flat-pkg/node_modules/dep'), { recursive: true });
  await writeFile(
    join(fixture, 'packages/flat-pkg/node_modules/dep/package.json'),
    '{"name":"dep"}'
  );
  await mkdir(join(fixture, 'packages/flat-pkg/coverage'), { recursive: true });
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('discoverWorkspacePackages', () => {
  test('discovers nested packages from any subsystem dir, nothing else', () => {
    expect(discoverWorkspacePackages(fixture).sort()).toEqual([
      'packages/sub/nested-pkg',
      'packages/sub/private-pkg',
    ]);
  });

  test('discovers every existing package of this repo', () => {
    const repoRoot = new URL('..', import.meta.url).pathname;
    const dirs = discoverWorkspacePackages(repoRoot);
    expect(dirs).toContain('packages/di/di');
    expect(dirs).toContain('packages/platform/platform');
    for (const dir of dirs) {
      expect(Bun.file(join(repoRoot, dir, 'package.json')).size).toBeGreaterThan(0);
    }
  });

  test('is what the shared build config builds from', async () => {
    const config = await Bun.file(new URL('../tsdown.config.ts', import.meta.url)).text();
    expect(config).toContain('./scripts/workspace-packages.ts');
  });
});

describe('discoverBuildableWorkspacePackages', () => {
  test('excludes private packages (website/integration packages are never tsdown-built)', () => {
    expect(discoverBuildableWorkspacePackages(fixture).sort()).toEqual(['packages/sub/nested-pkg']);
  });

  test('is the variant the shared build config uses', async () => {
    const config = await Bun.file(new URL('../tsdown.config.ts', import.meta.url)).text();
    expect(config).toContain('discoverBuildableWorkspacePackages');
  });
});
