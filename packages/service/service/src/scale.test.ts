import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { defineService } from './define-service.js';
import * as index from './index.js';
import {
  type ResolvedScaleConfig,
  type ScaleConfig,
  type ScaleSignal,
  resolveScale,
  validateScale,
} from './scale.js';

// Issue 0008 — Scale configuration model.
//
// Scope of THIS layer (`@insler/service`): the scale TYPE, kind-derived
// DEFAULTS, and cross-field VALIDATION, plus resolution of the effective scale
// onto the `ServiceDef`. The kind taxonomy (#0002, kind.ts) already fixed the
// per-kind default signal + replica floor; this layer owns the richer `on`
// enum (incl. rps/custom), the default-from-kind derivation, and the validation
// rules.
//   AC1 — `ScaleConfig` type with on/min/max fields                  (this file)
//   AC2 — `on` accepts queue-depth/cpu/task-queue-backlog/rps/custom (this file)
//   AC3 — default scale config derived from kind when omitted        (this file: resolveScale + defineService.effectiveScale)
//   AC4 — persistent and workflow reject min:0                       (this file: validateScale + defineService throws)
//   AC5 — ephemeral allows min:0 and defaults to it                  (this file)
//
// Out of scope here (owned by the named issue, gated on #0008 — NOT built here):
//   AC6 — generator produces a KEDA ScaledObject / HPA from the scale config -> #0013

const Summarize = Contract.create('summarize', {
  version: '1.0.0',
  methods: {
    run: { input: z.object({ text: z.string() }), output: z.object({ out: z.string() }) },
  },
});

// --- AC1 / AC2: the ScaleConfig type ---

describe('ScaleConfig type (AC1, AC2)', () => {
  test('ScaleConfig carries on, optional min, optional max (type level)', () => {
    expectTypeOf<ScaleConfig>().toHaveProperty('on').toEqualTypeOf<ScaleSignal>();
    expectTypeOf<ScaleConfig>().toHaveProperty('min').toEqualTypeOf<number | undefined>();
    expectTypeOf<ScaleConfig>().toHaveProperty('max').toEqualTypeOf<number | undefined>();
  });

  test('ScaleSignal enumerates the five supported signals (type level, AC2)', () => {
    expectTypeOf<ScaleSignal>().toEqualTypeOf<
      'queue-depth' | 'cpu' | 'task-queue-backlog' | 'rps' | 'custom'
    >();
  });

  test('ScaleConfig is re-exported from the package index', () => {
    expectTypeOf<index.ScaleConfig>().toEqualTypeOf<ScaleConfig>();
  });

  test('the resolved (effective) scale always carries on and min (type level, AC3)', () => {
    expectTypeOf<ResolvedScaleConfig>().toHaveProperty('on').toEqualTypeOf<ScaleSignal>();
    expectTypeOf<ResolvedScaleConfig>().toHaveProperty('min').toEqualTypeOf<number>();
    expectTypeOf<ResolvedScaleConfig>().toHaveProperty('max').toEqualTypeOf<number | undefined>();
  });
});

// --- AC2: every signal in the enum is accepted at the type level ---

describe('the on enum accepts each signal (type level, AC2)', () => {
  test('queue-depth / cpu / task-queue-backlog / rps / custom all type-check', () => {
    expectTypeOf<{ on: 'queue-depth' }>().toMatchTypeOf<ScaleConfig>();
    expectTypeOf<{ on: 'cpu' }>().toMatchTypeOf<ScaleConfig>();
    expectTypeOf<{ on: 'task-queue-backlog' }>().toMatchTypeOf<ScaleConfig>();
    expectTypeOf<{ on: 'rps' }>().toMatchTypeOf<ScaleConfig>();
    expectTypeOf<{ on: 'custom' }>().toMatchTypeOf<ScaleConfig>();
  });

  test('an unknown signal is rejected at the declaration site (type level)', () => {
    defineService({
      name: 'x',
      kind: 'persistent',
      contract: Summarize,
      // @ts-expect-error 'memory' is not a valid scaling signal
      scale: { on: 'memory' },
    });
  });

  test('a non-numeric bound is rejected at the declaration site (type level + runtime)', () => {
    expect(() =>
      defineService({
        name: 'x',
        kind: 'ephemeral',
        contract: Summarize,
        // @ts-expect-error min must be a number
        scale: { on: 'queue-depth', min: 'lots' },
      })
    ).toThrow(/integer/);
  });
});

