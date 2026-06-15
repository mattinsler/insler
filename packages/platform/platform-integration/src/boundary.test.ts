import { describe, expect, test } from 'bun:test';

import { runApply, runDev, runGenerate, runPlan, runScan } from '@insler/cli';
// @ts-expect-error — '@insler/cli' exports only its root and ./insler; src/ paths must not resolve
import type {} from '@insler/cli/src/index.js';
import { buildFleetManifest, discoverServices, scanFleet } from '@insler/platform/fleet';
// The fleet scanner's module is internal to the /fleet entrypoint — a
// consumer imports the entrypoint, never a file inside it.
// @ts-expect-error — '@insler/platform/fleet/scanner' is not a published subpath; it must not resolve
import type {} from '@insler/platform/fleet/scanner';
import {
  createGenerator,
  fleetInventoryPlugin,
  kubernetesPlugin,
} from '@insler/platform/generator';
import type { GeneratorTarget } from '@insler/platform/generator';
import {
  applyAuto,
  applyGated,
  blastRadius,
  createControlLoop,
  createMemoryStateProvider,
  createReconciler,
  diffState,
  renderPlan,
  renderPlanComment,
  toResources,
} from '@insler/platform/reconciler';
import type { DriftCategory } from '@insler/platform/reconciler';
// The package-boundary contract (subsystem-branding issue 0010, mirroring
// the rpc template and the di/serde/service replications): this package
// consumes the platform subsystem exactly as an external consumer would, so
// an internal (non-public) import must fail VISIBLY. Two guards split the
// work:
//
// - Deep imports into a package's sources are not in its `exports` map, so
//   they fail typecheck (TS2307) — pinned below with `@ts-expect-error`,
//   which itself errors the moment such a path *starts* resolving.
// - Parent-relative imports escaping into the sibling packages' sources
//   would typecheck under the bundler config, so the lint rule owns them
//   (`no-restricted-imports` for `packages/*/*-integration/**`, exercised by
//   scripts/platform-integration-package.test.ts).
//
// @ts-expect-error — '@insler/platform' exports only /fleet, /generator, /reconciler; src/ paths must not resolve
import type {} from '@insler/platform/src/index.js';
import { expectTypeOf } from 'expect-type';

describe('package boundary', () => {
  test('the umbrella entrypoints resolve as an external consumer sees them', () => {
    // /fleet: discovery + the pure manifest fold.
    expect(typeof scanFleet).toBe('function');
    expect(typeof discoverServices).toBe('function');
    expect(typeof buildFleetManifest).toBe('function');
    // /generator: the engine and the shipped plugins (spot-checked).
    expect(typeof createGenerator).toBe('function');
    expect(typeof kubernetesPlugin.generate).toBe('function');
    expect(typeof fleetInventoryPlugin.generate).toBe('function');
    // /reconciler: the engine, the StateProvider fake, and the apply policies.
    expect(typeof createReconciler).toBe('function');
    expect(typeof createMemoryStateProvider).toBe('function');
    expect(typeof diffState).toBe('function');
    expect(typeof toResources).toBe('function');
    expect(typeof applyAuto).toBe('function');
    expect(typeof applyGated).toBe('function');
    expect(typeof blastRadius).toBe('function');
    expect(typeof createControlLoop).toBe('function');
    expect(typeof renderPlan).toBe('function');
    expect(typeof renderPlanComment).toBe('function');
  });

  test('the CLI sibling exports every command programmatically (the consumer entry)', () => {
    expect(typeof runScan).toBe('function');
    expect(typeof runGenerate).toBe('function');
    expect(typeof runPlan).toBe('function');
    expect(typeof runApply).toBe('function');
    expect(typeof runDev).toBe('function');
  });

  test('type surface: the published unions hold from the consumer side', () => {
    expectTypeOf<GeneratorTarget>().toEqualTypeOf<'kubernetes' | 'serverless'>();
    expectTypeOf<DriftCategory>().toEqualTypeOf<
      'replica-count' | 'config-drift' | 'missing-resource' | 'extra-resource'
    >();
  });
});
