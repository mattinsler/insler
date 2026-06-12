import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import type { CallInput, ServiceCall } from './calls.js';
import { defineService } from './define-service.js';
import type { ServiceDef, ServiceDefInput } from './define-service.js';
import type { ExposeConfig, ExposeRoute } from './expose.js';
import * as index from './index.js';
import type { ServiceNeed } from './needs.js';

// A real @insler/rpc/contract definition, used to prove `defineService` works with
// existing contracts (AC7).
const SummarizeContract = Contract.create('summarize', {
  version: '1.0.0',
  methods: {
    summarize: {
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string() }),
    },
  },
});

type SummarizeContract = typeof SummarizeContract;

// A producer contract referenced by a consumer's typed `calls` (0006, AC2).
const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: { input: z.object({ sku: z.string() }), output: z.object({ id: z.string() }) },
  },
});

// --- AC1: `defineService()` exported from `@insler/service` ---

describe('defineService export', () => {
  test('defineService is exported from the package index', () => {
    expect(index.defineService).toBe(defineService);
  });

  test('defineService is a function', () => {
    expect(typeof defineService).toBe('function');
  });
});

// --- AC2 + AC6: typed options; only name/kind/contract required ---

describe('typed options', () => {
  test('accepts the full set of options', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: SummarizeContract,
      needs: ['valkey'],
      calls: ['orders.create'],
      scale: { on: 'queue-depth', min: 0, max: 50 },
      isolation: 'gvisor',
      expose: {
        http: { method: 'POST', path: '/summary', stream: 'sse' },
      },
    });

    expect(def.name).toBe('summarize');
    expect(def.kind).toBe('ephemeral');
    expect(def.contract).toBe(SummarizeContract);
    expect(def.needs).toEqual(['valkey']);
    expect(def.calls).toEqual(['orders.create']);
    expect(def.scale).toEqual({ on: 'queue-depth', min: 0, max: 50 });
    expect(def.isolation).toBe('gvisor');
    expect(def.expose).toEqual({ http: { method: 'POST', path: '/summary', stream: 'sse' } });
  });

  test('accepts the minimal set (only name, kind, contract)', () => {
    const def = defineService({
      name: 'minimal',
      kind: 'ephemeral',
      contract: SummarizeContract,
    });

    expect(def.name).toBe('minimal');
    expect(def.kind).toBe('ephemeral');
    expect(def.contract).toBe(SummarizeContract);
    expect(def.needs).toBeUndefined();
    expect(def.calls).toBeUndefined();
    expect(def.scale).toBeUndefined();
    expect(def.isolation).toBeUndefined();
    expect(def.expose).toBeUndefined();
  });

  test('name, kind, contract are required; the rest are optional (type level)', () => {
    // Required keys present in the input type.
    expectTypeOf<ServiceDefInput<SummarizeContract>>().toHaveProperty('name');
    expectTypeOf<ServiceDefInput<SummarizeContract>>().toHaveProperty('kind');
    expectTypeOf<ServiceDefInput<SummarizeContract>>().toHaveProperty('contract');

    // Optional keys are optional.
    expectTypeOf<ServiceDefInput<SummarizeContract>>()
      .toHaveProperty('needs')
      .toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<ServiceDefInput<SummarizeContract>>()
      .toHaveProperty('calls')
      .toEqualTypeOf<readonly CallInput[] | undefined>();
    expectTypeOf<ServiceDefInput<SummarizeContract>>()
      .toHaveProperty('isolation')
      .toEqualTypeOf<'default' | 'gvisor' | 'microvm' | undefined>();
  });

  test('omitting a required field is a compile error (type level)', () => {
    // @ts-expect-error name is required
    defineService({ kind: 'ephemeral', contract: SummarizeContract });

    // @ts-expect-error kind is required
    defineService({ name: 'x', contract: SummarizeContract });

    // @ts-expect-error contract is required
    defineService({ name: 'x', kind: 'ephemeral' });
  });
});

// --- AC4: TypeScript validates the declaration at compile time ---

