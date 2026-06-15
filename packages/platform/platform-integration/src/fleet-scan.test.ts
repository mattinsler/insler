import { describe, expect, test } from 'bun:test';

import { buildFleetManifest, discoverServices, scanFleet } from '@insler/platform/fleet';

// The /fleet entrypoint exercised consumer-grade (subsystem-branding issue
// 0010): real declaration fixture files — defineService around rpc contracts,
// authored exactly as a consumer authors them — discovered by convention and
// folded into the FleetManifest desired-state model, with cross-service
// validation failing visibly on an invalid fleet. All through the published
// surface, against built dist output; the fixture files are the suite's only
// "real" inputs.

const VALID_DIR = new URL('./fixtures/valid/', import.meta.url).pathname;
const INVALID_DIR = new URL('./fixtures/invalid/', import.meta.url).pathname;

describe('scanning a valid fleet', () => {
  test('discovers every declaration by convention and builds the manifest', async () => {
    const result = await scanFleet({ cwd: VALID_DIR });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.services.map((s) => s.name)).toEqual(['greeter', 'orders']);
    expect(result.manifest?.services.map((s) => s.kind)).toEqual(['ephemeral', 'persistent']);
  });

  test('the dependency graph resolves both edge types from the declarations', async () => {
    const result = await scanFleet({ cwd: VALID_DIR });

    // A typed `calls` edge resolves to the producing service's name by
    // subject; a `needs` edge targets the logical resource name.
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'orders',
      to: 'greeter',
      type: 'calls',
    });
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'orders',
      to: 'orders-db',
      type: 'needs',
    });
  });

  test('the fleet-wide routing table tags each route with its owning service', async () => {
    const result = await scanFleet({ cwd: VALID_DIR });

    expect(result.manifest?.expose.routes).toHaveLength(1);
    expect(result.manifest?.expose.routes[0]).toMatchObject({
      path: '/greet',
      method: 'POST',
      service: 'greeter',
      handler: 'greet',
    });
  });

  test('discovery pairs each declaration with its absolute source file', async () => {
    const scanned = await discoverServices({ cwd: VALID_DIR });

    expect(scanned).toHaveLength(2);
    for (const entry of scanned) {
      expect(entry.file.startsWith('/')).toBe(true);
      expect(entry.file.endsWith('.service.ts')).toBe(true);
    }
  });

  test('buildFleetManifest is the pure fold — a caller may bring its own discovery', async () => {
    const scanned = await discoverServices({ cwd: VALID_DIR });
    const folded = buildFleetManifest(scanned);
    const scannedWhole = await scanFleet({ cwd: VALID_DIR });

    expect(folded.errors).toEqual([]);
    expect(folded.manifest?.services.map((s) => s.name)).toEqual(
      scannedWhole.manifest?.services.map((s) => s.name) ?? []
    );
    expect(folded.manifest?.graph).toEqual(scannedWhole.manifest!.graph);
    expect(folded.manifest?.expose).toEqual(scannedWhole.manifest!.expose);
  });
});

describe('scanning an invalid fleet', () => {
  test('a duplicate service name fails validation with both file locations', async () => {
    const result = await scanFleet({ cwd: INVALID_DIR });

    // Never derive artifacts from an invalid fleet: the manifest is only
    // present when errors is empty.
    expect(result.manifest).toBeUndefined();
    const dupe = result.errors.find((e) => e.kind === 'duplicate-service-name');
    expect(dupe).toBeDefined();
    expect(dupe?.message).toContain('dupe');
    expect(dupe?.files.some((f) => f.endsWith('dupe-a.service.ts'))).toBe(true);
    expect(dupe?.files.some((f) => f.endsWith('dupe-b.service.ts'))).toBe(true);
  });
});
