import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from './manifest.js';
import type {
  FleetEdge,
  FleetError,
  FleetManifest,
  FleetResult,
  FleetRoute,
  ScannedService,
} from './manifest.js';

// Real @insler/rpc/contract + @insler/service declarations — the scanner evaluates
// actual ServiceDefs, so the builder is tested against the real model.
const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: { input: z.object({ sku: z.string() }), output: z.object({ id: z.string() }) },
  },
});

const orders = defineService({
  name: 'orders',
  kind: 'persistent',
  contract: OrdersContract,
  needs: ['orders-db'],
  expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
});

const checkout = defineService({
  name: 'checkout',
  kind: 'ephemeral',
  contract: Contract.create('checkout', {
    version: '1.0.0',
    methods: { start: { input: z.object({ cart: z.string() }), output: z.void() } },
  }),
  needs: ['valkey'],
  calls: ['orders.create'],
  expose: { http: { method: 'POST', path: '/checkout', handler: 'start' } },
});

/** Pair a def with a synthetic file path for location-bearing assertions. */
function located(service: ServiceDef, file: string): ScannedService {
  return { service, file };
}

// --- AC2: produce a complete FleetManifest from scanned declarations ---

describe('buildFleetManifest — complete manifest (AC2)', () => {
  test('collects every scanned service in discovery order', () => {
    const result = buildFleetManifest([
      located(orders, '/fleet/orders.def.ts'),
      located(checkout, '/fleet/checkout.service.ts'),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.services.map((s) => s.name)).toEqual(['orders', 'checkout']);
  });

  test('an empty fleet is valid and produces an empty manifest', () => {
    const result = buildFleetManifest([]);
    expect(result.errors).toEqual([]);
    expect(result.manifest).toEqual({
      services: [],
      graph: { edges: [] },
      expose: { routes: [] },
    });
  });
});

// --- AC5: dependency graph from `calls` and `needs` ---

describe('buildFleetManifest — dependency graph (AC5)', () => {
  test('emits one `needs` edge per declared need, targeting the logical name', () => {
    const result = buildFleetManifest([located(orders, '/a.def.ts')]);
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'orders',
      to: 'orders-db',
      type: 'needs',
    } satisfies FleetEdge);
  });

  test('resolves a `calls` edge to the producing service by subject', () => {
    const result = buildFleetManifest([
      located(orders, '/orders.def.ts'),
      located(checkout, '/checkout.def.ts'),
    ]);
    expect(result.manifest?.graph.edges).toContainEqual({
      from: 'checkout',
      to: 'orders',
      type: 'calls',
    } satisfies FleetEdge);
  });

  test('graph carries both calls and needs edges together', () => {
    const result = buildFleetManifest([
      located(orders, '/orders.def.ts'),
      located(checkout, '/checkout.def.ts'),
    ]);
    const edges = result.manifest?.graph.edges ?? [];
    expect(edges).toContainEqual({ from: 'orders', to: 'orders-db', type: 'needs' });
    expect(edges).toContainEqual({ from: 'checkout', to: 'valkey', type: 'needs' });
    expect(edges).toContainEqual({ from: 'checkout', to: 'orders', type: 'calls' });
  });
});

// --- AC4 (manifest projection): expose routes flattened across the fleet ---

describe('buildFleetManifest — expose routes', () => {
  test('flattens every service expose block, tagged with the owning service', () => {
    const result = buildFleetManifest([
      located(orders, '/orders.def.ts'),
      located(checkout, '/checkout.def.ts'),
    ]);
    expect(result.manifest?.expose.routes).toContainEqual({
      path: '/orders',
      method: 'POST',
      service: 'orders',
      handler: 'create',
      transport: 'http',
    } satisfies FleetRoute);
    expect(result.manifest?.expose.routes).toContainEqual({
      path: '/checkout',
      method: 'POST',
      service: 'checkout',
      handler: 'start',
      transport: 'http',
    } satisfies FleetRoute);
  });
});

