import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';

// Repo-level invariants for the di subsystem README front door
// (subsystem-branding issue 0007, replicating the issue 0003 template): a
// README at the subsystem directory (packages/di/) states the subsystem's
// purpose in consumer terms, shows the 0-to-value install and a minimal
// example using only the public package surface, maps the umbrella's
// consumer-facing surface with a one-line purpose, and links the docs site
// at di.insler.dev.

const repoRoot = new URL('..', import.meta.url).pathname;
const subsystemDir = join(repoRoot, 'packages/di');
const readmeFile = Bun.file(join(subsystemDir, 'README.md'));
const readme = (await readmeFile.exists()) ? await readmeFile.text() : '';

// Everything before the first section heading: the orientation block a
// reader sees first.
const intro = readme.split(/^## /m)[0] ?? '';

// The umbrella entrypoints and adapter packages, derived from the umbrella
// manifest and the subsystem directory so the README's map cannot silently
// drift from the published surface.
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(repoRoot, 'di');

// A markdown table row mapping `name`, split into its non-empty cells. The
// backticks make the match exact.
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
  test('a README exists at the di subsystem directory', async () => {
    expect(await readmeFile.exists()).toBe(true);
  });

  test('it opens by stating the subsystem purpose in consumer terms', () => {
    expect(readme).toMatch(/^# /);
    // The orientation block names what the subsystem is -- the domain
    // vocabulary a consumer meets first (tokens -> container -> managed
    // lifecycle), not repo-internal layout talk.
    expect(intro).toMatch(/dependency[ -]injection/i);
    expect(intro).toMatch(/container/i);
    expect(intro).toMatch(/token/i);
    expect(intro).toMatch(/lifecycle/i);
  });
});

describe('0-to-value', () => {
  test('shows the one-package install', () => {
    expect(readme).toMatch(/bun add @insler\/di\s*$/m);
  });

  test('shows a minimal working example built on the umbrella entrypoint', () => {
    expect(tsBlocks.length).toBeGreaterThan(0);
    expect(importSpecifiers).toContain('@insler/di');
    // The 0-to-value story: a typed container with a managed lifecycle.
    const example = tsBlocks.join('\n');
    expect(example).toContain('container()');
    expect(example).toContain('token<');
    expect(example).toContain('.provide(');
    expect(example).toContain('managed(');
    expect(example).toContain('.start()');
  });

  test('example code imports only the public package surface', () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      const isPublic = spec === '@insler/di' || spec.startsWith('@insler/di-');
      expect(isPublic).toBe(true);
    }
  });
});

describe('entrypoint and adapter map', () => {
  test('the derived surface matches what di is: a single-entrypoint core with no adapters', () => {
    // di is a one-package subsystem (see docs/agents/libraries/di.md): the
    // umbrella's only entrypoint is its root, and it is standalone -- no
    // third-party system to bind, so no adapter packages. If either ever
    // changes, this pin is the review moment.
    expect(umbrellaEntrypoints).toEqual(['@insler/di']);
    expect(adapterPackages).toEqual([]);
  });

  test.each(umbrellaEntrypoints)('maps umbrella entrypoint %s with a purpose', (entrypoint) => {
    const cells = mapRowCells(entrypoint);
    expect(cells).toBeDefined();
    // The row carries a one-line purpose alongside the entrypoint itself.
    const purpose = cells?.filter((cell) => !cell.includes(`\`${entrypoint}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });

  test('every adapter package is mapped with a purpose (vacuous today -- di has none)', () => {
    for (const adapter of adapterPackages) {
      const cells = mapRowCells(adapter);
      expect(cells).toBeDefined();
      const purpose = cells?.filter((cell) => !cell.includes(`\`${adapter}\``)) ?? [];
      expect(purpose.length).toBeGreaterThan(0);
    }
  });

  test('the map states that di stands alone (no adapter packages) rather than omitting the topic', () => {
    expect(readme).toMatch(/no adapter packages/i);
  });
});

describe('docs link', () => {
  test('links di.insler.dev for full docs', () => {
    expect(readme).toContain('https://di.insler.dev');
  });

  test('the docs link is part of the orientation block, before any section', () => {
    expect(intro).toContain('https://di.insler.dev');
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
