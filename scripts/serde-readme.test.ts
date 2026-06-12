import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { discoverSubsystemSurface } from './subsystem-surface.ts';

// Repo-level invariants for the serde subsystem README front door
// (subsystem-branding issue 0008, replicating the issue 0003 template): a
// README at the subsystem directory (packages/serde/) states the subsystem's
// purpose in consumer terms, shows the 0-to-value install and a minimal
// example using only the public package surface, maps the umbrella's
// consumer-facing surface and every adapter package with a one-line purpose
// each, and links the docs site at serde.insler.dev.

const repoRoot = new URL('..', import.meta.url).pathname;
const subsystemDir = join(repoRoot, 'packages/serde');
const readmeFile = Bun.file(join(subsystemDir, 'README.md'));
const readme = (await readmeFile.exists()) ? await readmeFile.text() : '';

// Everything before the first section heading: the orientation block a
// reader sees first.
const intro = readme.split(/^## /m)[0] ?? '';

// The umbrella entrypoints and adapter packages, derived from the umbrella
// manifest and the subsystem directory so the README's map cannot silently
// drift from the published surface.
const { umbrellaEntrypoints, adapterPackages } = await discoverSubsystemSurface(repoRoot, 'serde');

// A markdown table row mapping `name`, split into its non-empty cells. The
// backticks make the match exact: a row for `@insler/serde-json` does not
// satisfy `@insler/serde`.
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
  test('a README exists at the serde subsystem directory', async () => {
    expect(await readmeFile.exists()).toBe(true);
  });

  test('it opens by stating the subsystem purpose in consumer terms', () => {
    expect(readme).toMatch(/^# /);
    // The orientation block names what the subsystem is -- the domain
    // vocabulary a consumer meets first (the Serde interface, encode/decode
    // to a wire format, pluggable into transports), not repo-internal layout
    // talk.
    expect(intro).toMatch(/seriali[sz]ation/i);
    expect(intro).toMatch(/encode/i);
    expect(intro).toMatch(/decode/i);
    expect(intro).toMatch(/wire/i);
    expect(intro).toMatch(/transport/i);
  });
});

describe('0-to-value', () => {
  test('shows the one-package install for a working serde (an adapter, since the umbrella is the interface)', () => {
    // serde's umbrella is the interface; a *working* encoder/decoder is one
    // adapter install away. The 0-to-value story installs the JSON adapter.
    expect(readme).toMatch(/bun add @insler\/serde-json\s*$/m);
  });

  test('shows the umbrella install for implementing a custom format', () => {
    expect(readme).toMatch(/bun add @insler\/serde\s*$/m);
  });

  test('shows a minimal working example round-tripping a value through a published adapter', () => {
    expect(tsBlocks.length).toBeGreaterThan(0);
    expect(importSpecifiers).toContain('@insler/serde-json');
    // The 0-to-value story: encode a value to the wire, decode it back.
    const example = tsBlocks.join('\n');
    expect(example).toContain('jsonSerde');
    expect(example).toContain('.encode(');
    expect(example).toContain('.decode(');
  });

  test('shows the Serde interface from the umbrella (the contract every adapter implements)', () => {
    expect(importSpecifiers).toContain('@insler/serde');
    const example = tsBlocks.join('\n');
    expect(example).toContain('Serde<');
  });

  test('example code imports only the public package surface', () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      const isPublic = spec === '@insler/serde' || spec.startsWith('@insler/serde-');
      expect(isPublic).toBe(true);
    }
  });
});

describe('entrypoint and adapter map', () => {
  test('the derived surface matches what serde is: a single-entrypoint interface core with four format adapters', () => {
    // serde is the bottom of the stack (see docs/agents/libraries/serde.md):
    // the umbrella's only entrypoint is its root (the Serde interface), and
    // every format binding is its own adapter package. If either ever
    // changes, this pin is the review moment.
    expect(umbrellaEntrypoints).toEqual(['@insler/serde']);
    expect(adapterPackages).toEqual([
      '@insler/serde-avro',
      '@insler/serde-cbor',
      '@insler/serde-json',
      '@insler/serde-msgpack',
    ]);
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
  test('links serde.insler.dev for full docs', () => {
    expect(readme).toContain('https://serde.insler.dev');
  });

  test('the docs link is part of the orientation block, before any section', () => {
    expect(intro).toContain('https://serde.insler.dev');
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