// --- AC3: unique service names, reported with file locations (AC6) ---

describe('buildFleetManifest — unique service names (AC3, AC6)', () => {
  test('rejects two services sharing a name and names both files', () => {
    const dupA = defineService({
      name: 'collision',
      kind: 'ephemeral',
      contract: Contract.create('alpha', { version: '1.0.0', methods: { ping: {} } }),
    });
    const dupB = defineService({
      name: 'collision',
      kind: 'ephemeral',
      contract: Contract.create('beta', { version: '1.0.0', methods: { ping: {} } }),
    });

    const result = buildFleetManifest([located(dupA, '/a.def.ts'), located(dupB, '/b.def.ts')]);

    expect(result.manifest).toBeUndefined();
    const dup = result.errors.find((e) => e.kind === 'duplicate-service-name');
    expect(dup).toBeDefined();
    expect(dup?.message).toContain('collision');
    expect(dup?.files).toEqual(['/a.def.ts', '/b.def.ts']);
  });
});

// --- 0004 AC3: unique service identity across all scanned declarations ---
//
// Identity (`@insler/service`'s deriveIdentity) is environment.namespace.name.
// The fleet enforces that no two scanned declarations derive the same identity —
// the cross-fleet half of the identity model (the type + derivation live in
// `@insler/service`; downstream consumers #0012/#0015/#0016 are out of scope).

describe('buildFleetManifest — unique service identity (0004 AC3, AC6)', () => {
  test('rejects two services whose derived identities collide, naming both files', () => {
    // Distinct names that derive to the SAME qualified identity:
    // 'orders.summarize' -> ns 'orders', name 'summarize'
    // a second 'orders.summarize' under a different contract collides on identity.
    const a = defineService({
      name: 'orders.summarize',
      kind: 'ephemeral',
      contract: Contract.create('alpha', { version: '1.0.0', methods: { run: {} } }),
    });
    const b = defineService({
      name: 'orders.summarize',
      kind: 'ephemeral',
      contract: Contract.create('beta', { version: '1.0.0', methods: { run: {} } }),
    });

    const result = buildFleetManifest([located(a, '/a.def.ts'), located(b, '/b.def.ts')]);

    expect(result.manifest).toBeUndefined();
    const dup = result.errors.find((e) => e.kind === 'duplicate-service-identity');
    expect(dup).toBeDefined();
    expect(dup?.message).toContain('orders.summarize');
    expect([...(dup?.files ?? [])].sort()).toEqual(['/a.def.ts', '/b.def.ts']);
  });

  test('a valid fleet of distinct identities reports no identity error', () => {
    const result = buildFleetManifest([
      located(orders, '/orders.def.ts'),
      located(checkout, '/checkout.def.ts'),
    ]);
    expect(result.errors.find((e) => e.kind === 'duplicate-service-identity')).toBeUndefined();
  });

  test('the identity check is environment-scoped — the supplied environment qualifies the identity', () => {
    const a = defineService({
      name: 'orders.summarize',
      kind: 'ephemeral',
      contract: Contract.create('alpha', { version: '1.0.0', methods: { run: {} } }),
    });
    const b = defineService({
      name: 'orders.summarize',
      kind: 'ephemeral',
      contract: Contract.create('beta', { version: '1.0.0', methods: { run: {} } }),
    });

    // Same collision still fires regardless of the environment the fleet is built for.
    const prod = buildFleetManifest(
      [located(a, '/a.def.ts'), located(b, '/b.def.ts')],
      'production'
    );
    const dev = buildFleetManifest(
      [located(a, '/a.def.ts'), located(b, '/b.def.ts')],
      'development'
    );
    expect(prod.errors.some((e) => e.kind === 'duplicate-service-identity')).toBe(true);
    expect(dev.errors.some((e) => e.kind === 'duplicate-service-identity')).toBe(true);
  });
});

// --- AC4: unique exposed routes, reported with file locations (AC6) ---

