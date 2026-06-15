import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';

// Repo-level invariants for the platform subsystem README front door
// (subsystem-branding issue 0010, replicating the issue 0003 template via the
// service replication): a README at the subsystem directory
// (packages/platform/) states the subsystem's purpose in consumer terms,
// shows the 0-to-value install and a minimal example using only the surface a
// consumer can reach, maps the umbrella's consumer-facing surface (and the
// sibling CLI package) with a one-line purpose, and links the docs site at
// platform.insler.dev. The README's H1 + first paragraph also remain the
// section title + blurb mirror-scripts/gen-public-readme.ts consumes for the
// public repo README.

const repoRoot = new URL('..', import.meta.url).pathname;
const subsystemDir = join(repoRoot, 'packages/platform');
const readmeFile = Bun.file(join(subsystemDir, 'README.md'));
const readme = (await readmeFile.exists()) ? await readmeFile.text() : '';

// Everything before the first section heading: the orientation block a
// reader sees first.
const intro = readme.split(/^## /m)[0] ?? '';

// The umbrella entrypoints and the sibling published packages, derived from
// the umbrella manifest and the subsystem directory so the README's map
// cannot silently drift from the published surface.
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(
  repoRoot,
  'platform'
);

// A markdown table row mapping `name`, split into its non-empty cells. The
// backticks make the match exact: a row for `@insler/platform/fleet` does not
// satisfy `@insler/platform`.
function mapRowCells(name: string): string[] | undefined {
  const row = readme
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
  return row
    ?.split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

const tsBlocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
const importSpecifiers = tsBlocks.flatMap((block) =>
  [...block.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '')
);

describe('front door', () => {
  test('a README exists at the platform subsystem directory', async () => {
    expect(await readmeFile.exists()).toBe(true);
  });

  test('it opens by stating the subsystem purpose in consumer terms', () => {
    expect(readme).toMatch(/^# /);
    // The orientation block names what the subsystem is -- the maintainer's
    // hero wording: defineService declarations compiled into running
    // infrastructure by the insler CLI, via generation and plan/diff
    // reconciliation. Domain vocabulary first, never repo-internal layout
    // talk.
    expect(intro).toMatch(/defineService/);
    expect(intro).toMatch(/infrastructure/i);
    expect(intro).toMatch(/generat/i);
    expect(intro).toMatch(/reconcil/i);
    expect(intro).toMatch(/\bCLI\b/);
  });

  test('the H1 + first paragraph satisfy the public-README generator contract', () => {
    // mirror-scripts/gen-public-readme.ts takes the H1 as the section title
    // and the first non-heading paragraph as the section blurb.
    const heading = readme.match(/^#\s+(.+)$/m)?.[1]?.trim();
    expect(heading).toBeTruthy();
    const blurb = readme
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#'));
    expect(blurb).toBeTruthy();
  });
});

describe('0-to-value', () => {
  test('shows the one-package install', () => {
    expect(readme).toMatch(/bun add @insler\/platform\s*$/m);
  });

  test('shows a minimal working example covering the declarations-to-plan pipeline', () => {
    expect(tsBlocks.length).toBeGreaterThan(0);
    expect(importSpecifiers).toContain('@insler/platform/fleet');
    // The 0-to-value story: a defineService declaration scanned into the
    // desired-state model, artifacts generated, the rollout planned.
    const example = tsBlocks.join('\n');
    expect(example).toContain('defineService(');
    expect(example).toContain('scanFleet(');
    expect(example).toContain('createGenerator(');
    expect(example).toContain('createReconciler(');
  });

  test('example code imports only what a consumer can reach', () => {
    // platform sits at the top of the stack: the declarations it compiles
    // are authored with @insler/service (a runtime dependency the install
    // brings along), whose contracts come from @insler/rpc with zod schemas
    // -- all part of the consumer story, never a repo-internal path.
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      const isPublic =
        spec === '@insler/platform' ||
        spec.startsWith('@insler/platform/') ||
        spec === '@insler/cli' ||
        spec === '@insler/service' ||
        spec === '@insler/rpc' ||
        spec.startsWith('@insler/rpc/') ||
        spec === 'zod';
      expect(isPublic).toBe(true);
    }
  });
});

describe('entrypoint and sibling-package map', () => {
  test('the derived surface matches what platform is: a three-layer umbrella plus the CLI', () => {
    // platform is a two-package subsystem (see ADR-0002 / the agent library
    // guide): the umbrella's three layer entrypoints, plus @insler/cli — the
    // sibling published package the surface derivation lists where other
    // subsystems carry adapters. The CLI is not a third-party binding; it is
    // the composition layer at the top of the stack. If either ever changes,
    // this pin is the review moment.
    expect(umbrellaEntrypoints).toEqual([
      '@insler/platform/fleet',
      '@insler/platform/generator',
      '@insler/platform/reconciler',
    ]);
    expect(adapterPackages).toEqual(['@insler/cli']);
  });

  test.each(umbrellaEntrypoints)('maps umbrella entrypoint %s with a purpose', (entrypoint) => {
    const cells = mapRowCells(entrypoint);
    expect(cells).toBeDefined();
    // The row carries a one-line purpose alongside the entrypoint itself.
    const purpose = cells?.filter((cell) => !cell.includes(`\`${entrypoint}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });

  test.each(adapterPackages)('maps sibling published package %s with a purpose', (sibling) => {
    const cells = mapRowCells(sibling);
    expect(cells).toBeDefined();
    const purpose = cells?.filter((cell) => !cell.includes(`\`${sibling}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });

  test('the map states that platform has no adapter packages — its sibling is the CLI', () => {
    expect(readme).toMatch(/no adapter packages/i);
  });
});

describe('docs link', () => {
  test('links platform.insler.dev for full docs', () => {
    expect(readme).toContain('https://platform.insler.dev');
  });

  test('the docs link is part of the orientation block, before any section', () => {
    expect(intro).toContain('https://platform.insler.dev');
  });
});

describe('orientation is self-contained', () => {
  test('install, map, and next-steps sections are all in this one file', () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? '');
    expect(headings.some((h) => /install/i.test(h))).toBe(true);
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });

  test('does not defer orientation to repo-internal agent docs', () => {
    expect(readme).not.toContain('docs/agents');
    expect(readme).not.toMatch(/system[ -]map/i);
  });
});
