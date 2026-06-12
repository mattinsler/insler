import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService, deriveIdentity } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

// The declaration role of @insler/service, exercised consumer-grade
// (subsystem-branding issue 0009): a service author wraps a real rpc
// contract in defineService and gets back the frozen, statically-analyzable
// ServiceDef the platform layers consume — projections always present,
// JSON-safe serialization, validation throwing at declaration time, and the
// type-level kind/calls rules holding against the published declaration
// files. All through the published surface, against built dist output.

const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: {
      input: z.object({ sku: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
});

const BillingContract = Contract.create('billing', {
  version: '2.0.0',
  methods: {
    charge: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ receipt: z.string() }),
    },
  },
});

describe('defineService as a consumer', () => {
  test('a full declaration resolves every axis onto the frozen def', () => {
    const def = defineService({
      name: 'orders',
      kind: 'persistent',
      contract: OrdersContract,
      needs: ['orders-db', 'valkey'],
      calls: [{ contract: BillingContract, method: 'charge' }],
      scale: { on: 'cpu', min: 2, max: 10 },
      isolation: 'gvisor',
      expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
    });

    expect(def.type).toBe('service');
    expect(def.kind).toBe('persistent');
    expect(def.contract).toBe(OrdersContract);
    expect(def.calls).toEqual(['billing.charge']);
    expect(def.callRefs).toEqual([{ subject: 'billing.charge' }]);
    expect(def.needRefs.map((n) => n.name)).toEqual(['orders-db', 'valkey']);
    expect(def.effectiveScale).toMatchObject({ on: 'cpu', min: 2, max: 10 });
    expect(def.effectiveIsolation).toBe('gvisor');
    expect(def.exposeRoutes).toHaveLength(1);
  });

  test('the def is deeply frozen — declared intent cannot be mutated downstream', () => {
    const def = defineService({ name: 'orders', kind: 'persistent', contract: OrdersContract });

    expect(Object.isFrozen(def)).toBe(true);
    expect(() => {
      (def as { name: string }).name = 'other';
    }).toThrow();
  });

  test('projections are always present, defaulted from the kind when undeclared', () => {
    const def = defineService({ name: 'minimal', kind: 'ephemeral', contract: OrdersContract });

    expect(def.needs).toBeUndefined();
    expect(def.needRefs).toEqual([]);
    expect(def.callRefs).toEqual([]);
    expect(def.exposeRoutes).toEqual([]);
    // The kind's operational profile applied: ephemeral scales to zero on
    // queue depth.
    expect(def.effectiveScale.min).toBe(0);
    expect(def.effectiveScale.on).toBe('queue-depth');
    expect(def.effectiveIsolation).toBe('default');
  });

  test('toJSON yields the static view: the live contract reduced to its identity', () => {
    const def = defineService({ name: 'orders', kind: 'persistent', contract: OrdersContract });

    const serialized = JSON.parse(JSON.stringify(def));
    expect(serialized.type).toBe('service');
    expect(serialized.contract).toEqual({ kind: 'orders', version: '1.0.0' });
  });

  test('invalid declarations throw at declaration time', () => {
    expect(() =>
      defineService({
        name: 'orders',
        kind: 'persistent',
        contract: OrdersContract,
        scale: { on: 'cpu', min: 0 },
      })
    ).toThrow(/scale/i);

    expect(() =>
      defineService({
        name: 'orders',
        kind: 'persistent',
        contract: OrdersContract,
        needs: ['valkey', 'valkey'],
      })
    ).toThrow(/needs/i);
  });

  test('identity derives deterministically from the declared name and environment', () => {
    const def = defineService({
      name: 'commerce.orders',
      kind: 'persistent',
      contract: OrdersContract,
    });

    const identity = deriveIdentity(def, 'production');
    expect(identity.qualifiedName).toBe('prod.commerce.orders');
    expect(identity.namespace).toBe('commerce');
    expect(deriveIdentity(def, 'production')).toEqual(identity);
  });
});

describe('type-level declaration rules (consumer view)', () => {
  test('workflow requires a taskQueue; the other kinds reject one', () => {
    const wf = defineService({
      name: 'onboarding',
      kind: 'workflow',
      taskQueue: 'onboarding',
      contract: OrdersContract,
    });
    expect(wf.taskQueue).toBe('onboarding');

    expect(() =>
      // @ts-expect-error a workflow declaration requires a taskQueue
      defineService({ name: 'onboarding', kind: 'workflow', contract: OrdersContract })
    ).toThrow();

    defineService(
      // @ts-expect-error an ephemeral declaration must not carry a taskQueue
      {
        name: 'onboarding',
        kind: 'ephemeral',
        taskQueue: 'onboarding',
        contract: OrdersContract,
      }
    );
  });

  test('typed calls reject a method that is not on the referenced contract', () => {
    defineService({
      name: 'orders',
      kind: 'persistent',
      contract: OrdersContract,
      // @ts-expect-error 'refund' is not a method of BillingContract — a typo is a compile error
      calls: [{ contract: BillingContract, method: 'refund' }],
    });
  });

  test('the def carries its discriminating tag for the fleet scanner', () => {
    expectTypeOf<ServiceDef['type']>().toEqualTypeOf<'service'>();
  });
});
