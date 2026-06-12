import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type { FleetResult, ScannedService } from './manifest.js';
import { discoverServices, scanFleet } from './scanner.js';
import type { ScanOptions } from './scanner.js';

// Fixture declaration files live under src/__fixtures__/<case>/. They are real
// `defineService` declarations the scanner discovers (by the *.def.ts /
// *.service.ts convention) and evaluates — the AC1 discovery path end to end.
const FIXTURES = new URL('./__fixtures__/', import.meta.url).pathname;

// --- AC1: discover all service declarations under a tree ---

describe('discoverServices (AC1)', () => {
  test('finds every declaration file regardless of the *.def / *.service suffix', async () => {
    const scanned = await discoverServices({ cwd: `${FIXTURES}valid` });
    const names = scanned.map((s) => s.service.name).sort();
    expect(names).toEqual(['checkout', 'orders']);
  });

  test('pairs each discovered declaration with its absolute source file (AC6)', async () => {
    const scanned = await discoverServices({ cwd: `${FIXTURES}valid` });
    const orders = scanned.find((s) => s.service.name === 'orders');
    expect(orders?.file).toContain('__fixtures__/valid/orders.def.ts');
    expect(orders?.file.startsWith('/')).toBe(true);
  });

  test('skips directories matched by `ignore`', async () => {
    const scanned = await discoverServices({
      cwd: `${FIXTURES}valid`,
      ignore: ['**/node_modules/**', '**/*.service.ts'],
    });
    expect(scanned.map((s) => s.service.name)).toEqual(['orders']);
  });
});

// --- AC1 + AC2: scan a tree straight into a FleetManifest ---

describe('scanFleet (AC1, AC2)', () => {
  test('discovers and assembles a complete manifest for a valid fleet', async () => {
    const result = await scanFleet({ cwd: `${FIXTURES}valid` });
    expect(result.errors).toEqual([]);
    expect(result.manifest?.services.map((s) => s.name).sort()).toEqual(['checkout', 'orders']);
    // calls + needs edges were built from the evaluated declarations (AC5).
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'checkout',
      to: 'orders',
      type: 'calls',
    });
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'orders',
      to: 'orders-db',
      type: 'needs',
    });
  });
});

// --- AC6: errors carry the real fixture file locations ---

describe('scanFleet — errors with file locations (AC6)', () => {
  test('duplicate service name reports both real fixture files', async () => {
    const result = await scanFleet({ cwd: `${FIXTURES}dup-name` });
    const dup = result.errors.find((e) => e.kind === 'duplicate-service-name');
    expect(dup).toBeDefined();
    expect(dup?.files.length).toBe(2);
    expect(dup?.files.every((f) => f.includes('__fixtures__/dup-name/'))).toBe(true);
  });

  test('duplicate expose route reports both real fixture files', async () => {
    const result = await scanFleet({ cwd: `${FIXTURES}dup-route` });
    const dup = result.errors.find((e) => e.kind === 'duplicate-expose-route');
    expect(dup).toBeDefined();
    expect(dup?.files.some((f) => f.includes('one.def.ts'))).toBe(true);
    expect(dup?.files.some((f) => f.includes('two.def.ts'))).toBe(true);
  });

  test('unknown call subject reports the calling fixture file', async () => {
    const result = await scanFleet({ cwd: `${FIXTURES}bad-call` });
    const bad = result.errors.find((e) => e.kind === 'unknown-call-subject');
    expect(bad).toBeDefined();
    expect(bad?.message).toContain('ghost.method');
    expect(bad?.files[0]).toContain('__fixtures__/bad-call/consumer.def.ts');
  });
});

// --- Type-level guarantees ---

describe('scanner types', () => {
  test('discovery and scan signatures', () => {
    expectTypeOf(discoverServices).parameter(0).toEqualTypeOf<ScanOptions | undefined>();
    expectTypeOf(discoverServices).returns.resolves.toEqualTypeOf<ScannedService[]>();
    expectTypeOf(scanFleet).returns.resolves.toEqualTypeOf<FleetResult>();
  });
});
