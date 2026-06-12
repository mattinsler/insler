import { describe, expect, test } from 'bun:test';

import { createMemoryStateProvider } from './provider.js';
import { createReconciler } from './reconciler.js';
import type { Resource } from './types.js';

/**
 * End-to-end plan/diff scenario suite for issue 0028. Each scenario simulates a
 * *desired state* (as the generator would derive it from declarations) against a
 * simulated *actual state* held by an in-memory {@link StateProvider}, and asserts
 * the computed changeset. Everything is hermetic — no real cluster, no NATS.
 *
 * These are deliberately scenario-shaped (a fleet of services, scaling, drift,
 * removals) rather than the primitive add/change/destroy/no-op unit tests already
 * covered in `diff.test.ts` / `reconciler.test.ts` by issue 0021.
 */

/** Build a service deployment resource (yaml-formatted, like the generator emits). */
function service(name: string, spec: Record<string, unknown>): Resource {
  return {
    path: `deployment/${name}`,
    content: JSON.stringify(spec),
    format: 'yaml',
  };
}

/** Map a plan's changes to a comparable `action:path` list in deterministic order. */
function actions(changes: readonly { action: string; path: string }[]): string[] {
  return changes.map((c) => `${c.action}:${c.path}`);
}

// --- Scenario 1: initial deployment — no actual state, plan adds everything ---

describe('scenario: initial deployment (AC: all adds)', () => {
  test('plans an add for every declared service when actual state is empty', async () => {
    const provider = createMemoryStateProvider([]);
    const reconciler = createReconciler(provider);
    const desired = [
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('orders', { image: 'orders:1', replicas: 1 }),
      service('session-hub', { image: 'session-hub:1', replicas: 3 }),
    ];

    const plan = await reconciler.plan(desired);

    expect(plan.isNoOp).toBe(false);
    expect(plan.summary).toEqual({ add: 3, change: 0, destroy: 0 });
    expect(actions(plan.changes)).toEqual([
      'add:deployment/orders',
      'add:deployment/session-hub',
      'add:deployment/summarize',
    ]);
  });

  test('applying the initial plan converges actual to the full desired fleet', async () => {
    const provider = createMemoryStateProvider([]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { image: 'summarize:1', replicas: 2 })];

    const result = await reconciler.apply(await reconciler.plan(desired));

    expect(result.applied).toBe(true);
    expect(await provider.getActual()).toEqual(desired);
    expect((await reconciler.plan(desired)).isNoOp).toBe(true);
  });
});

// --- Scenario 2: no-op — desired matches actual, empty plan ---

describe('scenario: converged fleet (AC: no-op)', () => {
  test('plans nothing when every declared service matches the actual state', async () => {
    const fleet = [
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('orders', { image: 'orders:1', replicas: 1 }),
    ];
    const provider = createMemoryStateProvider(fleet);
    const reconciler = createReconciler(provider);

    const plan = await reconciler.plan(fleet);

    expect(plan.isNoOp).toBe(true);
    expect(plan.summary).toEqual({ add: 0, change: 0, destroy: 0 });
    expect(actions(plan.changes)).toEqual([
      'no-op:deployment/orders',
      'no-op:deployment/summarize',
    ]);
  });

  test('applying a converged plan mutates nothing', async () => {
    const fleet = [service('summarize', { image: 'summarize:1', replicas: 2 })];
    const provider = createMemoryStateProvider(fleet);
    const reconciler = createReconciler(provider);

    const result = await reconciler.apply(await reconciler.plan(fleet));

    expect(result.applied).toBe(false);
    expect(await provider.getActual()).toEqual(fleet);
  });
});

// --- Scenario 3: scale change — desired replicas differ from actual ---

