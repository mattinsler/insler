import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';

// Repo-level invariants for the service subsystem README front door
// (subsystem-branding issue 0009, replicating the issue 0003 template): a
// README at the subsystem directory (packages/service/) states the
// subsystem's purpose in consumer terms, shows the 0-to-value install and a
// minimal example using only the surface a consumer can reach, maps the
// umbrella's consumer-facing surface with a one-line purpose, and links the
// docs site at service.insler.dev. The README's H1 + first paragraph also
// remain the section title + blurb mirror-scripts/gen-public-readme.ts
// consumes for the public repo README.

const repoRoot = new URL('..', import.meta.url).pathname;
const subsystemDir = join(repoRoot, 'packages/service');
const readmeFile = Bun.file(join(subsystemDir, 'README.md'));
const readme = (await readmeFile.exists()) ? await readmeFile.text() : '';

// Everything before the first section heading: the orientation block a
// reader sees first.
const intro = readme.split(/^## /m)[0] ?? '';

// The umbrella entrypoints and adapter packages, derived from the umbrella
// manifest and the subsystem directory so the README's map cannot silently
// drift from the published surface.
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(
  repoRoot,
  'service'
);

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
  test('a README exists at the service subsystem directory', async () => {
    expect(await readmeFile.exists()).toBe(true);
  });

  test('it opens by stating the subsystem purpose in consumer terms', () => {
    expect(readme).toMatch(/^# /);
    // The orientation block names what the subsystem is -- the domain
    // vocabulary a consumer meets first (the env-aware service layer over
    // the rpc stack, plus defineService: the typed declaration of
    // deployment intent), not repo-internal layout talk.
    expect(intro).toMatch(/environment[ -]aware|knows its\s+environment/i);
    expect(intro).toMatch(/contract/i);
    expect(intro).toMatch(/handler/i);
    expect(intro).toMatch(/declar/i);
    expect(intro).toMatch(/deployment/i);
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
    expect(readme).toMatch(/bun add @insler\/service\s*$/m);
  });

  test('shows a minimal working example covering both roles of the umbrella', () => {
    expect(tsBlocks.length).toBeGreaterThan(0);
    expect(importSpecifiers).toContain('@insler/service');
    // The 0-to-value story: a contract served env-aware (Service.create)
    // and the typed deployment-intent declaration (defineService).
    const example = tsBlocks.join('\n');
    expect(example).toContain('Contract.create(');
    expect(example).toContain('Service.create(');
    expect(example).toContain('defineService(');
  });

  test('example code imports only what a consumer can reach', () => {
    // service is the top of the rpc stack: a consumer authors the contract
    // with @insler/rpc (a runtime dependency the install brings along) and
    // its schemas with zod -- both are part of the consumer story, never a
    // repo-internal path.
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      const isPublic =
        spec === '@insler/service' ||
        spec.startsWith('@insler/service-') ||
        spec === '@insler/rpc' ||
        spec.startsWith('@insler/rpc/') ||
        spec === 'zod';
      expect(isPublic).toBe(true);
    }
  });
});

describe('entrypoint and adapter map', () => {
  test('the derived surface matches what service is: a single-entrypoint core with no adapters', () => {
    // service is a one-package subsystem (see docs/agents/libraries/service.md):
    // the umbrella's only entrypoint is its root, and it binds no third-party
    // system -- the transports it serves over are rpc's adapters, so the
    // subsystem has no adapter packages of its own. If either ever changes,
    // this pin is the review moment.
    expect(umbrellaEntrypoints).toEqual(['@insler/service']);
    expect(adapterPackages).toEqual([]);
  });

  test.each(umbrellaEntrypoints)('maps umbrella entrypoint %s with a purpose', (entrypoint) => {
    const cells = mapRowCells(entrypoint);
    expect(cells).toBeDefined();
    // The row carries a one-line purpose alongside the entrypoint itself.
    const purpose = cells?.filter((cell) => !cell.includes(`\`${entrypoint}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });

  test('every adapter package is mapped with a purpose (vacuous today -- service has none)', () => {
    for (const adapter of adapterPackages) {
      const cells = mapRowCells(adapter);
      expect(cells).toBeDefined();
      const purpose = cells?.filter((cell) => !cell.includes(`\`${adapter}\``)) ?? [];
      expect(purpose.length).toBeGreaterThan(0);
    }
  });

  test('the map states that service has no adapter packages rather than omitting the topic', () => {
    expect(readme).toMatch(/no adapter packages/i);
  });
});

describe('docs link', () => {
  test('links service.insler.dev for full docs', () => {
    expect(readme).toContain('https://service.insler.dev');
  });

  test('the docs link is part of the orientation block, before any section', () => {
    expect(intro).toContain('https://service.insler.dev');
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
