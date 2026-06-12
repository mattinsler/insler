import { describe, expect, test } from 'bun:test';

import { buildFleetManifest as fleetBuildFleetManifest } from './fleet/index.js';
import { buildFleetManifest, createGenerator, createReconciler } from './index.js';

// The primary surface of the @insler/platform umbrella (subsystem-layout
// issue 0004): the root entrypoint re-exports the fleet + generator +
// reconciler layers (ADR-0002's partial-adoption property as subpath
// imports), with one runtime copy of each symbol across entrypoints.

describe('@insler/platform root entrypoint', () => {
  test('exposes the primary surface of all three layers', () => {
    expect(typeof buildFleetManifest).toBe('function');
    expect(typeof createGenerator).toBe('function');
    expect(typeof createReconciler).toBe('function');
  });

  test('the layers compose: manifest -> generator from the root surface alone', () => {
    const result = buildFleetManifest([]);
    expect(result.errors).toEqual([]);
    if (!result.manifest) throw new Error('empty fleet must build');

    const generated = createGenerator().generate(result.manifest, {
      target: 'kubernetes',
      outputDir: '/unused',
      environment: 'prod',
    });
    expect(generated.files).toEqual([]);
  });

  test('type identity: one copy of each symbol across entrypoints', () => {
    expect(Object.is(buildFleetManifest, fleetBuildFleetManifest)).toBe(true);
  });
});
