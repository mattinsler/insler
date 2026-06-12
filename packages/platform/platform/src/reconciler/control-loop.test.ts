import { describe, expect, test } from 'bun:test';

import { createControlLoop } from './control-loop.js';
import { createMemoryStateProvider } from './provider.js';
import { createReconciler } from './reconciler.js';
import type { ControlLoopOptions, DriftLog, DriftLogEntry, Resource, Ticker } from './types.js';

/**
 * Issue 0024 — the continuous reconciliation control loop. A policy *over* the
 * engine (#0021): each pass detects drift (actual vs last-applied desired via
 * the StateProvider), classifies it into the issue's four categories, then —
 * per mode — corrects or alerts, logging every event. Development auto-corrects
 * all correctable drift; production is conservative (alert; optionally
 * auto-correct the safe categories). It never corrects an `extra-resource`: that
 * would fight whatever controller owns it (AC7).
 *
 * Tests are hermetic and deterministic: the in-memory StateProvider is the
 * actual-state seam, and the periodic loop is driven by an injectable Ticker —
 * never a real timer/sleep — so N passes is exact, not timing-dependent.
 */

/** A service deployment resource whose content is its (JSON) spec. */
function deployment(name: string, spec: Record<string, unknown>): Resource {
  return { path: `deployment/${name}`, content: JSON.stringify(spec), format: 'yaml' };
}

/** A capturing in-memory drift log for assertions. */
function captureLog(): DriftLog & { readonly entries: DriftLogEntry[] } {
  const entries: DriftLogEntry[] = [];
  return {
    entries,
    record(entry: DriftLogEntry): void {
      entries.push(entry);
    },
  };
}

const FIXED_NOW = new Date('2026-06-08T12:00:00.000Z');

function options(overrides: Partial<ControlLoopOptions> = {}): ControlLoopOptions {
  return { mode: 'development', log: captureLog(), now: () => FIXED_NOW, ...overrides };
}

/**
 * A ticker that fires a fixed number of times then stops — the hermetic driver
 * for the periodic loop. No wall clock: `run` advances exactly `count` passes.
 */
function ticksFor(count: number): Ticker {
  let remaining = count;
  return {
    next(): Promise<boolean> {
      if (remaining <= 0) return Promise.resolve(false);
      remaining -= 1;
      return Promise.resolve(true);
    },
  };
}

// --- AC2: detects drift between desired and actual ---------------------------

describe('control loop — drift detection (AC2)', () => {
  test('a converged fleet produces no drift events and no log entries', async () => {
    const desired = [deployment('orders', { replicas: 2 })];
    const provider = createMemoryStateProvider(desired, desired);
    const log = captureLog();
    const loop = createControlLoop(createReconciler(provider), options({ log }));

    const result = await loop.reconcileOnce();

    expect(result.events).toEqual([]);
    expect(result.applied).toBe(false);
    expect(log.entries).toEqual([]);
  });

  test('detects each drifted resource as an event', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const result = await loop.reconcileOnce();

    expect(result.events.map((e) => e.path)).toEqual(['deployment/orders']);
  });
});

// --- AC2 / drift categories: the four categories from the issue table --------

describe('control loop — drift categories (issue table)', () => {
  test('classifies a replica-only change as replica-count', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9, image: 'orders:1' })],
      [deployment('orders', { replicas: 2, image: 'orders:1' })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const event = (await loop.reconcileOnce()).events[0]!;

    expect(event.category).toBe('replica-count');
    expect(event.action).toBe('change');
    expect(event.managed).toBe(true);
  });

  test('classifies a non-replica field change as config-drift', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2, image: 'orders:2' })],
      [deployment('orders', { replicas: 2, image: 'orders:1' })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const event = (await loop.reconcileOnce()).events[0]!;

    expect(event.category).toBe('config-drift');
    expect(event.managed).toBe(true);
  });

  test('classifies a deleted managed resource as missing-resource', async () => {
    const provider = createMemoryStateProvider(
      [], // deleted out-of-band
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const event = (await loop.reconcileOnce()).events[0]!;

    expect(event.category).toBe('missing-resource');
    expect(event.action).toBe('add'); // re-converging adds it back
    expect(event.managed).toBe(true);
  });

  test('classifies an unknown deployment as an unmanaged extra-resource', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2 }), deployment('intruder', { replicas: 1 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const event = (await loop.reconcileOnce()).events.find(
      (e) => e.path === 'deployment/intruder'
    )!;

    expect(event.category).toBe('extra-resource');
    expect(event.action).toBe('destroy');
    expect(event.managed).toBe(false);
  });
});

// --- AC3: auto-corrects drift in development ---------------------------------

