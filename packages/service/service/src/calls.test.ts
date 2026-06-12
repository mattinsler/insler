import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import {
  type CallInput,
  type ContractCallRef,
  type ServiceCall,
  toCallSubjects,
  toServiceCalls,
  validateCalls,
} from './calls.js';
import * as index from './index.js';

// Issue 0006 — Cross-service contract declarations (calls).
//
// Scope of THIS layer (the cross-service contract declaration model):
//   AC1 — `calls` accepted in `defineService` as `string[]` (subject refs)      (define-service.test.ts + here)
//   AC2 — optionally accepts TYPED CONTRACT references for compile-time checking (this file + define-service.test.ts)
//   AC4 — no deployment config of a producer leaks into a consumer's `calls`;
//          a call reference is purely the subject/contract (this file)
//
// Downstream (owned by their named issues, gated on #0006 — NOT built here):
//   AC3 — generator cross-references calls against known subjects -> service graph #0010
//   AC5 — calls visible in the service graph                      -> #0010
//   (contract-version compatibility enforcement across the fleet  -> #0030)

// A real producer contract whose `kind` is the subject root.
const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: { input: z.object({ sku: z.string() }), output: z.object({ id: z.string() }) },
  },
});

const BillingContract = Contract.create('billing', {
  version: '2.0.0',
  methods: {
    charge: { input: z.object({ amount: z.number() }), output: z.void() },
  },
});

// --- AC1 / AC2: the typed reference model (callRefs) ---

describe('ServiceCall typed reference', () => {
  test('toServiceCalls maps each raw subject string to a typed reference (AC1)', () => {
    const calls = toServiceCalls(['orders.create', 'billing.charge']);
    expect(calls).toEqual([{ subject: 'orders.create' }, { subject: 'billing.charge' }]);
  });

  test('toServiceCalls resolves a typed contract reference to {kind}.{method} (AC2)', () => {
    const calls = toServiceCalls([
      { contract: OrdersContract, method: 'create' },
      { contract: BillingContract, method: 'charge' },
    ]);
    expect(calls).toEqual([{ subject: 'orders.create' }, { subject: 'billing.charge' }]);
  });

  test('a mixed string + contract-reference list resolves consistently', () => {
    const calls = toServiceCalls([
      'orders.create',
      { contract: BillingContract, method: 'charge' },
    ]);
    expect(calls).toEqual([{ subject: 'orders.create' }, { subject: 'billing.charge' }]);
  });

  test('an empty / undefined declaration yields an empty reference list', () => {
    expect(toServiceCalls([])).toEqual([]);
    expect(toServiceCalls(undefined)).toEqual([]);
  });

  test('each produced reference is frozen', () => {
    const calls = toServiceCalls(['orders.create']);
    expect(Object.isFrozen(calls)).toBe(true);
    expect(Object.isFrozen(calls[0])).toBe(true);
  });

  test('ServiceCall carries the subject and nothing physical — type level (AC4)', () => {
    expectTypeOf<ServiceCall>().toEqualTypeOf<{ readonly subject: string }>();
  });

  test('a call reference is purely the subject — no replica/deployment/secret fields (AC4)', () => {
    const [call] = toServiceCalls([{ contract: OrdersContract, method: 'create' }]);
    expect(Object.keys(call!)).toEqual(['subject']);
  });

  test('toServiceCalls returns readonly ServiceCall[] (type level)', () => {
    expectTypeOf(toServiceCalls(['x'])).toEqualTypeOf<readonly ServiceCall[]>();
  });

  test('CallInput accepts a string or a typed ContractCallRef (type level, AC1+AC2)', () => {
    expectTypeOf<string>().toMatchTypeOf<CallInput>();
    expectTypeOf<ContractCallRef>().toMatchTypeOf<CallInput>();
  });
});

// --- the JSON-serializable subject projection ---

describe('toCallSubjects — JSON-safe subject strings', () => {
  test('reduces both forms to plain subject strings', () => {
    expect(
      toCallSubjects(['orders.create', { contract: BillingContract, method: 'charge' }])
    ).toEqual(['orders.create', 'billing.charge']);
  });

  test('empty / undefined yields an empty frozen list', () => {
    expect(toCallSubjects(undefined)).toEqual([]);
    expect(Object.isFrozen(toCallSubjects(undefined))).toBe(true);
  });

  test('a resolved subject list is JSON-serializable (no zod schemas leak through)', () => {
    const subjects = toCallSubjects([{ contract: OrdersContract, method: 'create' }]);
    expect(JSON.parse(JSON.stringify(subjects))).toEqual(['orders.create']);
  });
});

// --- duplicate / malformed rejection ---

describe('validateCalls — duplicate & malformed rejection', () => {
  test('returns no issues for distinct calls', () => {
    expect(validateCalls(['orders.create', 'billing.charge'])).toEqual([]);
  });

  test('returns no issues for an empty / undefined declaration', () => {
    expect(validateCalls([])).toEqual([]);
    expect(validateCalls(undefined)).toEqual([]);
  });

  test('reports a duplicate call by subject', () => {
    const issues = validateCalls(['orders.create', 'billing.charge', 'orders.create']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('orders.create');
    expect(issues[0]).toContain('duplicate');
  });

  test('a string and a contract reference resolving to the SAME subject collide', () => {
    const issues = validateCalls(['orders.create', { contract: OrdersContract, method: 'create' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('orders.create');
    expect(issues[0]).toContain('duplicate');
  });

  test('reports each distinct duplicated subject once', () => {
    const issues = validateCalls(['a.x', 'a.x', 'b.y', 'b.y', 'b.y', 'c.z']);
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('a.x');
    expect(issues.join('\n')).toContain('b.y');
    expect(issues.join('\n')).not.toContain("'c.z' is declared");
  });

  test('rejects an empty / whitespace subject as malformed', () => {
    const issues = validateCalls(['']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('malformed');
  });

  test('validateCalls returns string[] mirroring validateNeeds (type level)', () => {
    expectTypeOf(validateCalls(['x'])).toEqualTypeOf<string[]>();
  });
});

// --- the calls model is re-exported from the package index ---

describe('package index re-exports the calls model', () => {
  test('toServiceCalls, toCallSubjects and validateCalls are exported', () => {
    expect(index.toServiceCalls).toBe(toServiceCalls);
    expect(index.toCallSubjects).toBe(toCallSubjects);
    expect(index.validateCalls).toBe(validateCalls);
  });
});
