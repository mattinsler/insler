import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import * as index from './index.js';
import { type ServiceNeed, toServiceNeeds, validateNeeds } from './needs.js';

// Issue 0005 — Logical dependency declarations (needs).
//
// Scope of THIS layer (the logical dependency declaration model):
//   AC1 — `needs` accepted in `defineService` as `string[]`        (define-service.test.ts + here)
//   AC2 — each need produces a TYPED REFERENCE in the `ServiceDef`  (this file + define-service.test.ts)
//   AC5 — duplicate needs within a service are rejected             (this file + define-service.test.ts)
//
// Downstream (owned by their named issues, gated on #0005 — NOT built here):
//   AC3 — generator emits secret bindings           -> #0015
//   AC4 — generator emits data store claims          -> #0017
//   AC6 — needs visible in the service graph          -> #0010

// --- AC2: the typed reference model ---

describe('ServiceNeed typed reference', () => {
  test('toServiceNeeds maps each logical string to a typed reference', () => {
    const needs = toServiceNeeds(['orders-db', 'valkey']);
    expect(needs).toEqual([{ name: 'orders-db' }, { name: 'valkey' }]);
  });

  test('an empty / undefined declaration yields an empty reference list', () => {
    expect(toServiceNeeds([])).toEqual([]);
    expect(toServiceNeeds(undefined)).toEqual([]);
  });

  test('each produced reference is frozen', () => {
    const needs = toServiceNeeds(['orders-db']);
    expect(Object.isFrozen(needs)).toBe(true);
    expect(Object.isFrozen(needs[0])).toBe(true);
  });

  test('ServiceNeed carries the logical name and nothing physical (type level)', () => {
    expectTypeOf<ServiceNeed>().toEqualTypeOf<{ readonly name: string }>();
  });

  test('toServiceNeeds returns readonly ServiceNeed[] (type level)', () => {
    expectTypeOf(toServiceNeeds(['x'])).toEqualTypeOf<readonly ServiceNeed[]>();
  });

  test('the need reference is purely logical — no secret ARN / connection string fields (US-3)', () => {
    const [need] = toServiceNeeds(['orders-db']);
    expect(Object.keys(need!)).toEqual(['name']);
  });
});

// --- AC5: duplicate needs are rejected ---

describe('validateNeeds — duplicate rejection', () => {
  test('returns no issues for distinct needs', () => {
    expect(validateNeeds(['orders-db', 'valkey'])).toEqual([]);
  });

  test('returns no issues for an empty / undefined declaration', () => {
    expect(validateNeeds([])).toEqual([]);
    expect(validateNeeds(undefined)).toEqual([]);
  });

  test('reports a duplicate need by name', () => {
    const issues = validateNeeds(['valkey', 'orders-db', 'valkey']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('valkey');
    expect(issues[0]).toContain('duplicate');
  });

  test('reports each distinct duplicated name once', () => {
    const issues = validateNeeds(['a', 'a', 'b', 'b', 'b', 'c']);
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('a');
    expect(issues.join('\n')).toContain('b');
    expect(issues.join('\n')).not.toContain('duplicate need: c');
  });

  test('validateNeeds returns string[] mirroring validateServiceKind (type level)', () => {
    expectTypeOf(validateNeeds(['x'])).toEqualTypeOf<string[]>();
  });
});

// --- the need model is re-exported from the package index ---

describe('package index re-exports the needs model', () => {
  test('toServiceNeeds and validateNeeds are exported', () => {
    expect(index.toServiceNeeds).toBe(toServiceNeeds);
    expect(index.validateNeeds).toBe(validateNeeds);
  });
});
