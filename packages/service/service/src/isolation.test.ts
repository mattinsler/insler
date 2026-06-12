import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { defineService } from './define-service.js';
import * as index from './index.js';
import { type IsolationTier, resolveIsolation } from './isolation.js';

// Issue 0009 — Isolation tier selection.
//
// Scope of THIS layer (`@insler/service`): the isolation TIER enum, its
// `'default'`-when-omitted resolution, and surfacing the *effective* tier onto
// the `ServiceDef` — mirroring kind/scale/identity. This layer owns ONLY the
// declaration model + its default resolution; it does NOT map a tier to a
// concrete RuntimeClass or validate host capabilities.
//
//   AC1 — `isolation` accepted as 'default' | 'gvisor' | 'microvm'   (this file + define-service.test.ts: type level)
//   AC2 — defaults to 'default' when omitted                         (this file: resolveIsolation + defineService.effectiveIsolation)
//
// Out of scope here (owned by the K8s generator #0012 — gated on #0009, NOT built here):
//   AC3 — generator maps the isolation tier to a Kubernetes RuntimeClass name      -> #0012
//   AC4 — generator validates host capability requirements (microVM needs KVM)     -> #0012

const Summarize = Contract.create('summarize', {
  version: '1.0.0',
  methods: {
    run: { input: z.object({ text: z.string() }), output: z.object({ out: z.string() }) },
  },
});

// --- AC1: the IsolationTier enum ---

describe('IsolationTier enum (AC1)', () => {
  test('enumerates the three supported tiers (type level)', () => {
    expectTypeOf<IsolationTier>().toEqualTypeOf<'default' | 'gvisor' | 'microvm'>();
  });

  test('each tier is assignable to IsolationTier (type level)', () => {
    expectTypeOf<'default'>().toMatchTypeOf<IsolationTier>();
    expectTypeOf<'gvisor'>().toMatchTypeOf<IsolationTier>();
    expectTypeOf<'microvm'>().toMatchTypeOf<IsolationTier>();
  });

  test('IsolationTier is re-exported from the package index', () => {
    expectTypeOf<index.IsolationTier>().toEqualTypeOf<IsolationTier>();
  });
});

// --- AC2: resolveIsolation defaults to 'default' when omitted ---

describe('resolveIsolation defaults to default when omitted (AC2)', () => {
  test('omitted (undefined) resolves to default', () => {
    expect(resolveIsolation(undefined)).toBe('default');
  });

  test('an explicit tier is carried through unchanged', () => {
    expect(resolveIsolation('default')).toBe('default');
    expect(resolveIsolation('gvisor')).toBe('gvisor');
    expect(resolveIsolation('microvm')).toBe('microvm');
  });

  test('the resolved tier is always a concrete IsolationTier (type level)', () => {
    expectTypeOf(resolveIsolation(undefined)).toEqualTypeOf<IsolationTier>();
  });
});

// --- AC2 wired through defineService: effectiveIsolation is always present ---

describe('defineService resolves an effectiveIsolation onto the ServiceDef (AC2)', () => {
  test('a service with no isolation declared gets the default tier', () => {
    const def = defineService({ name: 'summarize', kind: 'ephemeral', contract: Summarize });
    expect(def.effectiveIsolation).toBe('default');
  });

  test('an explicit tier is reflected in effectiveIsolation', () => {
    const def = defineService({
      name: 'summarize',
      kind: 'ephemeral',
      contract: Summarize,
      isolation: 'gvisor',
    });
    expect(def.effectiveIsolation).toBe('gvisor');
  });

  test('microvm is carried through to effectiveIsolation', () => {
    const def = defineService({
      name: 'session-hub',
      kind: 'persistent',
      contract: Summarize,
      isolation: 'microvm',
    });
    expect(def.effectiveIsolation).toBe('microvm');
  });

  test('the raw declared isolation is still surfaced as-declared (undefined when omitted)', () => {
    const omitted = defineService({ name: 'a', kind: 'ephemeral', contract: Summarize });
    expect(omitted.isolation).toBeUndefined();

    const declared = defineService({
      name: 'b',
      kind: 'persistent',
      contract: Summarize,
      isolation: 'gvisor',
    });
    expect(declared.isolation).toBe('gvisor');
  });

  test('effectiveIsolation is always a concrete tier on the ServiceDef (type level, never undefined)', () => {
    const def = defineService({ name: 'x', kind: 'persistent', contract: Summarize });
    expectTypeOf(def.effectiveIsolation).toEqualTypeOf<IsolationTier>();
  });
});