describe('control loop — development auto-correct (AC3)', () => {
  test('corrects a replica-count drift back to intent and reports applied', async () => {
    const intent = deployment('orders', { replicas: 2 });
    const provider = createMemoryStateProvider([deployment('orders', { replicas: 9 })], [intent]);
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const result = await loop.reconcileOnce();

    expect(result.applied).toBe(true);
    expect(result.corrected.map((e) => e.path)).toEqual(['deployment/orders']);
    expect(result.alerted).toEqual([]);
    expect(await provider.getActual()).toEqual([intent]);
  });

  test('corrects config drift and a missing resource in development', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2, image: 'orders:tampered' })], // config drift; `audit` deleted
      [
        deployment('orders', { replicas: 2, image: 'orders:1' }),
        deployment('audit', { replicas: 1 }),
      ]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const result = await loop.reconcileOnce();

    expect(result.corrected.map((e) => e.category).sort()).toEqual([
      'config-drift',
      'missing-resource',
    ]);
    const actual = await provider.getActual();
    expect(actual).toEqual([
      deployment('audit', { replicas: 1 }),
      deployment('orders', { replicas: 2, image: 'orders:1' }),
    ]);
  });

  test('a second pass after correcting is a converged no-op (self-healing settles)', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    await loop.reconcileOnce();
    const second = await loop.reconcileOnce();

    expect(second.events).toEqual([]);
    expect(second.applied).toBe(false);
  });
});

// --- AC4: production alerts; optional safe auto-correct -----------------------

describe('control loop — production policy (AC4)', () => {
  test('alerts on all drift and corrects nothing by default', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })],
      [deployment('orders', { replicas: 2 })]
    );
    const before = await provider.getActual();
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'production' }));

    const result = await loop.reconcileOnce();

    expect(result.alerted.map((e) => e.path)).toEqual(['deployment/orders']);
    expect(result.corrected).toEqual([]);
    expect(result.applied).toBe(false);
    expect(await provider.getActual()).toEqual(before); // untouched
  });

  test('with safe auto-correct enabled, corrects replica-count and config-drift', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9, image: 'orders:1' })],
      [deployment('orders', { replicas: 2, image: 'orders:1' })]
    );
    const loop = createControlLoop(
      createReconciler(provider),
      options({ mode: 'production', autoCorrectSafeInProduction: true })
    );

    const result = await loop.reconcileOnce();

    expect(result.corrected.map((e) => e.category)).toEqual(['replica-count']);
    expect(result.applied).toBe(true);
    expect(await provider.getActual()).toEqual([
      deployment('orders', { replicas: 2, image: 'orders:1' }),
    ]);
  });

  test('a missing resource is alert-first in production even with safe auto-correct on', async () => {
    const provider = createMemoryStateProvider(
      [], // deleted in prod
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(
      createReconciler(provider),
      options({ mode: 'production', autoCorrectSafeInProduction: true })
    );

    const result = await loop.reconcileOnce();

    expect(result.alerted.map((e) => e.category)).toEqual(['missing-resource']);
    expect(result.corrected).toEqual([]);
    expect(result.applied).toBe(false);
  });
});

// --- AC6 + AC7: managed vs unmanaged; never fight other controllers ----------

describe('control loop — ownership & unmanaged resources (AC6, AC7)', () => {
  test('does not destroy an extra/unmanaged resource — only alerts on it', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2 }), deployment('intruder', { replicas: 1 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const result = await loop.reconcileOnce();

    const extra = result.alerted.find((e) => e.path === 'deployment/intruder')!;
    expect(extra.category).toBe('extra-resource');
    expect(result.corrected.some((e) => e.path === 'deployment/intruder')).toBe(false);
    // the intruder is still present — we did not fight its controller
    expect((await provider.getActual()).some((r) => r.path === 'deployment/intruder')).toBe(true);
  });

  test('corrects managed drift while preserving an unmanaged extra in the same pass', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 }), deployment('intruder', { replicas: 1 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const result = await loop.reconcileOnce();

    expect(result.corrected.map((e) => e.path)).toEqual(['deployment/orders']);
    expect(result.alerted.map((e) => e.path)).toEqual(['deployment/intruder']);
    const actual = await provider.getActual();
    // orders converged back to 2; intruder left untouched
    expect(actual).toEqual([
      deployment('intruder', { replicas: 1 }),
      deployment('orders', { replicas: 2 }),
    ]);
  });

  test('a correction never adopts an unmanaged extra: it stays an alerted extra-resource on later passes', async () => {
    // Regression: the correction apply used to record its desired set —
    // intruder included — as last-applied, so from pass 2 the intruder was no
    // longer drift: never re-alerted, and treated as managed thereafter.
    const intruder = deployment('intruder', { replicas: 1 });
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 }), intruder],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const first = await loop.reconcileOnce();
    expect(first.corrected.map((e) => e.path)).toEqual(['deployment/orders']);

    // The corrected intent must not have absorbed the intruder.
    expect((await provider.getLastApplied()).map((r) => r.path)).toEqual(['deployment/orders']);

    const second = await loop.reconcileOnce();
    const extra = second.alerted.find((e) => e.path === 'deployment/intruder')!;
    expect(extra.category).toBe('extra-resource');
    expect(extra.managed).toBe(false);
    expect(second.corrected).toEqual([]);
    // ...and the intruder is still alive, untouched, after both passes.
    expect(await provider.getActual()).toEqual([intruder, deployment('orders', { replicas: 2 })]);
  });

  test('a safe correction never abandons an alert-only missing resource from intent', async () => {
    // The same lapse from the other side: correcting the replica drift used to
    // rewrite last-applied without the (uncorrected) missing resource, so from
    // pass 2 it was no longer intended — and no longer alerted.
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })], // audit deleted out-of-band
      [deployment('orders', { replicas: 2 }), deployment('audit', { replicas: 1 })]
    );
    const loop = createControlLoop(
      createReconciler(provider),
      options({ mode: 'production', autoCorrectSafeInProduction: true })
    );

    const first = await loop.reconcileOnce();
    expect(first.corrected.map((e) => e.category)).toEqual(['replica-count']);
    expect(first.alerted.map((e) => e.category)).toEqual(['missing-resource']);

    const second = await loop.reconcileOnce();
    expect(second.alerted.map((e) => e.category)).toEqual(['missing-resource']);
    expect(second.alerted[0]!.path).toBe('deployment/audit');
  });
});