describe('compile-time validation (negative type guarantees)', () => {
  test('an invalid kind is rejected', () => {
    defineService({
      name: 'x',
      // @ts-expect-error 'serverless' is not a ServiceKind
      kind: 'serverless',
      contract: SummarizeContract,
    });
  });

  test('a malformed scale signal is rejected', () => {
    defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: SummarizeContract,
      // @ts-expect-error 'memory' is not a valid scaling signal
      scale: { on: 'memory', min: 0, max: 1 },
    });
  });

  test('a non-numeric scale bound is rejected', () => {
    expect(() =>
      defineService({
        name: 'x',
        kind: 'ephemeral',
        contract: SummarizeContract,
        // @ts-expect-error max must be a number
        scale: { on: 'queue-depth', min: 0, max: 'lots' },
      })
    ).toThrow(/integer/);
  });

  test('an invalid isolation tier is rejected', () => {
    defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: SummarizeContract,
      // @ts-expect-error 'none' is not an isolation tier
      isolation: 'none',
    });
  });

  test('an unknown option key is rejected', () => {
    defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: SummarizeContract,
      // @ts-expect-error 'subjects' is not a known option (excess property)
      subjects: ['llm.summarize'],
    });
  });

  test('workflow requires a taskQueue (type level + runtime)', () => {
    const ok = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
    });
    expect(ok.taskQueue).toBe('onboarding');

    // Rejected at compile time AND at declaration time (#0002 lifecycle rules,
    // wired through validateServiceKind for JS callers the types can't reach).
    expect(() =>
      // @ts-expect-error workflow declarations must include a taskQueue
      defineService({
        name: 'onboarding',
        kind: 'workflow',
        contract: SummarizeContract,
      })
    ).toThrow(/taskQueue/);
  });

  test('workflow rejects an empty taskQueue at declaration time', () => {
    expect(() =>
      defineService({
        name: 'onboarding',
        kind: 'workflow',
        contract: SummarizeContract,
        taskQueue: '',
      })
    ).toThrow(/taskQueue/);
  });

  test('ephemeral/persistent must not carry a taskQueue (type level)', () => {
    // @ts-expect-error taskQueue is only valid on workflow services
    defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: SummarizeContract,
      taskQueue: 'nope',
    });
  });
});

// --- AC3: returns a frozen ServiceDef ---

describe('frozen ServiceDef', () => {
  test('the returned object is frozen', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(Object.isFrozen(def)).toBe(true);
  });

  test('mutating a field throws in strict mode', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(() => {
      (def as { name: string }).name = 'mutated';
    }).toThrow();
    expect(def.name).toBe('x');
  });

  test('nested option objects are frozen too', () => {
    const def = defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: SummarizeContract,
      needs: ['valkey'],
      scale: { on: 'queue-depth', min: 0, max: 5 },
      expose: { http: { method: 'POST', path: '/x' } },
    });
    expect(Object.isFrozen(def.scale)).toBe(true);
    expect(Object.isFrozen(def.needs)).toBe(true);
    expect(Object.isFrozen(def.expose)).toBe(true);
    expect(Object.isFrozen(def.expose?.http)).toBe(true);
  });

  test('ServiceDef fields are readonly (type level)', () => {
    expectTypeOf<ServiceDef<SummarizeContract>>().toHaveProperty('name').toEqualTypeOf<string>();
    expectTypeOf<ServiceDef<SummarizeContract>>()
      .toHaveProperty('contract')
      .toEqualTypeOf<SummarizeContract>();
    // every field is readonly (compile-time only — the runtime object is frozen,
    // so an actual assignment would throw; assert there are no writable keys).
    type Def = ServiceDef<SummarizeContract>;
    type WritableKeys<T> = {
      [P in keyof T]-?: Equal<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }> extends true
        ? P
        : never;
    }[keyof T];
    type Equal<X, Y> =
      (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
    expectTypeOf<WritableKeys<Omit<Def, 'toJSON'>>>().toEqualTypeOf<never>();
  });

  test('it carries a discriminant marker', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(def.type).toBe('service');
  });
});

// --- AC5: serializable to JSON for static analysis by the generator ---