describe('scenario: scale change (AC: partial change)', () => {
  test('plans a single change when only one service is rescaled', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('orders', { image: 'orders:1', replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [
      service('summarize', { image: 'summarize:1', replicas: 5 }), // 2 -> 5
      service('orders', { image: 'orders:1', replicas: 1 }), // unchanged
    ];

    const plan = await reconciler.plan(desired);

    expect(plan.summary).toEqual({ add: 0, change: 1, destroy: 0 });
    const change = plan.changes.find((c) => c.path === 'deployment/summarize');
    expect(change?.action).toBe('change');
    expect(change?.before).toBe(JSON.stringify({ image: 'summarize:1', replicas: 2 }));
    expect(change?.after).toBe(JSON.stringify({ image: 'summarize:1', replicas: 5 }));
    // the unchanged service is a no-op, not a change
    expect(plan.changes.find((c) => c.path === 'deployment/orders')?.action).toBe('no-op');
  });
});

// --- Scenario 4: new service added — one new declaration, add only that ---

describe('scenario: new service added (AC: service addition)', () => {
  test('plans an add only for the newly declared service, no-ops the rest', async () => {
    const existing = [
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('orders', { image: 'orders:1', replicas: 1 }),
    ];
    const provider = createMemoryStateProvider(existing);
    const reconciler = createReconciler(provider);
    const desired = [...existing, service('payments', { image: 'payments:1', replicas: 1 })];

    const plan = await reconciler.plan(desired);

    expect(plan.summary).toEqual({ add: 1, change: 0, destroy: 0 });
    expect(plan.changes.find((c) => c.action === 'add')?.path).toBe('deployment/payments');
  });
});

// --- Scenario 5: service removed — declaration deleted, plan destroys ---

describe('scenario: service removed (AC: service removal / destroy)', () => {
  test('plans a destroy for a service dropped from the declarations', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('legacy', { image: 'legacy:9', replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    // 'legacy' is no longer declared
    const desired = [service('summarize', { image: 'summarize:1', replicas: 2 })];

    const plan = await reconciler.plan(desired);

    expect(plan.summary).toEqual({ add: 0, change: 0, destroy: 1 });
    const destroy = plan.changes.find((c) => c.action === 'destroy');
    expect(destroy?.path).toBe('deployment/legacy');
    expect(destroy?.after).toBeUndefined();
  });

  test('applying the removal plan drops the undeclared service from actual', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('legacy', { image: 'legacy:9', replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { image: 'summarize:1', replicas: 2 })];

    await reconciler.apply(await reconciler.plan(desired));

    expect(await provider.getActual()).toEqual(desired);
  });
});

// --- Scenario 6: config drift — actual modified out-of-band, plan corrects ---

describe('scenario: config drift detection + correction (AC: drift detection)', () => {
  test('detectDrift reports a service tampered out-of-band against last-applied', async () => {
    // last-applied is what we deployed; actual was edited by hand afterwards.
    const lastApplied = [service('summarize', { image: 'summarize:1', replicas: 2 })];
    const tamperedActual = [service('summarize', { image: 'summarize:1', replicas: 99 })];
    const provider = createMemoryStateProvider(tamperedActual, lastApplied);
    const reconciler = createReconciler(provider);

    const report = await reconciler.detectDrift();

    expect(report.hasDrift).toBe(true);
    expect(report.drifted).toEqual(['deployment/summarize']);
  });

  test('the drift plan corrects actual back to the declared (last-applied) state', async () => {
    const lastApplied = [service('summarize', { image: 'summarize:1', replicas: 2 })];
    const tamperedActual = [service('summarize', { image: 'summarize:1', replicas: 99 })];
    const provider = createMemoryStateProvider(tamperedActual, lastApplied);
    const reconciler = createReconciler(provider);

    const report = await reconciler.detectDrift();
    // re-converging diff: 'summarize' must change back from 99 -> 2
    expect(report.plan.summary).toEqual({ add: 0, change: 1, destroy: 0 });
    const correction = report.plan.changes.find((c) => c.path === 'deployment/summarize');
    expect(correction?.action).toBe('change');
    expect(correction?.after).toBe(JSON.stringify({ image: 'summarize:1', replicas: 2 }));

    await reconciler.apply(report.plan);
    expect((await reconciler.detectDrift()).hasDrift).toBe(false);
  });
});

// --- Scenario 7: multiple changes — aggregate adds + changes + destroys ---

describe('scenario: multiple aggregated changes (AC: partial changes aggregated)', () => {
  test('aggregates an add, a change, and a destroy across the fleet in one plan', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }), // will change
      service('orders', { image: 'orders:1', replicas: 1 }), // stays
      service('legacy', { image: 'legacy:9', replicas: 1 }), // will be destroyed
    ]);
    const reconciler = createReconciler(provider);
    const desired = [
      service('summarize', { image: 'summarize:2', replicas: 4 }), // changed image + replicas
      service('orders', { image: 'orders:1', replicas: 1 }), // unchanged
      service('payments', { image: 'payments:1', replicas: 1 }), // new
    ];

    const plan = await reconciler.plan(desired);

    expect(plan.summary).toEqual({ add: 1, change: 1, destroy: 1 });
    expect(actions(plan.changes)).toEqual([
      'destroy:deployment/legacy',
      'no-op:deployment/orders',
      'add:deployment/payments',
      'change:deployment/summarize',
    ]);
  });

  test('applying the aggregate plan converges actual to exactly the declared fleet', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
      service('legacy', { image: 'legacy:9', replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [
      service('summarize', { image: 'summarize:2', replicas: 4 }),
      service('payments', { image: 'payments:1', replicas: 1 }),
    ];

    await reconciler.apply(await reconciler.plan(desired));

    const actual = await provider.getActual();
    expect(actions([])).toEqual([]); // sanity
    expect([...actual].map((r) => r.path).sort()).toEqual([
      'deployment/payments',
      'deployment/summarize',
    ]);
    expect((await reconciler.plan(desired)).isNoOp).toBe(true);
  });
});

// --- Scenario 8: stale plan — declarations/actual changed after plan computed ---

describe('scenario: stale plan rejection (AC: stale plan rejection)', () => {
  test('applying a plan computed against a now-changed actual state is rejected', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { image: 'summarize:2', replicas: 2 })];

    // Operator computes a plan...
    const plan = await reconciler.plan(desired);

    // ...but the world moves on before they apply: a concurrent apply changes
    // actual out from under the plan (declarations were re-applied elsewhere).
    await provider.setApplied([service('summarize', { image: 'summarize:3', replicas: 7 })]);

    // Applying the now-stale plan must be rejected, not silently clobber the
    // newer state.
    await expect(reconciler.apply(plan)).rejects.toThrow(/stale plan/i);
  });

  test('a fresh plan over the unchanged state still applies cleanly', async () => {
    const provider = createMemoryStateProvider([
      service('summarize', { image: 'summarize:1', replicas: 2 }),
    ]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { image: 'summarize:2', replicas: 2 })];

    const plan = await reconciler.plan(desired);
    // nothing else mutates state in between
    const result = await reconciler.apply(plan);

    expect(result.applied).toBe(true);
    expect(await provider.getActual()).toEqual(desired);
  });

  test('a stale dry-run is also rejected (it would preview a bogus diff)', async () => {
    const provider = createMemoryStateProvider([
      service('orders', { image: 'orders:1', replicas: 1 }),
    ]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('orders', { image: 'orders:2', replicas: 1 })]);

    await provider.setApplied([service('orders', { image: 'orders:9', replicas: 9 })]);

    await expect(reconciler.apply(plan, { dryRun: true })).rejects.toThrow(/stale plan/i);
  });
});
