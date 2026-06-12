import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMemoryStateProvider } from '@insler/platform/reconciler';
import type { StateProvider } from '@insler/platform/reconciler';
import { expectTypeOf } from 'expect-type';

import { converge, runDev, watchDeclarations } from './dev.js';
import type { DevArgs, DevDeps, DevIO, WatchHandle, WatchSource } from './dev.js';

/**
 * Issue 0022 — development auto-convergence (`insler dev`). The orchestration —
 * watch declaration files → re-scan → re-generate → diff → AUTO-APPLY (ungated)
 * → report — lives in the CLI composition layer. These tests are hermetic: the
 * converge cycle is driven directly over a temp dir of fixture declarations and
 * an in-memory {@link StateProvider}; the watcher is exercised with a
 * deterministic fake watch source so nothing depends on real, flaky watch
 * timing.
 */

const ORDERS_DECL = `import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: { input: z.object({ sku: z.string() }), output: z.object({ id: z.string() }) },
  },
});

export const orders: ServiceDef = defineService({
  name: 'orders',
  kind: 'persistent',
  contract: OrdersContract,
  needs: ['orders-db'],
  expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
});
`;

const PAYMENTS_DECL = `import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const PaymentsContract = Contract.create('payments', {
  version: '1.0.0',
  methods: {
    charge: { input: z.object({ amount: z.number() }), output: z.object({ ok: z.boolean() }) },
  },
});

export const payments: ServiceDef = defineService({
  name: 'payments',
  kind: 'persistent',
  contract: PaymentsContract,
  needs: ['payments-db'],
  expose: { http: { method: 'POST', path: '/payments', handler: 'charge' } },
});
`;

const BAD_DECL = `not valid typescript service ((( $$$`;

function captureIO(): DevIO & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
  };
}

// Fixtures live under the *fleet* package tree (not the OS tmpdir) so the
// scanner's dynamic `import()` of a declaration resolves `@insler/rpc/contract`,
// `@insler/service`, and `zod` through fleet's node_modules — those are fleet's
// dependencies, not the CLI's, and an OS-temp file can't see them.
const TMP_PREFIX = new URL('../../platform/.tmp-dev-test-', import.meta.url).pathname;

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(TMP_PREFIX);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A deterministic fake {@link WatchSource}: instead of real `fs.watch`, it hands
 * back a `fire()` the test calls to synthesize a file-change event. No timers,
 * no flakiness.
 */
function fakeWatch(): {
  readonly source: WatchSource;
  fire: () => void;
  readonly watched: string[];
  closed: boolean;
} {
  let onChange: (() => void) | undefined;
  const state = {
    watched: [] as string[],
    closed: false,
    fire: (): void => onChange?.(),
    source: ((dir: string, handler: () => void): WatchHandle => {
      state.watched.push(dir);
      onChange = handler;
      return { close: () => void (state.closed = true) };
    }) as WatchSource,
  };
  return state;
}

// --- AC2/AC3/AC4: converge = scan + generate + diff + auto-apply + report ---

describe('converge — one auto-converge cycle (AC2, AC3, AC4)', () => {
  test('scans, generates, diffs, auto-applies, and reports the changes', async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'orders.def.ts'), ORDERS_DECL, 'utf8');
      const provider = createMemoryStateProvider();
      const io = captureIO();

      const report = await converge({ cwd: dir }, io, () => provider);

      expect(report.ok).toBe(true);
      expect(report.applied).toBe(true);
      expect(report.summary?.add).toBeGreaterThan(0);
      // AC4: reports what changed to stdout
      expect(io.outLines.join('\n')).toMatch(/added/i);
      // AC3: actual now holds the generated desired state
      expect((await provider.getActual()).length).toBeGreaterThan(0);
    });
  });

  test('a second converge over the same declarations is a no-op (idempotent)', async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'orders.def.ts'), ORDERS_DECL, 'utf8');
      const provider = createMemoryStateProvider();
      await converge({ cwd: dir }, captureIO(), () => provider);

      const io = captureIO();
      const report = await converge({ cwd: dir }, io, () => provider);

      expect(report.ok).toBe(true);
      expect(report.applied).toBe(false);
      expect(io.outLines.join('\n')).toMatch(/no changes|up to date/i);
    });
  });

  test('reports scan errors without applying, but does not throw (the loop survives)', async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'broken.def.ts'), BAD_DECL, 'utf8');
      const provider = createMemoryStateProvider();
      const io = captureIO();

      const report = await converge({ cwd: dir }, io, () => provider);

      expect(report.ok).toBe(false);
      expect(report.applied).toBeFalsy();
      expect(io.errLines.join('\n').length).toBeGreaterThan(0);
      // nothing applied on a failed scan
      expect(await provider.getActual()).toEqual([]);
    });
  });
});