describe('buildFleetManifest — unique exposed routes (AC4, AC6)', () => {
  test('rejects two services exposing the same (method, path)', () => {
    const one = defineService({
      name: 'one',
      kind: 'ephemeral',
      contract: Contract.create('one', { version: '1.0.0', methods: { go: {} } }),
      expose: { http: { method: 'GET', path: '/shared' } },
    });
    const two = defineService({
      name: 'two',
      kind: 'ephemeral',
      contract: Contract.create('two', { version: '1.0.0', methods: { go: {} } }),
      expose: { http: { method: 'GET', path: '/shared' } },
    });

    const result = buildFleetManifest([located(one, '/one.def.ts'), located(two, '/two.def.ts')]);

    expect(result.manifest).toBeUndefined();
    const dup = result.errors.find((e) => e.kind === 'duplicate-expose-route');
    expect(dup).toBeDefined();
    expect(dup?.message).toContain('/shared');
    expect([...(dup?.files ?? [])].sort()).toEqual(['/one.def.ts', '/two.def.ts']);
  });

  test('the same path under different methods does not collide', () => {
    const get = defineService({
      name: 'get',
      kind: 'ephemeral',
      contract: Contract.create('get', { version: '1.0.0', methods: { go: {} } }),
      expose: { http: { method: 'GET', path: '/r' } },
    });
    const post = defineService({
      name: 'post',
      kind: 'ephemeral',
      contract: Contract.create('post', { version: '1.0.0', methods: { go: {} } }),
      expose: { http: { method: 'POST', path: '/r' } },
    });

    const result = buildFleetManifest([located(get, '/g.def.ts'), located(post, '/p.def.ts')]);
    expect(result.errors).toEqual([]);
  });
});

// --- calls reference valid subjects, reported with file locations (AC6) ---

describe('buildFleetManifest — calls reference valid subjects (AC6)', () => {
  test('rejects a call whose subject no scanned service serves', () => {
    const consumer = defineService({
      name: 'consumer',
      kind: 'ephemeral',
      contract: Contract.create('consumer', { version: '1.0.0', methods: { run: {} } }),
      calls: ['ghost.method'],
    });

    const result = buildFleetManifest([located(consumer, '/consumer.def.ts')]);

    expect(result.manifest).toBeUndefined();
    const bad = result.errors.find((e) => e.kind === 'unknown-call-subject');
    expect(bad).toBeDefined();
    expect(bad?.message).toContain('ghost.method');
    expect(bad?.files).toEqual(['/consumer.def.ts']);
  });

  test('a call to a subject a scanned service serves is accepted', () => {
    const result = buildFleetManifest([
      located(orders, '/orders.def.ts'),
      located(checkout, '/checkout.def.ts'),
    ]);
    expect(result.errors).toEqual([]);
  });
});

// --- Type-level guarantees ---

describe('FleetManifest types', () => {
  test('the manifest shape matches the issue contract', () => {
    expectTypeOf<FleetManifest['services']>().toEqualTypeOf<readonly ServiceDef[]>();
    expectTypeOf<FleetEdge['type']>().toEqualTypeOf<'calls' | 'needs'>();
    expectTypeOf<FleetResult['manifest']>().toEqualTypeOf<FleetManifest | undefined>();
    expectTypeOf<FleetError['files']>().toEqualTypeOf<readonly string[]>();
  });

  test('buildFleetManifest is pure (takes located services, returns a result)', () => {
    expectTypeOf(buildFleetManifest).parameter(0).toEqualTypeOf<readonly ScannedService[]>();
    expectTypeOf(buildFleetManifest).returns.toEqualTypeOf<FleetResult>();
  });

  test('FleetError kind includes the identity-collision rule (0004 AC3)', () => {
    expectTypeOf<FleetError['kind']>().toEqualTypeOf<
      | 'duplicate-service-name'
      | 'duplicate-service-identity'
      | 'duplicate-expose-route'
      | 'malformed-expose-route'
      | 'unknown-call-subject'
    >();
  });
});
