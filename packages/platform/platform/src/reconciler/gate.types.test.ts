import { describe, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { applyGated } from './gate.js';
import type {
  AuditRecord,
  AuditSink,
  BlastRadius,
  GatedApplyOptions,
  GatedApplyResult,
} from './types.js';

/**
 * Type-level guarantees for the 0023 gate/audit contracts. Runtime tests prove
 * behavior; these prove the shapes a caller (the CLI, a real audit backend)
 * must conform to.
 */

describe('gate/audit type contracts (0023)', () => {
  test('AuditRecord carries the SOC 2 trail fields (AC4)', () => {
    expectTypeOf<AuditRecord['outcome']>().toEqualTypeOf<'applied' | 'rejected'>();
    expectTypeOf<AuditRecord['operator']>().toEqualTypeOf<string>();
    expectTypeOf<AuditRecord['timestamp']>().toEqualTypeOf<string>();
    expectTypeOf<AuditRecord['blastRadius']>().toEqualTypeOf<BlastRadius>();
    // reason is present only for rejections
    expectTypeOf<AuditRecord['reason']>().toEqualTypeOf<string | undefined>();
  });

  test('AuditSink is a single async record method', () => {
    expectTypeOf<AuditSink['record']>().parameter(0).toEqualTypeOf<AuditRecord>();
    expectTypeOf<AuditSink['record']>().returns.toEqualTypeOf<Promise<void>>();
  });

  test('BlastRadius exposes services affected and the resource-change count (AC3)', () => {
    expectTypeOf<BlastRadius['servicesAffected']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<BlastRadius['resourcesChanged']>().toEqualTypeOf<number>();
  });

  test('applyGated requires an operator identity and an audit sink', () => {
    expectTypeOf<GatedApplyOptions['operator']>().toEqualTypeOf<string>();
    expectTypeOf<GatedApplyOptions['audit']>().toEqualTypeOf<AuditSink>();
    expectTypeOf(applyGated).returns.resolves.toEqualTypeOf<GatedApplyResult>();
  });

  test('a gated result discriminates applied vs rejected', () => {
    expectTypeOf<GatedApplyResult['outcome']>().toEqualTypeOf<'applied' | 'rejected'>();
  });
});
