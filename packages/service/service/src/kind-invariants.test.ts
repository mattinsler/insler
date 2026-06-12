import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { SERVICE_KINDS, validateServiceKind } from './kind.js';
import type { KindDeclaration, ServiceKind } from './kind.js';

/**
 * Kind invariant tests (#0029).
 *
 * These are DECLARATION-level invariants — they validate the per-kind
 * operational constraints a service *declaration* must satisfy, via the pure
 * `validateServiceKind` function and the `KindDeclaration` type. They do NOT
 * exercise a deployment/autoscaler generator (none exists yet); per the issue
 * Notes, "the kind invariant tests validate declaration constraints."
 *
 * 0002 (`kind.test.ts`) already covers the taxonomy, per-kind operational
 * profiles, and the individual accept/reject cases. This suite adds the
 * cross-cutting coverage #0029 names that 0002 does not:
 *
 *  - the replica-floor invariant stated *as an invariant* over every kind
 *    (workflow & persistent reject min 0; ephemeral allows min 0),
 *  - the `taskQueue` requirement framed as a kind invariant, and
 *  - AC "all constraints produce clear error messages" — 0002 only asserts
 *    `issues.length > 0`; here we assert the message *content* is actionable
 *    (names the kind, the offending field, and the observed value).
 */

/** The kinds that must hold a replica floor of at least one. */
const ALWAYS_ON_KINDS = ['persistent', 'workflow'] as const;

/** A minimal valid declaration for a kind (workflow needs a taskQueue). */
function declOf(kind: ServiceKind, min?: number): KindDeclaration {
  const scale = min === undefined ? undefined : { min };
  if (kind === 'workflow') {
    return { kind, taskQueue: 'q', ...(scale ? { scale } : {}) };
  }
  return { kind, ...(scale ? { scale } : {}) };
}

// --- AC: workflow and persistent reject min 0 (stated as an invariant) ---

describe('replica-floor invariant: always-on kinds reject min 0 (#0029 AC)', () => {
  for (const kind of ALWAYS_ON_KINDS) {
    test(`${kind} rejects scale.min: 0`, () => {
      const issues = validateServiceKind(declOf(kind, 0));
      expect(issues.length).toBeGreaterThan(0);
    });

    test(`${kind} rejects any sub-floor scale.min (negative too)`, () => {
      // The floor is ">= 1"; anything below it — including a nonsensical
      // negative — must be rejected, not just the literal 0.
      expect(validateServiceKind(declOf(kind, -1)).length).toBeGreaterThan(0);
    });

    test(`${kind} accepts scale.min: 1 and above`, () => {
      expect(validateServiceKind(declOf(kind, 1))).toEqual([]);
      expect(validateServiceKind(declOf(kind, 5))).toEqual([]);
    });
  }

  test('the always-on rule is exactly persistent + workflow (no ephemeral)', () => {
    // Property: for min 0, the kinds that produce a floor issue are precisely
    // the always-on kinds — ephemeral is excluded by construction.
    const rejecting = SERVICE_KINDS.filter((kind) =>
      validateServiceKind(declOf(kind, 0)).some((m) => /replica floor/i.test(m))
    );
    expect([...rejecting].sort()).toEqual(['persistent', 'workflow']);
  });
});

// --- AC: ephemeral allows min 0 ---

describe('ephemeral allows min 0 — true scale-to-zero (#0029 AC)', () => {
  test('ephemeral with scale.min: 0 is valid', () => {
    expect(validateServiceKind(declOf('ephemeral', 0))).toEqual([]);
  });

  test('ephemeral never emits a replica-floor issue at any min', () => {
    for (const min of [0, 1, 9]) {
      const issues = validateServiceKind(declOf('ephemeral', min));
      expect(issues.some((m) => /replica floor/i.test(m))).toBe(false);
    }
  });
});

// --- AC: workflow requires taskQueue ---

describe('workflow requires a taskQueue (#0029 AC)', () => {
  test('a workflow declaration missing taskQueue is rejected (validation level)', () => {
    // Bypass the compile-time guard to reach the runtime validation path the
    // scanner relies on for untyped/raw declarations.
    const issues = validateServiceKind({ kind: 'workflow' } as KindDeclaration);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('a workflow declaration with an empty-string taskQueue is rejected', () => {
    const issues = validateServiceKind({ kind: 'workflow', taskQueue: '' });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('a workflow declaration with a non-empty taskQueue is accepted', () => {
    expect(validateServiceKind({ kind: 'workflow', taskQueue: 'onboarding' })).toEqual([]);
  });

  test('the KindDeclaration type makes taskQueue mandatory for workflow only (type level)', () => {
    expectTypeOf<Extract<KindDeclaration, { kind: 'workflow' }>>()
      .toHaveProperty('taskQueue')
      .toEqualTypeOf<string>();

    // @ts-expect-error workflow declaration must carry a taskQueue
    const missing: KindDeclaration = { kind: 'workflow' };
    void missing;
  });
});

// --- AC: all constraints produce clear error messages ---

describe('every constraint produces a clear, actionable message (#0029 AC)', () => {
  test('a sub-floor message names the kind, the field, and the observed value', () => {
    for (const kind of ALWAYS_ON_KINDS) {
      const [message] = validateServiceKind(declOf(kind, 0));
      expect(message).toBeDefined();
      // names the offending kind
      expect(message).toContain(kind);
      // names the field the author must change
      expect(message).toMatch(/scale\.min/);
      // reports the observed (rejected) value
      expect(message).toMatch(/0/);
      // states the requirement
      expect(message).toMatch(/>=\s*1|floor/i);
    }
  });

  test('the missing-taskQueue message names taskQueue and the workflow kind', () => {
    const [message] = validateServiceKind({ kind: 'workflow' } as KindDeclaration);
    expect(message).toBeDefined();
    expect(message).toContain('taskQueue');
    expect(message).toContain('workflow');
  });

  test('messages are non-empty human-readable strings (never blank)', () => {
    const samples: KindDeclaration[] = [
      declOf('persistent', 0),
      declOf('workflow', 0),
      { kind: 'workflow' } as KindDeclaration,
    ];
    for (const decl of samples) {
      for (const message of validateServiceKind(decl)) {
        expect(message.trim().length).toBeGreaterThan(0);
        expect(message).toMatch(/[a-z]/i);
      }
    }
  });

  test('a workflow that violates BOTH taskQueue and floor reports both clearly', () => {
    // Each constraint contributes its own distinct, self-describing message;
    // they are not collapsed into one opaque error.
    const issues = validateServiceKind({ kind: 'workflow', scale: { min: 0 } } as KindDeclaration);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.some((m) => m.includes('taskQueue'))).toBe(true);
    expect(issues.some((m) => /scale\.min/.test(m))).toBe(true);
  });

  test('a fully valid declaration yields zero messages', () => {
    expect(validateServiceKind({ kind: 'workflow', taskQueue: 'q', scale: { min: 2 } })).toEqual(
      []
    );
  });
});
