import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type {
  ChangeAction,
  DriftReport,
  Plan,
  Reconciler,
  Resource,
  ResourceChange,
  SetAppliedOptions,
  StateProvider,
} from './types.js';

// --- AC1: a resource carries path, content, and a generator-shaped format ---

describe('Resource contract (AC1)', () => {
  test('a resource is a path + content + format', () => {
    expectTypeOf<Resource['path']>().toEqualTypeOf<string>();
    expectTypeOf<Resource['content']>().toEqualTypeOf<string>();
    expectTypeOf<Resource['format']>().toEqualTypeOf<'yaml' | 'json' | 'toml' | 'text'>();
  });

  test('format rejects an unknown value', () => {
    // @ts-expect-error 'xml' is not a supported resource format
    const _bad: Resource = { path: 'a', content: 'b', format: 'xml' };
    expect(true).toBe(true);
  });
});

// --- AC1/AC2: the changeset distinguishes the four actions ---

describe('ChangeAction + ResourceChange contract (AC1, AC2)', () => {
  test('a change action is one of add/change/destroy/no-op', () => {
    expectTypeOf<ChangeAction>().toEqualTypeOf<'add' | 'change' | 'destroy' | 'no-op'>();
  });

  test('a resource change carries an action, path, format and optional before/after', () => {
    expectTypeOf<ResourceChange['action']>().toEqualTypeOf<ChangeAction>();
    expectTypeOf<ResourceChange['path']>().toEqualTypeOf<string>();
    expectTypeOf<ResourceChange['before']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ResourceChange['after']>().toEqualTypeOf<string | undefined>();
  });
});

// --- AC1/AC3/AC5: the plan shape ---

describe('Plan contract (AC1, AC3, AC5)', () => {
  test('a plan is changes + summary + isNoOp', () => {
    expectTypeOf<Plan['changes']>().toEqualTypeOf<readonly ResourceChange[]>();
    expectTypeOf<Plan['summary']>().toEqualTypeOf<{
      readonly add: number;
      readonly change: number;
      readonly destroy: number;
    }>();
    expectTypeOf<Plan['isNoOp']>().toEqualTypeOf<boolean>();
  });
});

// --- AC4: the drift report shape ---

describe('DriftReport contract (AC4)', () => {
  test('a drift report is hasDrift + drifted paths + a re-converging plan', () => {
    expectTypeOf<DriftReport['hasDrift']>().toEqualTypeOf<boolean>();
    expectTypeOf<DriftReport['drifted']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<DriftReport['plan']>().toEqualTypeOf<Plan>();
  });
});

// --- the actual-state seam (testable with a fake) ---

describe('StateProvider contract', () => {
  test('a provider reads actual + last-applied and records applied state', () => {
    expectTypeOf<StateProvider['getActual']>().returns.resolves.toEqualTypeOf<
      readonly Resource[]
    >();
    expectTypeOf<StateProvider['getLastApplied']>().returns.resolves.toEqualTypeOf<
      readonly Resource[]
    >();
    expectTypeOf<StateProvider['setApplied']>().parameter(0).toEqualTypeOf<readonly Resource[]>();
    expectTypeOf<StateProvider['setApplied']>()
      .parameter(1)
      .toEqualTypeOf<SetAppliedOptions | undefined>();
    expectTypeOf<StateProvider['setApplied']>().returns.resolves.toEqualTypeOf<void>();
    // a drift correction writes actual without rewriting the recorded intent
    expectTypeOf<SetAppliedOptions['preserveLastApplied']>().toEqualTypeOf<boolean | undefined>();
  });
});

// --- the engine surface ---

describe('Reconciler contract (AC1, AC2, AC4, AC7)', () => {
  test('plan diffs desired resources and resolves to a Plan', () => {
    expectTypeOf<Reconciler['plan']>().parameter(0).toEqualTypeOf<readonly Resource[]>();
    expectTypeOf<Reconciler['plan']>().returns.resolves.toEqualTypeOf<Plan>();
  });

  test('detectDrift resolves to a DriftReport', () => {
    expectTypeOf<Reconciler['detectDrift']>().returns.resolves.toEqualTypeOf<DriftReport>();
  });

  test('render takes a Plan and returns a string', () => {
    expectTypeOf<Reconciler['render']>().parameter(0).toEqualTypeOf<Plan>();
    expectTypeOf<Reconciler['render']>().returns.toEqualTypeOf<string>();
  });
});
