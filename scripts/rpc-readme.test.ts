import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';

// Repo-level invariants for the rpc subsystem README front door
// (subsystem-branding issue 0003): a README at the subsystem directory
// (packages/rpc/) states the subsystem's purpose in consumer terms, shows the
// 0-to-value install and a minimal example using only the public package
// surface, maps every umbrella entrypoint and every adapter package with a
// one-line purpose each, and links the docs site at rpc.insler.dev. This is
// the template README that issues 0007-0010 replicate for other subsystems.

const repoRoot = new URL('..', import.meta.url).pathname;
const subsystemDir = join(repoRoot, 'packages/rpc');
const readmeFile = Bun.file(join(subsystemDir, 'README.md'));
const readme = (await readmeFile.exists()) ? await readmeFile.text() : '';

// Everything before the first section heading: the orientation block a
// reader sees first.
const intro = readme.split(/^## /m)[0] ?? '';

// The umbrella entrypoints and adapter packages, derived from the umbrella
// manifest and the subsystem directory so the README's map cannot silently
// drift from the published surface.
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(repoRoot, 'rpc');

// A markdown table row mapping `name`, split into its non-empty cells. The
// backticks make the match exact: a row for `@insler/rpc/client/test` does
// not satisfy `@insler/rpc/client`.
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
  test('a README exists at the rpc subsystem directory', async () => {
    expect(await readmeFile.exists()).toBe(true);
  });

  test('it opens by stating the subsystem purpose in consumer terms', () => {
    expect(readme).toMatch(/^# /);
    // The orientation block names what the subsystem is -- the domain
    // vocabulary a consumer meets first (contract -> client/host), not
    // repo-internal layout talk.
    expect(intro).toMatch(/RPC/i);
    expect(intro).toMatch(/contract/i);
    expect(intro).toMatch(/client/i);
    expect(intro).toMatch(/host/i);
  });
});

describe('0-to-value', () => {
  test('shows the one-package install', () => {
    expect(readme).toMatch(/bun add @insler\/rpc\s*$/m);
  });

  test('shows a minimal working example built on the umbrella root entrypoint', () => {
    expect(tsBlocks.length).toBeGreaterThan(0);
    expect(importSpecifiers).toContain('@insler/rpc');
    // The 0-to-value story: a working in-process service.
    const example = tsBlocks.join('\n');
    expect(example).toContain('Contract.create');
    expect(example).toContain('Host.create');
    expect(example).toContain('Client.create');
    expect(example).toContain('createMemoryTransport');
  });

  test('example code imports only the public package surface', () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      const isPublic =
        spec === 'zod' ||
        spec === '@insler/rpc' ||
        spec.startsWith('@insler/rpc/') ||
        spec.startsWith('@insler/rpc-');
      expect(isPublic).toBe(true);
    }
  });
});

describe('entrypoint and adapter map', () => {
  test('the derived surface is non-trivial (discovery sanity check)', () => {
    // The five pure layers of ADR-0003 plus their dev/test entrypoints.
    expect(umbrellaEntrypoints.length).toBeGreaterThanOrEqual(5);
    expect(umbrellaEntrypoints).toContain('@insler/rpc/contract');
    expect(adapterPackages).toContain('@insler/rpc-transport-nats');
    expect(adapterPackages).toContain('@insler/rpc-otel');
  });

  test.each(umbrellaEntrypoints)('maps umbrella entrypoint %s with a purpose', (entrypoint) => {
    const cells = mapRowCells(entrypoint);
    expect(cells).toBeDefined();
    // The row carries a one-line purpose alongside the entrypoint itself.
    const purpose = cells?.filter((cell) => !cell.includes(`\`${entrypoint}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });

  test.each(adapterPackages)('maps adapter package %s with a purpose', (adapter) => {
    const cells = mapRowCells(adapter);
    expect(cells).toBeDefined();
    const purpose = cells?.filter((cell) => !cell.includes(`\`${adapter}\``)) ?? [];
    expect(purpose.length).toBeGreaterThan(0);
  });
});

describe('docs link', () => {
  test('links rpc.insler.dev for full docs', () => {
    expect(readme).toContain('https://rpc.insler.dev');
  });

  test('the docs link is part of the orientation block, before any section', () => {
    expect(intro).toContain('https://rpc.insler.dev');
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
