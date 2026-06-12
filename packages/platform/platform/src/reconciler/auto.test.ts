import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { applyAuto } from './auto.js';
import { createMemoryStateProvider } from './provider.js';
import { createReconciler } from './reconciler.js';
import type { AutoApplyResult, Resource } from './types.js';

/**
 * Issue 0022 — the ungated auto-apply primitive. `applyAuto` is the dev-only
 * counterpart to the production gate (`applyGated`, 0023): it executes a plan
 * through the engine with **no review and no audit** — the speed path the dev
 * inner loop's auto-converge stands on. It is still the engine's ungated
 * `apply`, so the 0028 stale-plan guard remains in force (a plan keyed to a
 * stale actual is still refused); it simply skips the gate's plan-match policy
 * and audit trail.
 */

function service(name: string, spec: Record<string, unknown>): Resource {
  return { path: `deployment/${name}`, content: JSON.stringify(spec), format: 'yaml' };
}

describe('applyAuto — ungated apply (0022)', () => {
  test('applies a plan and converges actual to desired, with no gate', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { replicas: 5 })];
    const plan = await reconciler.plan(desired);

    const result = await applyAuto(reconciler, plan);

    expect(result.applied).toBe(true);
    expect(result.summary).toEqual({ add: 0, change: 1, destroy: 0 });
    expect(await provider.getActual()).toEqual(desired);
  });

  test('a converged (no-op) plan applies nothing and reports applied: false', async () => {
    const desired = [service('orders', { replicas: 1 })];
    const provider = createMemoryStateProvider(desired);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan(desired);

    const result = await applyAuto(reconciler, plan);

    expect(plan.isNoOp).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.summary).toEqual({ add: 0, change: 0, destroy: 0 });
  });

  test('surfaces add/change/destroy counts so the caller can report what changed', async () => {
    // actual has `gone`; desired drops it, changes `keep`, and adds `fresh`.
    const provider = createMemoryStateProvider([
      service('keep', { replicas: 1 }),
      service('gone', { replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [service('keep', { replicas: 3 }), service('fresh', { replicas: 1 })];
    const plan = await reconciler.plan(desired);

    const result = await applyAuto(reconciler, plan);

    expect(result.applied).toBe(true);
    expect(result.summary).toEqual({ add: 1, change: 1, destroy: 1 });
  });

  test('still refuses a stale plan (the 0028 guard is not bypassed)', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('summarize', { replicas: 5 })]);

    // world moves on before the (ungated) apply
    await provider.setApplied([service('summarize', { replicas: 9 })]);
    const before = await provider.getActual();

    await expect(applyAuto(reconciler, plan)).rejects.toThrow(/stale plan/i);
    // state untouched by the refused apply
    expect(await provider.getActual()).toEqual(before);
  });
});

describe('applyAuto types', () => {
  test('returns an AutoApplyResult, ungated (no audit/operator inputs)', () => {
    expectTypeOf(applyAuto).returns.resolves.toEqualTypeOf<AutoApplyResult>();
    expectTypeOf(applyAuto).parameters.toEqualTypeOf<
      [Parameters<typeof applyAuto>[0], Parameters<typeof applyAuto>[1]]
    >();
  });
});