// --- AC3: default scale config derived from kind when scale is omitted ---

describe('resolveScale derives a default from kind when scale is omitted (AC3)', () => {
  test('ephemeral defaults to queue-depth with min 0', () => {
    expect(resolveScale('ephemeral', undefined)).toEqual({ on: 'queue-depth', min: 0 });
  });

  test('persistent defaults to cpu with min 1', () => {
    expect(resolveScale('persistent', undefined)).toEqual({ on: 'cpu', min: 1 });
  });

  test('workflow defaults to task-queue-backlog with min 1', () => {
    expect(resolveScale('workflow', undefined)).toEqual({ on: 'task-queue-backlog', min: 1 });
  });

  test('an explicit scale overrides the kind default but keeps the kind floor when min omitted', () => {
    // explicit `on` wins
    expect(resolveScale('persistent', { on: 'rps' })).toEqual({ on: 'rps', min: 1 });
    // explicit `min` wins
    expect(resolveScale('ephemeral', { on: 'queue-depth', min: 2 })).toEqual({
      on: 'queue-depth',
      min: 2,
    });
    // explicit `max` is carried through
    expect(resolveScale('persistent', { on: 'cpu', min: 2, max: 8 })).toEqual({
      on: 'cpu',
      min: 2,
      max: 8,
    });
  });

  test('the resolved config is frozen', () => {
    expect(Object.isFrozen(resolveScale('ephemeral', undefined))).toBe(true);
  });
});

// --- AC3 wired through defineService: effectiveScale is always present ---

describe('defineService resolves an effectiveScale onto the ServiceDef (AC3)', () => {
  test('ephemeral with no scale gets the ephemeral default', () => {
    const def = defineService({ name: 'summarize', kind: 'ephemeral', contract: Summarize });
    expect(def.effectiveScale).toEqual({ on: 'queue-depth', min: 0 });
  });

  test('persistent with no scale gets the persistent default (min 1)', () => {
    const def = defineService({ name: 'session-hub', kind: 'persistent', contract: Summarize });
    expect(def.effectiveScale).toEqual({ on: 'cpu', min: 1 });
  });

  test('workflow with no scale gets the workflow default (task-queue-backlog, min 1)', () => {
    const def = defineService({
      name: 'onboarding',
      kind: 'workflow',
      contract: Summarize,
      taskQueue: 'onboarding',
    });
    expect(def.effectiveScale).toEqual({ on: 'task-queue-backlog', min: 1 });
  });

  test('an explicit scale is reflected in effectiveScale', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: Summarize,
      scale: { on: 'queue-depth', min: 0, max: 50 },
    });
    expect(def.effectiveScale).toEqual({ on: 'queue-depth', min: 0, max: 50 });
  });

  test('the raw declared scale is still surfaced as-declared (undefined when omitted)', () => {
    const omitted = defineService({ name: 'a', kind: 'ephemeral', contract: Summarize });
    expect(omitted.scale).toBeUndefined();

    const declared = defineService({
      name: 'b',
      kind: 'persistent',
      contract: Summarize,
      scale: { on: 'cpu', min: 2, max: 8 },
    });
    expect(declared.scale).toEqual({ on: 'cpu', min: 2, max: 8 });
  });

  test('effectiveScale is frozen on the ServiceDef', () => {
    const def = defineService({ name: 'x', kind: 'persistent', contract: Summarize });
    expect(Object.isFrozen(def.effectiveScale)).toBe(true);
  });
});