describe('JSON serialization for static analysis', () => {
  test('JSON.stringify produces the operational intent without throwing', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: SummarizeContract,
      needs: ['valkey'],
      calls: ['orders.create'],
      scale: { on: 'queue-depth', min: 0, max: 50 },
      isolation: 'gvisor',
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    });

    const json = JSON.parse(JSON.stringify(def));

    expect(json).toEqual({
      type: 'service',
      name: 'summarize',
      kind: 'ephemeral',
      contract: { kind: 'summarize', version: '1.0.0' },
      needs: ['valkey'],
      calls: ['orders.create'],
      scale: { on: 'queue-depth', min: 0, max: 50 },
      isolation: 'gvisor',
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    });
  });

  test('the contract is serialized as a static reference, not its zod schemas', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    const json = JSON.parse(JSON.stringify(def));
    // The live contract (with zod schemas) is NOT what serializes — only its identity.
    expect(json.contract).toEqual({ kind: 'summarize', version: '1.0.0' });
  });

  test('optional fields are omitted from the serialized form when absent', () => {
    const def = defineService({ name: 'minimal', kind: 'ephemeral', contract: SummarizeContract });
    const json = JSON.parse(JSON.stringify(def));
    expect(json).toEqual({
      type: 'service',
      name: 'minimal',
      kind: 'ephemeral',
      contract: { kind: 'summarize', version: '1.0.0' },
    });
  });

  test('workflow serializes its taskQueue', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
    });
    const json = JSON.parse(JSON.stringify(def));
    expect(json.kind).toBe('workflow');
    expect(json.taskQueue).toBe('onboarding');
  });
});

// --- Issue 0005: logical dependency declarations (needs) ---
//
// AC1: `needs` accepted as string[]  AC2: each need produces a typed reference
// on the ServiceDef (`needRefs`)     AC5: duplicate needs are rejected.

describe('0005 — needs: logical dependency declarations', () => {
  test('AC1: needs is accepted as a string[]', () => {
    const def = defineService({
      name: 'session-hub',
      kind: 'persistent',
      contract: SummarizeContract,
      needs: ['orders-db', 'valkey'],
    });
    expect(def.needs).toEqual(['orders-db', 'valkey']);
  });

  test('AC2: each need produces a typed reference on the ServiceDef (needRefs)', () => {
    const def = defineService({
      name: 'session-hub',
      kind: 'persistent',
      contract: SummarizeContract,
      needs: ['orders-db', 'valkey'],
    });
    expect(def.needRefs).toEqual([{ name: 'orders-db' }, { name: 'valkey' }]);
    expect(Object.isFrozen(def.needRefs)).toBe(true);
    expect(Object.isFrozen(def.needRefs[0])).toBe(true);
  });

  test('AC2: needRefs is an empty list when no needs are declared', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(def.needRefs).toEqual([]);
  });

  test('AC2: needRefs is typed readonly ServiceNeed[] (type level)', () => {
    expectTypeOf<ServiceDef<SummarizeContract>>()
      .toHaveProperty('needRefs')
      .toEqualTypeOf<readonly ServiceNeed[]>();
  });

  test('AC5: duplicate needs within a service are rejected (throws)', () => {
    expect(() =>
      defineService({
        name: 'session-hub',
        kind: 'persistent',
        contract: SummarizeContract,
        needs: ['valkey', 'orders-db', 'valkey'],
      })
    ).toThrow(/duplicate/i);
  });

  test('AC5: the rejection names the duplicated need', () => {
    expect(() =>
      defineService({
        name: 'session-hub',
        kind: 'persistent',
        contract: SummarizeContract,
        needs: ['valkey', 'valkey'],
      })
    ).toThrow(/valkey/);
  });

  test('AC5: distinct needs are accepted', () => {
    expect(() =>
      defineService({
        name: 'session-hub',
        kind: 'persistent',
        contract: SummarizeContract,
        needs: ['orders-db', 'valkey', 'neo4j'],
      })
    ).not.toThrow();
  });
});

// --- Issue 0006: cross-service contract declarations (calls) ---
//
// AC1: `calls` accepted as string[] (subject refs)   AC2: each call produces a
// typed reference on the ServiceDef (`callRefs`), and a typed contract
// reference is accepted for compile-time checking    AC4: a call carries only
// the subject/contract — no producer deployment config.

