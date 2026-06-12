import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { defineService } from './define-service.js';
import { deriveIdentity, type ServiceIdentity } from './identity.js';
import * as index from './index.js';

// Issue 0004 — Service identity model.
//
// Scope of THIS layer (`@insler/service`): the identity TYPE and its
// DERIVATION from a ServiceDef. Identity anchors security/observability and is
// derived from the existing `name` field.
//   AC1 — `ServiceIdentity` type with name, namespace, environment fields  (this file)
//   AC2 — identity derivation function from `ServiceDef`                    (this file)
//
// Cross-fleet (owned here's sibling layer `@insler/platform/fleet`):
//   AC3 — identity uniqueness across all scanned declarations  -> fleet/manifest.test.ts
//
// Downstream consumers (owned by their named issues, gated on #0004 — NOT built here):
//   AC4 — identity feeds NATS credential scoping        -> #0016
//   AC5 — identity feeds secret naming convention        -> #0015
//   AC6 — identity feeds K8s ServiceAccount naming       -> #0012

const Summarize = Contract.create('summarize', {
  version: '1.0.0',
  methods: {
    run: { input: z.object({ text: z.string() }), output: z.object({ out: z.string() }) },
  },
});

function svc(name: string) {
  return defineService({ name, kind: 'ephemeral', contract: Summarize });
}

// --- AC1: the ServiceIdentity type ---

describe('ServiceIdentity type (AC1)', () => {
  test('carries name, namespace, environment, and a hierarchical qualifiedName (type level)', () => {
    expectTypeOf<ServiceIdentity>().toEqualTypeOf<{
      readonly name: string;
      readonly namespace: string;
      readonly environment: string;
      readonly qualifiedName: string;
    }>();
  });
});

// --- AC2: derivation from a ServiceDef ---

describe('deriveIdentity (AC2)', () => {
  test('derives name + namespace from the declared name, scoped by environment', () => {
    const identity = deriveIdentity(svc('orders.summarize'), 'production');
    expect(identity.name).toBe('summarize');
    expect(identity.namespace).toBe('orders');
    expect(identity.environment).toBe('prod');
  });

  test('produces a hierarchical qualifiedName environment.namespace.name (e.g. prod.orders.summarize)', () => {
    const identity = deriveIdentity(svc('orders.summarize'), 'production');
    expect(identity.qualifiedName).toBe('prod.orders.summarize');
  });

  test('maps each ServiceEnv to a stable short environment token', () => {
    expect(deriveIdentity(svc('orders.summarize'), 'production').environment).toBe('prod');
    expect(deriveIdentity(svc('orders.summarize'), 'development').environment).toBe('dev');
    expect(deriveIdentity(svc('orders.summarize'), 'test').environment).toBe('test');
  });

  test('a name with no namespace segment falls back to the default namespace', () => {
    const identity = deriveIdentity(svc('summarize'), 'production');
    expect(identity.name).toBe('summarize');
    expect(identity.namespace).toBe('default');
    expect(identity.qualifiedName).toBe('prod.default.summarize');
  });

  test('a deeply-dotted name keeps only the final segment as name and the rest as namespace', () => {
    const identity = deriveIdentity(svc('team.orders.summarize'), 'production');
    expect(identity.name).toBe('summarize');
    expect(identity.namespace).toBe('team.orders');
    expect(identity.qualifiedName).toBe('prod.team.orders.summarize');
  });

  // Deterministic & stable: same declaration + env -> same identity, always.
  test('is deterministic — same declaration and environment always produce the same identity', () => {
    const def = svc('orders.summarize');
    expect(deriveIdentity(def, 'production')).toEqual(deriveIdentity(def, 'production'));
  });

  test('environment is part of identity — the same service in two environments has distinct identities', () => {
    const def = svc('orders.summarize');
    expect(deriveIdentity(def, 'production').qualifiedName).not.toBe(
      deriveIdentity(def, 'development').qualifiedName
    );
  });

  test('renaming the service changes its identity (rename is an explicit migration)', () => {
    expect(deriveIdentity(svc('orders.summarize'), 'production').qualifiedName).not.toBe(
      deriveIdentity(svc('orders.summarise'), 'production').qualifiedName
    );
  });

  test('the derived identity is frozen', () => {
    const identity = deriveIdentity(svc('orders.summarize'), 'production');
    expect(Object.isFrozen(identity)).toBe(true);
  });

  test('returns a ServiceIdentity (type level)', () => {
    expectTypeOf(deriveIdentity(svc('x'), 'production')).toEqualTypeOf<ServiceIdentity>();
  });
});

// --- the identity model is re-exported from the package index ---

describe('package index re-exports the identity model', () => {
  test('deriveIdentity is exported', () => {
    expect(index.deriveIdentity).toBe(deriveIdentity);
  });
});
