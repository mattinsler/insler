import { describe, expect, test } from 'bun:test';
import { basename, join } from 'node:path';

import { discoverWorkspacePackages } from './workspace-packages.ts';

// Repo-level layout invariants for the ADR-0003 migration: a package's
// directory is its unscoped npm name, its repository-directory metadata
// matches its actual location, and the name-keeping packages live under
// their subsystem directory (subsystem-layout issue 0002).

const repoRoot = new URL('..', import.meta.url).pathname;
const packageDirs = discoverWorkspacePackages(repoRoot);

// ADR-0003 mapping table (verbatim): every package lives at
// packages/<subsystem>/<unscoped-name>, with each umbrella core at the
// directory matching its subsystem name.
const SUBSYSTEM_OF: Record<string, string> = {
  '@insler/cli': 'platform',
  '@insler/di': 'di',
  '@insler/platform': 'platform',
  '@insler/rpc': 'rpc',
  '@insler/rpc-otel': 'rpc',
  '@insler/rpc-transport-nats': 'rpc',
  '@insler/serde': 'serde',
  '@insler/serde-avro': 'serde',
  '@insler/serde-cbor': 'serde',
  '@insler/serde-json': 'serde',
  '@insler/serde-msgpack': 'serde',
  '@insler/service': 'service',
};

// Fine-grained packages retired by the umbrella merges (issues 0003/0004);
// they must no longer exist anywhere in the workspace.
const RETIRED = [
  '@insler/fleet',
  '@insler/generator',
  '@insler/reconciler',
  '@insler/rpc-client',
  '@insler/rpc-context',
  '@insler/rpc-contract',
  '@insler/rpc-host',
  '@insler/rpc-transport-memory',
];

async function manifest(dir: string): Promise<Record<string, any>> {
  return Bun.file(join(repoRoot, dir, 'package.json')).json();
}

describe('package layout', () => {
  test('every package directory equals its unscoped npm name', async () => {
    for (const dir of packageDirs) {
      const pkg = await manifest(dir);
      const unscoped = (pkg.name as string).replace(/^@insler\//, '');
      expect(basename(dir)).toBe(unscoped);
    }
  });

  test('every package declares repository-directory metadata matching its location', async () => {
    for (const dir of packageDirs) {
      const pkg = await manifest(dir);
      expect(pkg.repository?.directory).toBe(dir);
    }
  });

  test('the name-keeping packages live under their ADR-0003 subsystem directory', async () => {
    const dirByName = new Map<string, string>();
    for (const dir of packageDirs) {
      dirByName.set((await manifest(dir)).name as string, dir);
    }
    for (const [name, subsystem] of Object.entries(SUBSYSTEM_OF)) {
      const unscoped = name.replace(/^@insler\//, '');
      expect(dirByName.get(name)).toBe(`packages/${subsystem}/${unscoped}`);
    }
  });

  test('the retired fine-grained packages are gone from the workspace', async () => {
    const names = await Promise.all(packageDirs.map(async (dir) => (await manifest(dir)).name));
    for (const retired of RETIRED) {
      expect(names).not.toContain(retired);
    }
  });
});