describe('0006 — calls: cross-service contract declarations', () => {
  test('AC1: calls is accepted as a string[] of subject refs', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
      calls: ['orders.create', 'billing.charge'],
    });
    expect(def.calls).toEqual(['orders.create', 'billing.charge']);
  });

  test('AC2: a typed contract reference is accepted and resolved to its subject', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
      calls: [{ contract: OrdersContract, method: 'create' }],
    });
    // The raw `calls` view (and serialized form) is the resolved subject.
    expect(def.calls).toEqual(['orders.create']);
    expect(def.callRefs).toEqual([{ subject: 'orders.create' }]);
  });

  test('AC2: each call produces a typed reference on the ServiceDef (callRefs)', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
      calls: ['orders.create', 'billing.charge'],
    });
    expect(def.callRefs).toEqual([{ subject: 'orders.create' }, { subject: 'billing.charge' }]);
    expect(Object.isFrozen(def.callRefs)).toBe(true);
    expect(Object.isFrozen(def.callRefs[0])).toBe(true);
  });

  test('AC2: callRefs is an empty list when no calls are declared', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(def.callRefs).toEqual([]);
  });

  test('AC2: callRefs is typed readonly ServiceCall[] (type level)', () => {
    expectTypeOf<ServiceDef<SummarizeContract>>()
      .toHaveProperty('callRefs')
      .toEqualTypeOf<readonly ServiceCall[]>();
  });

  test('AC2: calls input accepts string | ContractCallRef (type level)', () => {
    expectTypeOf<ServiceDefInput<SummarizeContract>>()
      .toHaveProperty('calls')
      .toEqualTypeOf<readonly CallInput[] | undefined>();
  });

  test('AC2: a contract reference to a non-existent method is a compile error (type level)', () => {
    defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
      // @ts-expect-error 'nope' is not a method on OrdersContract
      calls: [{ contract: OrdersContract, method: 'nope' }],
    });
  });

  test('AC4: a call reference is purely the subject — no deployment fields (type level)', () => {
    expectTypeOf<ServiceCall>().toEqualTypeOf<{ readonly subject: string }>();
  });

  test('duplicate calls within a service are rejected (throws, names the subject)', () => {
    expect(() =>
      defineService({
        name: 'onboarding',
        kind: 'workflow',
        contract: SummarizeContract,
        taskQueue: 'onboarding',
        calls: ['orders.create', 'billing.charge', 'orders.create'],
      })
    ).toThrow(/orders\.create/);
  });

  test('a string and a contract reference to the same subject collide (throws)', () => {
    expect(() =>
      defineService({
        name: 'onboarding',
        kind: 'workflow',
        contract: SummarizeContract,
        taskQueue: 'onboarding',
        calls: ['orders.create', { contract: OrdersContract, method: 'create' }],
      })
    ).toThrow(/duplicate/i);
  });

  test('distinct calls are accepted', () => {
    expect(() =>
      defineService({
        name: 'onboarding',
        kind: 'workflow',
        contract: SummarizeContract,
        taskQueue: 'onboarding',
        calls: ['orders.create', 'billing.charge'],
      })
    ).not.toThrow();
  });

  test('calls serializes to its resolved subject strings (JSON-safe, AC4)', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: SummarizeContract,
      taskQueue: 'onboarding',
      calls: [{ contract: OrdersContract, method: 'create' }, 'billing.charge'],
    });
    const json = JSON.parse(JSON.stringify(def));
    // No zod schemas / producer config leak through — only subjects.
    expect(json.calls).toEqual(['orders.create', 'billing.charge']);
  });
});

// --- Issue 0007: external transport annotations (expose) ---
//
// AC1: `expose` accepted with typed transport options   AC2: HTTP expose supports
// method, path, handler, stream                          AC3: WebSocket expose is a
// transport option                                       AC4: expose blocks project
// to a flat route list (`exposeRoutes`) for routing-table derivation (#0014)
// AC5: duplicate routes within a service are rejected    AC6: expose does not change
// the service's kind or NATS behavior.

