import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';
import { discoverWorkspacePackages } from './workspace-packages.ts';

// Repo-level invariants for the service subsystem's private integration
// package (subsystem-branding issue 0009, replicating the issue 0005 template
// and the di/serde replications): it joins the workspace as a non-publishable
// package (ignored by the publish pipeline, changesets, the tsdown build, and
// the umbrella weight-invariant test), consumes the subsystem exactly as an
// external consumer would (public packages via workspace dependencies only),
// and the package-boundary contract is enforced visibly — an internal
// (non-public) import fails lint. service is an in-process policy layer on
// top of the rpc stack — its public surface takes the transport as a
// parameter and binds no third-party system itself (wire-level NATS behavior
// is the rpc subsystem's concern, covered by rpc-integration) — so like the
// di and serde templates the suite runs entirely in-process against the built
// public surface.

const repoRoot = new URL('..', import.meta.url).pathname;
const INTEGRATION_DIR = 'packages/service/service-integration';
const pkg = await Bun.file(join(repoRoot, INTEGRATION_DIR, 'package.json')).json();

// service's public surface: the single-entrypoint umbrella, with no adapter
// packages — derived from the subsystem directory so the allowlist cannot
// drift from what is published. A consumer of @insler/service necessarily
// also consumes @insler/rpc (the umbrella's own runtime dependency): the
// contract a service serves and the transport it serves over are authored
// with the rpc core, so it is part of the consumer-grade dependency set.
const surface = await discoverSubsystemSurface(repoRoot, 'service');
const PUBLIC_SERVICE_SURFACE = [surface.umbrellaName, ...surface.adapterPackages];
const ALLOWED_INSLER_DEPS = [...PUBLIC_SERVICE_SURFACE, '@insler/rpc'];

describe('workspace membership', () => {
  test('the integration package is matched by the subsystem glob, not a second explicit entry', async () => {
    const rootPkg = await Bun.file(join(repoRoot, 'package.json')).json();
    const globs: string[] = rootPkg.workspaces.packages;
    expect(globs.some((g) => new Bun.Glob(g).match(INTEGRATION_DIR))).toBe(true);
    expect(globs).not.toContain(INTEGRATION_DIR);
  });

  test('directory equals unscoped npm name (ADR-0003), under the service subsystem directory', () => {
    expect(pkg.name).toBe('@insler/service-integration');
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

  test('declares no `test` script — repo-wide `bun run test` stays buildless', () => {
    // The suite imports the published surface (dist), so it needs `bun run
    // build` first; it runs via the path-filtered integration workflow only.
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.scripts['test:integration']).toBe('bun test');
  });
});

describe('consumer-grade dependencies', () => {
  test('every @insler dependency is a public consumer-facing package via workspace:*', () => {
    const internal = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
      ([name]) => name.startsWith('@insler/')
    );
    expect(internal.length).toBeGreaterThan(0);
    for (const [name, range] of internal) {
      expect(ALLOWED_INSLER_DEPS).toContain(name);
      expect(range).toBe('workspace:*');
    }
  });

  test('depends on the umbrella and the rpc core it tops (the consumer-grade seam under test)', () => {
    expect(pkg.dependencies['@insler/service']).toBe('workspace:*');
    // Contracts and transports come from the rpc core, exactly as a real
    // consumer authors them.
    expect(pkg.dependencies['@insler/rpc']).toBe('workspace:*');
  });

  test('needs no real infrastructure: no infra dependencies, no server harness', async () => {
    // Real infrastructure only where the subsystem actually needs it
    // (subsystem-branding PRD): service's public surface is env-aware
    // in-process plumbing plus a statically-analyzable declaration model —
    // the transport is an injected parameter, so the suite exercises it over
    // @insler/rpc's in-memory transport. No infra client deps (the NATS
    // adapter package is rpc-integration's seam, not this one's), no
    // process-spawning test harness like the rpc suite's nats-server helper.
    const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const name of allDeps) {
      expect(name).not.toMatch(/nats|redis|postgres|kafka/i);
    }
    const glob = new Bun.Glob('src/**/*.ts');
    for await (const file of glob.scan(join(repoRoot, INTEGRATION_DIR))) {
      const text = await Bun.file(join(repoRoot, INTEGRATION_DIR, file)).text();
      expect(text).not.toContain('Bun.spawn');
    }
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
    await Bun.write(fixture, "import '../../service/src/index.js';\n");
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
