import { describe, expect, test } from 'bun:test';

import { createMemoryStateProvider } from './provider.js';
import { createReconciler } from './reconciler.js';
import type { Resource } from './types.js';

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

// --- AC1: engine plans the diff between desired and the provider's actual ---

describe('Reconciler.plan (AC1, AC3)', () => {
  test('diffs desired against the provider actual state', async () => {
    const provider = createMemoryStateProvider([r('keep', 'k'), r('drop', 'd')]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([r('keep', 'k'), r('new', 'n')]);
    expect(plan.summary).toEqual({ add: 1, change: 0, destroy: 1 });
  });

  test('is a no-op when desired equals the provider actual state (AC3)', async () => {
    const provider = createMemoryStateProvider([r('a', '1')]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([r('a', '1')]);
    expect(plan.isNoOp).toBe(true);
  });
});

// --- AC4: detects drift (actual differs from last-applied desired) ---

describe('Reconciler.detectDrift (AC4)', () => {
  test('reports no drift when actual matches the last-applied desired', async () => {
    const provider = createMemoryStateProvider([r('a', '1')], [r('a', '1')]);
    const reconciler = createReconciler(provider);
    const report = await reconciler.detectDrift();
    expect(report.hasDrift).toBe(false);
    expect(report.drifted).toEqual([]);
    expect(report.plan.isNoOp).toBe(true);
  });

  test('reports drift when actual diverged from last-applied out-of-band', async () => {
    const provider = createMemoryStateProvider([r('a', 'tampered')], [r('a', 'applied')]);
    const reconciler = createReconciler(provider);
    const report = await reconciler.detectDrift();
    expect(report.hasDrift).toBe(true);
    expect(report.drifted).toEqual(['a']);
  });

  test('drift plan re-converges actual back to the last-applied desired', async () => {
    const provider = createMemoryStateProvider(
      [r('a', 'tampered'), r('extra', 'x')],
      [r('a', 'applied')]
    );
    const reconciler = createReconciler(provider);
    const report = await reconciler.detectDrift();
    // last-applied is the desired side: 'a' must change back, 'extra' is destroyed.
    expect(report.plan.summary).toEqual({ add: 0, change: 1, destroy: 1 });
    expect(report.drifted).toEqual(['a', 'extra']);
  });
});

// --- AC7 / AC6: apply executes a plan; dry-run persists nothing ---

describe('Reconciler.apply (AC7, AC6)', () => {
  test('applying a plan converges the provider actual state to desired', async () => {
    const provider = createMemoryStateProvider([r('old', 'o')]);
    const reconciler = createReconciler(provider);
    const desired = [r('new', 'n')];
    const plan = await reconciler.plan(desired);
    const result = await reconciler.apply(plan);

    expect(result.applied).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(await provider.getActual()).toEqual(desired);
    // re-planning after apply is now a no-op
    expect((await reconciler.plan(desired)).isNoOp).toBe(true);
  });

  test('apply records the applied desired as the new last-applied (drift baseline)', async () => {
    const provider = createMemoryStateProvider();
    const reconciler = createReconciler(provider);
    const desired = [r('a', '1')];
    await reconciler.apply(await reconciler.plan(desired));
    expect(await provider.getLastApplied()).toEqual(desired);
    expect((await reconciler.detectDrift()).hasDrift).toBe(false);
  });

  test('dry-run computes the plan but persists nothing (AC6)', async () => {
    const provider = createMemoryStateProvider([r('old', 'o')]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([r('new', 'n')]);
    const result = await reconciler.apply(plan, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(await provider.getActual()).toEqual([r('old', 'o')]);
  });

  test('applying a no-op plan mutates nothing and reports applied=false', async () => {
    const provider = createMemoryStateProvider([r('a', '1')]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([r('a', '1')]);
    const result = await reconciler.apply(plan);
    expect(result.applied).toBe(false);
    expect(await provider.getActual()).toEqual([r('a', '1')]);
  });
});

// --- AC2: render is available off the engine ---

describe('Reconciler.render (AC2)', () => {
  test('renders a plan to a human-readable string', async () => {
    const provider = createMemoryStateProvider();
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([r('deployment/summarize', 'v1')]);
    const text = reconciler.render(plan);
    expect(text).toContain('Plan: 1 to add');
    expect(text).toContain('+ deployment/summarize');
  });
});