describe('0007 — expose: external transport annotations', () => {
  test('AC1/AC2: a single http route is accepted with method, path, stream', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: SummarizeContract,
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    });
    expect(def.expose).toEqual({ http: { method: 'POST', path: '/summary', stream: 'sse' } });
  });

  test('AC2: a list of http routes with handler (method name) is accepted', () => {
    const def = defineService({
      name: 'orders',
      kind: 'persistent',
      contract: SummarizeContract,
      expose: {
        http: [
          { method: 'POST', path: '/orders', handler: 'create' },
          { method: 'GET', path: '/orders/:id', handler: 'get' },
        ],
      },
    });
    expect(def.exposeRoutes).toEqual([
      { transport: 'http', method: 'POST', path: '/orders', handler: 'create' },
      { transport: 'http', method: 'GET', path: '/orders/:id', handler: 'get' },
    ]);
  });

  test('AC3: a websocket endpoint is accepted as a transport option', () => {
    const def = defineService({
      name: 'live',
      kind: 'persistent',
      contract: SummarizeContract,
      expose: { websocket: { path: '/live', handler: 'subscribe' } },
    });
    expect(def.exposeRoutes).toEqual([
      { transport: 'websocket', path: '/live', handler: 'subscribe' },
    ]);
  });

  test('AC4: expose projects to a flat exposeRoutes list on the ServiceDef', () => {
    const def = defineService({
      name: 'orders',
      kind: 'persistent',
      contract: SummarizeContract,
      expose: {
        http: { method: 'POST', path: '/orders' },
        websocket: { path: '/orders/live' },
      },
    });
    expect(def.exposeRoutes).toEqual([
      { transport: 'http', method: 'POST', path: '/orders' },
      { transport: 'websocket', path: '/orders/live' },
    ]);
    expect(Object.isFrozen(def.exposeRoutes)).toBe(true);
    expect(Object.isFrozen(def.exposeRoutes[0])).toBe(true);
  });

  test('AC4: exposeRoutes is an empty list when nothing is exposed', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expect(def.exposeRoutes).toEqual([]);
  });

  test('AC4: exposeRoutes is typed readonly ExposeRoute[] (type level)', () => {
    expectTypeOf<ServiceDef<SummarizeContract>>()
      .toHaveProperty('exposeRoutes')
      .toEqualTypeOf<readonly ExposeRoute[]>();
  });

  test('AC5: duplicate (method, path) routes within a service are rejected (throws)', () => {
    expect(() =>
      defineService({
        name: 'orders',
        kind: 'persistent',
        contract: SummarizeContract,
        expose: {
          http: [
            { method: 'GET', path: '/orders/:id' },
            { method: 'GET', path: '/orders/:id' },
          ],
        },
      })
    ).toThrow(/duplicate/i);
  });

  test('AC5: same path under different methods is accepted', () => {
    expect(() =>
      defineService({
        name: 'orders',
        kind: 'persistent',
        contract: SummarizeContract,
        expose: {
          http: [
            { method: 'GET', path: '/orders' },
            { method: 'POST', path: '/orders' },
          ],
        },
      })
    ).not.toThrow();
  });

  test('AC6: expose is orthogonal to kind — an ephemeral service can be exposed', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: SummarizeContract,
      expose: { http: { method: 'POST', path: '/summary' } },
    });
    // Declaring exposure leaves the kind untouched.
    expect(def.kind).toBe('ephemeral');
  });

  test('AC6: exposing a service does not add the route to its NATS serialized view beyond expose', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: SummarizeContract,
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    });
    const json = JSON.parse(JSON.stringify(def));
    // The contract identity (the NATS subject root) is unchanged by expose, and
    // expose serializes verbatim — it is annotation, not protocol.
    expect(json.contract).toEqual({ kind: 'summarize', version: '1.0.0' });
    expect(json.kind).toBe('ephemeral');
    expect(json.expose).toEqual({ http: { method: 'POST', path: '/summary', stream: 'sse' } });
  });

  test('AC1/AC3: ExposeConfig input type accepts http (single/list) and websocket (type level)', () => {
    expectTypeOf<ServiceDefInput<SummarizeContract>>()
      .toHaveProperty('expose')
      .toEqualTypeOf<ExposeConfig | undefined>();
  });
});

// --- AC7: works with existing @insler/rpc/contract definitions; live contract retained ---

describe('integration with @insler/rpc/contract', () => {
  test('retains the live contract object for runtime feeding into Service.create', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    // Same reference — the runtime path needs the real contract (zod schemas intact).
    expect(def.contract).toBe(SummarizeContract);
    expect(def.contract.methods.summarize.kind).toBe('unary');
  });

  test('the contract type is preserved on the ServiceDef (type level)', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: SummarizeContract });
    expectTypeOf(def.contract).toEqualTypeOf<SummarizeContract>();
  });
});
