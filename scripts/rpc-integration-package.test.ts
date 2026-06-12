import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverWorkspacePackages } from './workspace-packages.ts';

// Repo-level invariants for the rpc subsystem's private integration package
// (subsystem-branding issue 0005, ADR-0003 move 3): it joins the workspace as
// a non-publishable package (ignored by the publish pipeline, changesets, the
// tsdown build, and the umbrella weight-invariant test), consumes the
// subsystem exactly as an external consumer would (public packages via
// workspace dependencies only), and the package-boundary contract is
// enforced visibly — an internal (non-public) import fails lint.

const repoRoot = new URL('..', import.meta.url).pathname;
const INTEGRATION_DIR = 'packages/rpc/rpc-integration';
const pkg = await Bun.file(join(repoRoot, INTEGRATION_DIR, 'package.json')).json();

describe('workspace membership', () => {
  test('the integration package is matched by the subsystem glob, not a second explicit entry', async () => {
    const rootPkg = await Bun.file(join(repoRoot, 'package.json')).json();
    const globs: string[] = rootPkg.workspaces.packages;
    expect(globs.some((g) => new Bun.Glob(g).match(INTEGRATION_DIR))).toBe(true);
    expect(globs).not.toContain(INTEGRATION_DIR);
  });

  test('directory equals unscoped npm name (ADR-0003), under the rpc subsystem directory', () => {
    expect(pkg.name).toBe('@insler/rpc-integration');
    expect(discoverWorkspacePackages(repoRoot)).toContain(INTEGRATION_DIR);
  });
});

describe('non-publishable manifest conventions', () => {
  test('private and unversioned (outside changesets + npm publish)', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBeUndefined();
  });

  test('the publish pipeline skips private packages', async () => {
    const ciPublish = await Bun.file(join(repoRoot, 'scripts/ci-publish.sh')).text();
    expect(ciPublish).toContain('"private"');
  });

  test('the shared build config only builds publishable packages', async () => {
    const config = await Bun.file(join(repoRoot, 'tsdown.config.ts')).text();
    expect(config).toContain('discoverBuildableWorkspacePackages');
  });

  test('not at an umbrella-core path, so the weight-invariant test never treats it as a core', () => {
    const [, subsystem, unscoped] = INTEGRATION_DIR.split('/');
    expect(subsystem).not.toBe(unscoped);
  });

  test('declares no `test` script — repo-wide `bun run test` stays buildless and infra-free', () => {
    // The suite imports the published surface (dist) and spawns a real
    // nats-server; it runs via the path-filtered integration workflow only.
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.scripts['test:integration']).toBe('bun test');
  });
});

describe('consumer-grade dependencies', () => {
  test('every @insler dependency is a public consumer-facing package via workspace:*', () => {
    const PUBLIC_RPC_SURFACE = ['@insler/rpc', '@insler/rpc-otel', '@insler/rpc-transport-nats'];
    // The NATS transport's `serde` option is a public configuration point
    // (`Serde<Uint8Array>`); the serde subsystem's published packages are what
    // a consumer plugs into it (issue 0006's serde-adapter interop coverage).
    const PUBLIC_SERDE_SURFACE = [
      '@insler/serde',
      '@insler/serde-avro',
      '@insler/serde-cbor',
      '@insler/serde-json',
      '@insler/serde-msgpack',
    ];
    const allowed = [...PUBLIC_RPC_SURFACE, ...PUBLIC_SERDE_SURFACE];
    const internal = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
      ([name]) => name.startsWith('@insler/')
    );
    expect(internal.length).toBeGreaterThan(0);
    for (const [name, range] of internal) {
      expect(allowed).toContain(name);
      expect(range).toBe('workspace:*');
    }
  });

  test('depends on the umbrella and the NATS adapter (the cross-package seam under test)', () => {
    expect(pkg.dependencies['@insler/rpc']).toBe('workspace:*');
    expect(pkg.dependencies['@insler/rpc-transport-nats']).toBe('workspace:*');
  });
});

describe('typecheck config (examples precedent)', () => {
  test('excluded from the root isolatedDeclarations program', async () => {
    const rootTsconfig = await Bun.file(join(repoRoot, 'tsconfig.json')).text();
    const exclude: string[] = JSON.parse(
      rootTsconfig.replace(/^\s*\/\/.*$/gm, '') // strip JSONC comments
    ).exclude;
    expect(exclude.some((g) => new Bun.Glob(`${g}/**`).match(`${INTEGRATION_DIR}/src/x.ts`))).toBe(
      true
    );
  });

  test('carries its own typecheck script with the declaration strictness relaxed', async () => {
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    const tsconfig = await Bun.file(join(repoRoot, INTEGRATION_DIR, 'tsconfig.json')).text();
    expect(tsconfig).toContain('"isolatedDeclarations": false');
  });
});

describe('package-boundary lint guard', () => {
  test('the lint config restricts parent-relative imports for every */*-integration package', async () => {
    const lintrc = await Bun.file(join(repoRoot, '.oxlintrc.json')).json();
    const override = (lintrc.overrides ?? []).find((o: { files: string[] }) =>
      o.files.some((g: string) => new Bun.Glob(g).match(`${INTEGRATION_DIR}/src/x.ts`))
    );
    expect(override).toBeDefined();
    expect(override.rules['no-restricted-imports']).toBeDefined();
  });

  test('a relative import escaping the package fails lint (executable boundary guard)', async () => {
    // A parent-relative import is the one consumer-impossible import the type
    // system cannot reject (sibling package *sources* resolve fine under the
    // bundler config), so the lint rule owns it. Prove the rule fires by
    // linting a temporary violating file at the real location.
    const fixture = join(repoRoot, INTEGRATION_DIR, 'src/__boundary-violation.fixture.ts');
    await Bun.write(fixture, "import '../../rpc/src/host/index.js';\n");
    try {
      const proc = Bun.spawn(
        ['bun', 'run', 'lint', '--', `${INTEGRATION_DIR}/src/__boundary-violation.fixture.ts`],
        { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        proc.stdout.text(),
        proc.stderr.text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout + stderr).toContain('no-restricted-imports');
    } finally {
      await rm(fixture, { force: true });
    }
  });
});
