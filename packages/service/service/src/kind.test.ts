import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import * as index from './index.js';
import { SERVICE_KINDS, serviceKindProfiles, validateServiceKind } from './kind.js';
import type { KindDeclaration, OperationalProfile, ScalingSignal, ServiceKind } from './kind.js';

// --- AC1: `ServiceKind` type: 'ephemeral' | 'persistent' | 'workflow' ---

describe('ServiceKind taxonomy', () => {
  test('ServiceKind is exactly the three lifecycle kinds (type level)', () => {
    expectTypeOf<ServiceKind>().toEqualTypeOf<'ephemeral' | 'persistent' | 'workflow'>();
  });

  test('SERVICE_KINDS enumerates the three kinds at runtime', () => {
    expect([...SERVICE_KINDS].sort()).toEqual(['ephemeral', 'persistent', 'workflow']);
  });

  test('SERVICE_KINDS element type is ServiceKind (type level)', () => {
    expectTypeOf<(typeof SERVICE_KINDS)[number]>().toEqualTypeOf<ServiceKind>();
  });

  test('the taxonomy is re-exported from the package index', () => {
    expect(index.SERVICE_KINDS).toBe(SERVICE_KINDS);
    expect(index.serviceKindProfiles).toBe(serviceKindProfiles);
    expect(index.validateServiceKind).toBe(validateServiceKind);
  });
});

// --- AC2: Default operational profile per kind ---
// (min replicas, scaling signal, scale-to-zero)

describe('default operational profile per kind', () => {
  test('ephemeral: min 0, scales to zero, scales on queue depth', () => {
    expect(serviceKindProfiles.ephemeral).toEqual({
      minReplicas: 0,
      scaleToZero: true,
      scalingSignal: 'queue-depth',
    });
  });

  test('persistent: min 1, never scales to zero, scales on cpu', () => {
    expect(serviceKindProfiles.persistent).toEqual({
      minReplicas: 1,
      scaleToZero: false,
      scalingSignal: 'cpu',
    });
  });

  test('workflow: min 1, never scales to zero, scales on task-queue backlog', () => {
    expect(serviceKindProfiles.workflow).toEqual({
      minReplicas: 1,
      scaleToZero: false,
      scalingSignal: 'task-queue-backlog',
    });
  });

  test('workflow inherits persistent operational profile (min>=1, no scale-to-zero)', () => {
    // Key rule: workflow inherits persistent's operational profile.
    expect(serviceKindProfiles.workflow.minReplicas).toBe(
      serviceKindProfiles.persistent.minReplicas
    );
    expect(serviceKindProfiles.workflow.scaleToZero).toBe(
      serviceKindProfiles.persistent.scaleToZero
    );
  });

  test('every kind has a profile (type level)', () => {
    expectTypeOf<typeof serviceKindProfiles>().toEqualTypeOf<
      Record<ServiceKind, OperationalProfile>
    >();
  });

  test('OperationalProfile shape (type level)', () => {
    expectTypeOf<OperationalProfile>().toEqualTypeOf<{
      readonly minReplicas: number;
      readonly scaleToZero: boolean;
      readonly scalingSignal: ScalingSignal;
    }>();
  });

  test('only ephemeral is allowed to scale to zero', () => {
    for (const kind of SERVICE_KINDS) {
      const profile = serviceKindProfiles[kind];
      if (kind === 'ephemeral') {
        expect(profile.scaleToZero).toBe(true);
        expect(profile.minReplicas).toBe(0);
      } else {
        expect(profile.scaleToZero).toBe(false);
        expect(profile.minReplicas).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// --- AC3: `workflow` requires `taskQueue` field in the declaration (type level) ---

describe('workflow requires taskQueue (type level)', () => {
  test('a workflow declaration requires a taskQueue string', () => {
    const ok: KindDeclaration = { kind: 'workflow', taskQueue: 'onboarding' };
    expect(ok.kind).toBe('workflow');

    // @ts-expect-error workflow declaration must include taskQueue
    const missing: KindDeclaration = { kind: 'workflow' };
    void missing;
  });

  test('ephemeral and persistent declarations do not carry a taskQueue', () => {
    const ephemeral: KindDeclaration = { kind: 'ephemeral' };
    const persistent: KindDeclaration = { kind: 'persistent' };
    expect(ephemeral.kind).toBe('ephemeral');
    expect(persistent.kind).toBe('persistent');

    // @ts-expect-error taskQueue is only valid on workflow declarations
    const bad: KindDeclaration = { kind: 'ephemeral', taskQueue: 'nope' };
    void bad;
  });

  test('narrowing on kind exposes taskQueue only for workflow (type level)', () => {
    const decl = { kind: 'workflow', taskQueue: 'q' } as KindDeclaration;
    if (decl.kind === 'workflow') {
      expectTypeOf(decl.taskQueue).toEqualTypeOf<string>();
    }
  });
});

// --- AC4: workflow enforces min replicas >= 1 (validation level) ---

describe('workflow enforces min replicas >= 1', () => {
  test('workflow with scale.min 0 is rejected', () => {
    const issues = validateServiceKind({ kind: 'workflow', taskQueue: 'q', scale: { min: 0 } });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('workflow with scale.min >= 1 is accepted', () => {
    expect(validateServiceKind({ kind: 'workflow', taskQueue: 'q', scale: { min: 1 } })).toEqual(
      []
    );
    expect(validateServiceKind({ kind: 'workflow', taskQueue: 'q', scale: { min: 3 } })).toEqual(
      []
    );
  });

  test('workflow without an explicit scale.min is accepted (defaults to >= 1)', () => {
    expect(validateServiceKind({ kind: 'workflow', taskQueue: 'q' })).toEqual([]);
  });

  test('workflow missing taskQueue is rejected at the validation level too', () => {
    const issues = validateServiceKind({ kind: 'workflow', scale: { min: 1 } } as KindDeclaration);
    expect(issues.length).toBeGreaterThan(0);
  });
});

// --- AC5: ephemeral with scale.min > 0 allowed (warm pool);
//          persistent with scale.min < 1 rejected ---

describe('scale.min validation per kind', () => {
  test('ephemeral with scale.min 0 is allowed (true scale-to-zero)', () => {
    expect(validateServiceKind({ kind: 'ephemeral', scale: { min: 0 } })).toEqual([]);
  });

  test('ephemeral with scale.min > 0 is allowed (warm pool)', () => {
    expect(validateServiceKind({ kind: 'ephemeral', scale: { min: 2 } })).toEqual([]);
  });

  test('persistent with scale.min 0 is rejected', () => {
    const issues = validateServiceKind({ kind: 'persistent', scale: { min: 0 } });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('persistent with scale.min >= 1 is accepted', () => {
    expect(validateServiceKind({ kind: 'persistent', scale: { min: 1 } })).toEqual([]);
  });

  test('persistent without an explicit scale.min is accepted (defaults to >= 1)', () => {
    expect(validateServiceKind({ kind: 'persistent' })).toEqual([]);
  });

  test('a valid declaration yields no issues; validateServiceKind returns string[]', () => {
    const issues = validateServiceKind({ kind: 'ephemeral' });
    expect(issues).toEqual([]);
    expectTypeOf(issues).toEqualTypeOf<string[]>();
  });
});

// --- ScalingSignal contract ---

describe('ScalingSignal', () => {
  test('scaling signals cover the per-kind defaults (type level)', () => {
    expectTypeOf<ScalingSignal>().toEqualTypeOf<'queue-depth' | 'cpu' | 'task-queue-backlog'>();
  });
});