// --- AC4 / AC5: validation per kind ---

describe('validateScale enforces the per-kind replica floor (AC4, AC5)', () => {
  test('persistent rejects min:0 (AC4)', () => {
    const issues = validateScale('persistent', { on: 'cpu', min: 0 });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(' ')).toContain('persistent');
  });

  test('workflow rejects min:0 (AC4)', () => {
    const issues = validateScale('workflow', { on: 'task-queue-backlog', min: 0 });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(' ')).toContain('workflow');
  });

  test('persistent accepts min >= 1', () => {
    expect(validateScale('persistent', { on: 'cpu', min: 1 })).toEqual([]);
    expect(validateScale('persistent', { on: 'cpu', min: 3 })).toEqual([]);
  });

  test('workflow accepts min >= 1', () => {
    expect(validateScale('workflow', { on: 'task-queue-backlog', min: 1 })).toEqual([]);
  });

  test('ephemeral allows min:0 (AC5)', () => {
    expect(validateScale('ephemeral', { on: 'queue-depth', min: 0 })).toEqual([]);
  });

  test('ephemeral allows min > 0 (warm pool)', () => {
    expect(validateScale('ephemeral', { on: 'queue-depth', min: 2 })).toEqual([]);
  });

  test('a negative min is rejected for every kind', () => {
    expect(validateScale('ephemeral', { on: 'queue-depth', min: -1 }).length).toBeGreaterThan(0);
    expect(validateScale('persistent', { on: 'cpu', min: -1 }).length).toBeGreaterThan(0);
  });

  test('max below min is rejected', () => {
    const issues = validateScale('persistent', { on: 'cpu', min: 5, max: 2 });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('fractional replica counts are rejected (they would flow into KEDA/HPA YAML)', () => {
    expect(validateScale('persistent', { on: 'cpu', min: 1.5 }).join(' ')).toContain('integer');
    expect(validateScale('persistent', { on: 'cpu', min: 1, max: 2.5 }).join(' ')).toContain(
      'integer'
    );
    expect(validateScale('ephemeral', { on: 'queue-depth', min: 0.5 }).length).toBeGreaterThan(0);
  });

  test('integer bounds remain valid', () => {
    expect(validateScale('persistent', { on: 'cpu', min: 1, max: 10 })).toEqual([]);
  });

  test('omitting scale is valid for every kind (defaults apply)', () => {
    expect(validateScale('ephemeral', undefined)).toEqual([]);
    expect(validateScale('persistent', undefined)).toEqual([]);
    expect(validateScale('workflow', undefined)).toEqual([]);
  });
});

// --- AC4 / AC5 wired through defineService (runtime throws / accepts) ---

describe('defineService enforces scale validation (AC4, AC5)', () => {
  test('persistent with min:0 throws (AC4)', () => {
    expect(() =>
      defineService({
        name: 'x',
        kind: 'persistent',
        contract: Summarize,
        scale: { on: 'cpu', min: 0 },
      })
    ).toThrow();
  });

  test('workflow with min:0 throws (AC4)', () => {
    expect(() =>
      defineService({
        name: 'x',
        kind: 'workflow',
        contract: Summarize,
        taskQueue: 'q',
        scale: { on: 'task-queue-backlog', min: 0 },
      })
    ).toThrow();
  });

  test('ephemeral with min:0 is accepted and defaults to it (AC5)', () => {
    const def = defineService({
      name: 'x',
      kind: 'ephemeral',
      contract: Summarize,
      scale: { on: 'queue-depth', min: 0 },
    });
    expect(def.effectiveScale.min).toBe(0);
  });

  test('ephemeral with scale omitted defaults to min 0 (AC5)', () => {
    const def = defineService({ name: 'x', kind: 'ephemeral', contract: Summarize });
    expect(def.effectiveScale.min).toBe(0);
  });
});