// --- AC5: logs all drift events and corrections ------------------------------

describe('control loop — drift log (AC5)', () => {
  test('logs one entry per drift event, with action and timestamp', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 }), deployment('intruder', { replicas: 1 })],
      [deployment('orders', { replicas: 2 })]
    );
    const log = captureLog();
    const loop = createControlLoop(
      createReconciler(provider),
      options({ mode: 'development', log })
    );

    await loop.reconcileOnce();

    expect(log.entries).toHaveLength(2);
    const byPath = new Map(log.entries.map((e) => [e.event.path, e]));
    expect(byPath.get('deployment/orders')!.action).toBe('corrected');
    expect(byPath.get('deployment/intruder')!.action).toBe('alerted');
    for (const entry of log.entries) {
      expect(entry.timestamp).toBe(FIXED_NOW.toISOString());
    }
  });

  test('a drift log entry round-trips through JSON (durable trail)', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })],
      [deployment('orders', { replicas: 2 })]
    );
    const log = captureLog();
    const loop = createControlLoop(createReconciler(provider), options({ log }));

    await loop.reconcileOnce();

    const entry = log.entries[0]!;
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry as unknown as DriftLogEntry);
  });

  test('a converged pass logs nothing', async () => {
    const desired = [deployment('orders', { replicas: 2 })];
    const provider = createMemoryStateProvider(desired, desired);
    const log = captureLog();
    const loop = createControlLoop(createReconciler(provider), options({ log }));

    await loop.reconcileOnce();

    expect(log.entries).toEqual([]);
  });
});

// --- AC1: runs on a configurable interval (hermetic ticker) ------------------

describe('control loop — periodic run on an injectable ticker (AC1)', () => {
  test('runs exactly one pass per tick and returns each result in order', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 9 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    const results = await loop.run(ticksFor(3));

    expect(results).toHaveLength(3);
    // pass 1 corrects; passes 2 and 3 are converged no-ops (self-healing settles)
    expect(results[0]!.applied).toBe(true);
    expect(results[1]!.applied).toBe(false);
    expect(results[2]!.applied).toBe(false);
    expect(await provider.getActual()).toEqual([deployment('orders', { replicas: 2 })]);
  });

  test('re-corrects fresh drift introduced between ticks (continuous healing)', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options({ mode: 'development' }));

    // A ticker that scales `orders` out-of-band before the second pass — a
    // manual scale on live state only, leaving last-applied as the baseline.
    let tick = 0;
    const driftThenTick: Ticker = {
      async next(): Promise<boolean> {
        tick += 1;
        if (tick > 2) return false;
        if (tick === 2) {
          await provider.driftActual([deployment('orders', { replicas: 7 })]);
        }
        return true;
      },
    };

    const results = await loop.run(driftThenTick);

    expect(results).toHaveLength(2);
    expect(results[0]!.applied).toBe(false); // converged at start
    expect(results[1]!.applied).toBe(true); // healed the injected drift
    expect(await provider.getActual()).toEqual([deployment('orders', { replicas: 2 })]);
  });

  test('stops when the ticker stops', async () => {
    const provider = createMemoryStateProvider(
      [deployment('orders', { replicas: 2 })],
      [deployment('orders', { replicas: 2 })]
    );
    const loop = createControlLoop(createReconciler(provider), options());

    const results = await loop.run(ticksFor(0));

    expect(results).toEqual([]);
  });
});
