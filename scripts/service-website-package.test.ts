import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';
import { discoverWorkspacePackages } from './workspace-packages.ts';

// Repo-level invariants for the service subsystem docs site
// (subsystem-branding issue 0009, replicating the issue 0004 template and the
// di/serde replications): a private website package under the service
// subsystem directory builds an independent Astro/Starlight site at
// service.insler.dev, consuming the shared family identity from @insler/theme
// (nav path back to the family homepage), with Starlight's built-in full-text
// search enabled and a content scaffold seeded from the agent library guides
// — a landing page opening with the 0-to-value story, a getting-started
// guide, and one reference page per umbrella entrypoint and per adapter
// package. The invariants derive from the umbrella manifest and the shared
// family data, exactly as the rpc template's do.

const repoRoot = new URL('..', import.meta.url).pathname;
const SITE_DIR = 'packages/service/service-website';
const siteRoot = join(repoRoot, SITE_DIR);
const pkg = await Bun.file(join(siteRoot, 'package.json')).json();
const astroConfigFile = Bun.file(join(siteRoot, 'astro.config.ts'));
const astroConfig = (await astroConfigFile.exists()) ? await astroConfigFile.text() : '';

// The umbrella entrypoints and adapter packages, derived from the umbrella
// manifest and the subsystem directory so the site's reference coverage
// cannot silently drift from the published surface (the shared
// subsystem-surface derivation).
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(
  repoRoot,
  'service'
);

describe('workspace membership', () => {
  test('the site is matched by the subsystem glob, not a second explicit entry', async () => {
    const rootPkg = await Bun.file(join(repoRoot, 'package.json')).json();
    const globs: string[] = rootPkg.workspaces.packages;
    expect(globs.some((g) => new Bun.Glob(g).match(SITE_DIR))).toBe(true);
    expect(globs).not.toContain(SITE_DIR);
  });

  test('directory equals unscoped npm name (ADR-0003), under the service subsystem directory', () => {
    expect(pkg.name).toBe('@insler/service-website');
    expect(discoverWorkspacePackages(repoRoot)).toContain(SITE_DIR);
  });
});

describe('release-flow exclusion', () => {
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
    const [, subsystem, unscoped] = SITE_DIR.split('/');
    expect(subsystem).not.toBe(unscoped);
  });

  test('declares no `test` script — the build is the test, run by the path-filtered workflow', () => {
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.scripts.build).toBe('astro build');
  });
});

describe('typescript config (examples precedent)', () => {
  test('typechecks with astro check via its own script', () => {
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  test('the root tsc program excludes website packages at the subsystem depth', async () => {
    const tsconfig = await Bun.file(join(repoRoot, 'tsconfig.json')).text();
    const excludeBlock = tsconfig.match(/"exclude":\s*\[([^\]]*)\]/)?.[1] ?? '';
    const excludes = [...excludeBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(excludes.some((g) => new Bun.Glob(g).match(SITE_DIR))).toBe(true);
  });

  test('its own tsconfig relaxes the declaration-oriented strictness', async () => {
    // JSONC (the tsconfig carries comments), so assert on the text.
    const tsconfig = await Bun.file(join(siteRoot, 'tsconfig.json')).text();
    expect(tsconfig).toMatch(/"isolatedDeclarations":\s*false/);
    expect(tsconfig).toMatch(/"declaration":\s*false/);
    expect(tsconfig).toMatch(/"noEmit":\s*true/);
  });
});

describe('shared family identity', () => {
  test('consumes the shared theme package', () => {
    expect(pkg.dependencies['@insler/theme']).toBe('workspace:*');
  });

  test('applies the family identity from the theme, not a local copy', () => {
    expect(astroConfig).toContain("from '@insler/theme'");
    expect(astroConfig).toContain('familyStarlightConfig');
  });

  test('site identity (URL, title, tagline) derives from the shared family data', () => {
    // Data-driven, exactly like the rpc template — the site never hardcodes
    // its own URL or pitch.
    expect(astroConfig).toContain('family.subsystems');
    expect(astroConfig).toContain("'service'");
    expect(astroConfig).not.toContain('https://service.insler.dev');
  });

  test('defines no brand tokens of its own (a brand change is one theme edit)', async () => {
    const glob = new Bun.Glob('src/**/*.{css,astro,mdx,md,ts}');
    for await (const file of glob.scan(siteRoot)) {
      const text = await Bun.file(join(siteRoot, file)).text();
      expect(text).not.toMatch(/--(?:sl|if)-[\w-]+\s*:/);
    }
  });
});

describe('full-text search', () => {
  test("Starlight's built-in Pagefind search stays enabled (the apex disables it; subsystem sites must not)", () => {
    expect(astroConfig).not.toMatch(/pagefind:\s*false/);
  });
});

describe('content scaffold', () => {
  const docsDir = join(siteRoot, 'src/content/docs');

  test('the landing page opens with the 0-to-value story', async () => {
    const landing = await Bun.file(join(docsDir, 'index.mdx')).text();
    // One install, both roles working: a contract served env-aware and the
    // typed deployment-intent declaration.
    expect(landing).toMatch(/bun add @insler\/service\s*$/m);
    for (const symbol of ['Service.create(', 'defineService(']) {
      expect(landing).toContain(symbol);
    }
  });

  test('a getting-started guide exists, serves a contract env-aware, and declares deployment intent', async () => {
    const guide = await Bun.file(join(docsDir, 'getting-started.md')).text();
    for (const symbol of [
      'Contract.create(',
      'createMemoryTransport',
      'Service.create(',
      'defineService(',
      'deriveIdentity(',
      "kind: '",
    ]) {
      expect(guide).toContain(symbol);
    }
  });

  test('the landing page routes into the getting-started guide', async () => {
    const landing = await Bun.file(join(docsDir, 'index.mdx')).text();
    expect(landing).toContain('/getting-started/');
  });

  test('exactly one reference page per umbrella entrypoint and per adapter package', async () => {
    const titles: string[] = [];
    for (const entry of readdirSync(join(docsDir, 'reference'))) {
      const text = await Bun.file(join(docsDir, 'reference', entry)).text();
      const title = text.match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1];
      expect(title).toBeDefined();
      titles.push(title as string);
    }
    expect(titles.sort()).toEqual([...umbrellaEntrypoints, ...adapterPackages].sort());
  });

  test('the derived surface matches what service is: a single-entrypoint core with no adapters', () => {
    expect(umbrellaEntrypoints).toEqual(['@insler/service']);
    expect(adapterPackages).toEqual([]);
  });

  test('every reference page carries a description and a non-empty body (seeded, not a stub)', async () => {
    for (const entry of readdirSync(join(docsDir, 'reference'))) {
      const text = await Bun.file(join(docsDir, 'reference', entry)).text();
      expect(text).toMatch(/^description:\s*\S/m);
      const body = text.split(/^---\s*$/m)[2] ?? '';
      expect(body.trim().length).toBeGreaterThan(100);
    }
  });
});