// --- AC1: file watcher detects changes to declaration files ---

describe('watchDeclarations — watches declaration files (AC1)', () => {
  test('invokes the handler when the watch source fires a change', async () => {
    await withTmpDir(async (dir) => {
      const watch = fakeWatch();
      let changes = 0;

      const handle = watchDeclarations(dir, () => void (changes += 1), watch.source);

      expect(watch.watched).toContain(dir);
      watch.fire();
      watch.fire();
      expect(changes).toBe(2);

      handle.close();
      expect(watch.closed).toBe(true);
    });
  });
});

// --- AC5/AC6/AC7: runDev wires it together, dev-only, no approval ---

describe('runDev — orchestration & dev-only guard (AC5, AC6)', () => {
  test('refuses to run in production and applies nothing (AC6)', async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'orders.def.ts'), ORDERS_DECL, 'utf8');
      const provider = createMemoryStateProvider();
      const io = captureIO();
      const watch = fakeWatch();

      const session = await runDev({ cwd: dir, environment: 'production' }, io, {
        makeProvider: () => provider,
        watch: watch.source,
      });

      expect(session.code).toBe(1);
      expect(io.errLines.join('\n')).toMatch(/production/i);
      // never watched, never applied
      expect(watch.watched).toEqual([]);
      expect(await provider.getActual()).toEqual([]);
      session.stop();
    });
  });

  test('runs an initial converge and re-converges on each watch event, no approval (AC5)', async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'orders.def.ts'), ORDERS_DECL, 'utf8');
      const provider = createMemoryStateProvider();
      const io = captureIO();
      const watch = fakeWatch();

      const session = await runDev({ cwd: dir }, io, {
        makeProvider: () => provider,
        watch: watch.source,
      });

      // initial converge applied without any prompt/approval
      expect(session.code).toBe(0);
      const desiredBefore = await provider.getActual();
      expect(desiredBefore.length).toBeGreaterThan(0);

      // adding a declaration file triggers another converge cycle that picks up
      // the new service (a fresh file path, so the scanner's import isn't cached)
      await writeFile(join(dir, 'payments.def.ts'), PAYMENTS_DECL, 'utf8');
      watch.fire();
      await session.idle();
      // the new declaration converged in: the live desired state now reflects it
      const desiredAfter = await provider.getActual();
      expect(desiredAfter).not.toEqual(desiredBefore);
      expect(desiredAfter.map((r) => r.content).join('\n')).toContain('payments');

      session.stop();
      expect(watch.closed).toBe(true);
    });
  });

  test('a burst of watch events coalesces onto at most one queued converge', async () => {
    const provider = createMemoryStateProvider();
    const io = captureIO();
    const watch = fakeWatch();

    // A gated scan stub: each cycle's scan blocks until the test releases it,
    // so the test controls exactly when a converge is "in flight". Counting
    // scans counts converge cycles.
    let scans = 0;
    const gates: Array<() => void> = [];
    const emptyFleet = {
      manifest: { services: [], graph: { edges: [] }, expose: { routes: [] } },
      errors: [],
    };
    const scan = (async () => {
      scans += 1;
      await new Promise<void>((resolve) => gates.push(resolve));
      return emptyFleet;
    }) as DevDeps['scan'];
    const nextGate = async (): Promise<() => void> => {
      while (gates.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return gates.shift()!;
    };

    const sessionPromise = runDev({ cwd: '/virtual' }, io, {
      makeProvider: () => provider,
      watch: watch.source,
      scan,
    });
    (await nextGate())(); // release the initial converge
    const session = await sessionPromise;
    expect(scans).toBe(1);

    // A synchronous burst of events queues exactly ONE follow-up cycle…
    watch.fire();
    watch.fire();
    watch.fire();
    const gateA = await nextGate(); // …which is now in flight (scan blocked)
    expect(scans).toBe(2);

    // …and events landing mid-cycle collapse onto one more trailing cycle.
    watch.fire();
    watch.fire();
    gateA();
    (await nextGate())();
    await session.idle();

    expect(scans).toBe(3); // initial + one per coalesced burst — not one per event
    session.stop();
  });
});

describe('dev types', () => {
  test('converge / runDev signatures', () => {
    expectTypeOf(converge).parameter(0).toEqualTypeOf<DevArgs>();
    expectTypeOf(converge).parameter(1).toEqualTypeOf<DevIO>();
    expectTypeOf<DevArgs['environment']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReturnType<WatchSource>>().toEqualTypeOf<WatchHandle>();
    // makeProvider produces a real StateProvider seam
    expectTypeOf<StateProvider>().toMatchTypeOf<StateProvider>();
  });
});
